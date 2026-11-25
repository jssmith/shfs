#!/usr/bin/env python3
"""The host side of the soak (see soak.sh): epoch bumps that hide and show items, and samples.

usage: soak_host.py <data dir> <dir_id> <work dir> <seconds> <daemon pid>

toggler  every 0.5 to 2 s picks which of toggle/t*.txt and whether toggle/dir are visible,
         rewrites their session_view rows, bumps the epoch, and (80% of the time) asks the
         daemon to apply it over the control socket; otherwise it waits 300 ms for the
         daemon's own poll. Only then does it publish the new state in toggle-state.json; it
         marks the state "changing" before touching the store, so the sandbox's checker never
         compares a listing against a state it may not reflect.
sampler  every 30 s: the daemon's RSS and peak RSS, open fds, threads, its table sizes (the
         control socket's `stats`), whiteouts, upper/ size, activity rows, and the workers'
         progress; one JSON line each in samples.jsonl.
"""
import json
import os
import random
import socket
import sqlite3
import subprocess
import sys
import threading
import time

data, dir_id, work, secs, pid = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), int(sys.argv[5])
deadline = time.time() + secs
sess = f"{data}/sessions/{dir_id}"
N = 20


def control(cmd):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(5)
    s.connect(f"{sess}/control.sock")
    s.sendall(cmd.encode() + b"\n")
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    s.close()
    line = buf.decode().strip()
    if not line.startswith("ok "):
        raise RuntimeError(f"control {cmd}: {line}")
    return line[3:]


def publish(state):
    tmp = f"{work}/toggle-state.json.tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, f"{work}/toggle-state.json")


def toggler():
    db = sqlite3.connect(f"{data}/drive.db", timeout=10)
    db.execute("PRAGMA busy_timeout = 10000")
    items = {p: (i, v) for p, i, v in db.execute(
        "SELECT path, item_id, version FROM session_view WHERE dir_id = ? AND path LIKE 'toggle/%'", (dir_id,))}
    seq, bumps, announced = 0, 0, 0
    while time.time() < deadline:
        seq += 1
        publish({"seq": seq, "changing": True})
        visible = sorted(f"t{k:02d}.txt" for k in range(N) if random.random() < 0.5)
        dir_visible = random.random() < 0.5
        with db:
            db.execute("DELETE FROM session_view WHERE dir_id = ? AND path LIKE 'toggle/%'", (dir_id,))
            for p, (item, ver) in items.items():
                name = p[len("toggle/"):]
                if name in visible or (dir_visible and name.startswith("dir/")):
                    db.execute("INSERT INTO session_view (dir_id, path, kind, item_id, version) VALUES (?, ?, 'file', ?, ?)",
                               (dir_id, p, item, ver))
            db.execute("UPDATE session_view_epoch SET epoch = epoch + 1 WHERE dir_id = ?", (dir_id,))
        epoch = db.execute("SELECT epoch FROM session_view_epoch WHERE dir_id = ?", (dir_id,)).fetchone()[0]
        bumps += 1
        if random.random() < 0.8:
            applied = int(control("refresh"))
            if applied < epoch:
                raise RuntimeError(f"daemon applied {applied}, epoch is {epoch}")
            announced += 1
        else:
            time.sleep(0.3)
        seq += 1
        publish({"seq": seq, "epoch": epoch, "n": N, "visible": visible, "dir_visible": dir_visible})
        with open(f"{work}/toggler.json", "w") as f:
            json.dump({"bumps": bumps, "announced": announced, "epoch": epoch}, f)
        time.sleep(random.uniform(0.5, 2.0))


def proc(field):
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith(field + ":"):
                return int(line.split()[1])
    return None


def sampler():
    db = sqlite3.connect(f"file:{data}/drive.db?mode=ro", uri=True, timeout=10)
    t0 = time.time()
    with open(f"{work}/samples.jsonl", "a") as out:
        while time.time() < deadline + 30:
            try:
                st = json.loads(control("stats"))
            except Exception as e:
                st = {"error": repr(e)}
            try:
                progress = json.load(open(f"{work}/progress.json"))
            except Exception:
                progress = {}
            try:
                toggles = json.load(open(f"{work}/toggler.json"))
            except Exception:
                toggles = {}
            with open(f"{sess}/whiteouts") as f:
                wo = sum(1 for _ in f)
            du = subprocess.run(["du", "-sk", f"{sess}/upper"], capture_output=True, text=True).stdout.split()[0]
            row = {
                "t": round(time.time() - t0),
                "rss_kb": proc("VmRSS"), "hwm_kb": proc("VmHWM"), "threads": proc("Threads"),
                "fds": len(os.listdir(f"/proc/{pid}/fd")),
                "stats": st, "whiteout_lines": wo, "upper_kb": int(du),
                "activity_rows": db.execute("SELECT count(*) FROM activity WHERE dir_id = ?", (dir_id,)).fetchone()[0],
                "toggler": toggles,
                "progress": {k: v for k, v in progress.items() if isinstance(v, dict)},
            }
            out.write(json.dumps(row) + "\n")
            out.flush()
            time.sleep(30)


def guarded(fn):
    def body():
        try:
            fn()
        except Exception as e:
            with open(f"{work}/failures.log", "a") as f:
                f.write(f"{time.strftime('%H:%M:%S')} host {fn.__name__}: {e!r}\n")
    return body


threads = [threading.Thread(target=guarded(toggler), daemon=True), threading.Thread(target=guarded(sampler), daemon=True)]
for t in threads:
    t.start()
for t in threads:
    t.join()
