#!/usr/bin/env python3
"""The soak workload, run inside the sandbox against /drive (see soak.sh).

usage: soak.py <seconds> <work dir>

Workers run concurrently until the time is up, each checking its own invariants on every
round, and write counts to <work>/progress.json every 10 s:
  git      in repos/sympy: branch, edit, commit, status must be clean, log, switch back,
           delete the branch; `git fsck` every 10th round
  pytests  part of mpmath's own test suite, one process per module, bytecode written to the
           drive; every module must pass
  small    500 files of random content: write, read back and compare, rename half into a
           subdirectory, compare the listing, delete all
  renames  a small tree: directory renames back and forth, editor-style save (temp file,
           fsync, rename over), content compared after each step
  toggles  the host hides and shows toggle/* (store items and a directory) by epoch bumps and
           publishes what should be visible in <work>/toggle-state.json; while that state is
           stable, the listing, each stat and each read must agree with it exactly
Failures are appended to <work>/failures.log and counted; the run goes on.
"""
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import threading
import time
import traceback

secs = float(sys.argv[1])
work = sys.argv[2]
drive = "/drive"
deadline = time.time() + secs
lock = threading.Lock()
counts = {}
fail_log = open(f"{work}/failures.log", "a")
env = dict(os.environ, GIT_AUTHOR_NAME="a8", GIT_AUTHOR_EMAIL="a8@example.invalid",
           GIT_COMMITTER_NAME="a8", GIT_COMMITTER_EMAIL="a8@example.invalid")


def bump(worker, key, n=1):
    with lock:
        counts.setdefault(worker, {}).setdefault(key, 0)
        counts[worker][key] += n


def fail(worker, msg):
    bump(worker, "failures")
    with lock:
        fail_log.write(f"{time.strftime('%H:%M:%S')} {worker}: {msg}\n")
        fail_log.flush()


def run(args, cwd=None, extra=None, timeout=600):
    r = subprocess.run(args, cwd=cwd, env=dict(env, **(extra or {})), capture_output=True, text=True,
                       timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"{args}: exit {r.returncode}: {r.stderr[-600:]}")
    return r.stdout


def loop(name, body):
    def go():
        i = 0
        while time.time() < deadline:
            try:
                body(i)
                bump(name, "rounds")
            except Exception as e:
                fail(name, f"round {i}: {e!r}\n{traceback.format_exc()[-1500:]}")
                time.sleep(1)
            i += 1
    t = threading.Thread(target=go, name=name, daemon=True)
    t.start()
    return t


# ---- git -----------------------------------------------------------------------------------
repo = f"{drive}/repos/sympy"
base_branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo).strip()


def git_round(i):
    b = f"a8-soak-{i}"
    run(["git", "checkout", "-q", "-b", b], cwd=repo)
    files = ["README.md", "sympy/core/basic.py", "sympy/__init__.py", "doc/README.rst"]
    for f in files:
        p = f"{repo}/{f}"
        if os.path.exists(p):
            with open(p, "a") as fh:
                fh.write(f"\n# soak round {i}\n")
    with open(f"{repo}/a8-new-{i}.txt", "w") as fh:
        fh.write(f"new file {i}\n")
    run(["git", "add", "-A", "."], cwd=repo)
    run(["git", "commit", "-q", "-m", f"soak round {i}"], cwd=repo)
    st = run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo)
    if st.strip():
        raise RuntimeError(f"status not clean after commit: {st[:300]}")
    msg = run(["git", "log", "-1", "--format=%s"], cwd=repo).strip()
    if msg != f"soak round {i}":
        raise RuntimeError(f"log shows {msg!r}")
    run(["git", "checkout", "-q", base_branch], cwd=repo)
    if os.path.exists(f"{repo}/a8-new-{i}.txt"):
        raise RuntimeError("file from the branch still there after checkout")
    run(["git", "branch", "-q", "-D", b], cwd=repo)
    st = run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=repo)
    if st.strip():
        raise RuntimeError(f"status not clean on {base_branch}: {st[:300]}")
    if i % 10 == 0:
        run(["git", "fsck", "--no-progress", "--no-dangling"], cwd=repo)
        bump("git", "fsck")


# ---- python tests --------------------------------------------------------------------------
mods = ["test_bitwise", "test_compatibility", "test_division", "test_hp", "test_identify",
        "test_mpmath", "test_power", "test_special", "test_summation", "test_trig"]
here = os.path.dirname(os.path.abspath(__file__))


def py_round(i):
    for m in mods:
        out = run([sys.executable, f"{here}/miniruntests.py", f"{drive}/repos/mpmath/mpmath/tests", m],
                  extra={"PYTHONPATH": f"{drive}/repos/mpmath"}, cwd="/tmp")
        if " failed 0" not in out:
            raise RuntimeError(f"{m}: {out.strip()}")
        bump("pytests", "modules")


# ---- small files ---------------------------------------------------------------------------
def small_round(i):
    d = f"{drive}/soak/small-{i % 3}"
    if os.path.exists(d):
        shutil.rmtree(d)
    os.makedirs(d)
    want = {}
    for k in range(500):
        data = os.urandom(random.randint(0, 3000))
        with open(f"{d}/f{k:03d}", "wb") as fh:
            fh.write(data)
        want[f"f{k:03d}"] = hashlib.sha256(data).hexdigest()
    for name, h in want.items():
        with open(f"{d}/{name}", "rb") as fh:
            if hashlib.sha256(fh.read()).hexdigest() != h:
                raise RuntimeError(f"{d}/{name}: content differs")
    os.mkdir(f"{d}/sub")
    for k in range(0, 500, 2):
        os.rename(f"{d}/f{k:03d}", f"{d}/sub/f{k:03d}")
    top = sorted(os.listdir(d))
    sub = sorted(os.listdir(f"{d}/sub"))
    if top != sorted([f"f{k:03d}" for k in range(1, 500, 2)] + ["sub"]) or sub != [f"f{k:03d}" for k in range(0, 500, 2)]:
        raise RuntimeError(f"listing after renames: {len(top)} top, {len(sub)} sub")
    for k in range(0, 500, 2):
        with open(f"{d}/sub/f{k:03d}", "rb") as fh:
            if hashlib.sha256(fh.read()).hexdigest() != want[f"f{k:03d}"]:
                raise RuntimeError("content differs after rename")
    shutil.rmtree(d)
    if os.path.exists(d):
        raise RuntimeError("still there after rmtree")
    bump("small", "files", 500)


# ---- renames -------------------------------------------------------------------------------
def rename_round(i):
    root = f"{drive}/soak/renames"
    a, b = f"{root}/a", f"{root}/b"
    if not os.path.exists(a) and not os.path.exists(b):
        os.makedirs(f"{a}/x/y")
        for k in range(20):
            with open(f"{a}/x/y/doc{k}.txt", "w") as fh:
                fh.write(f"doc {k} v0\n")
    src, dst = (a, b) if os.path.exists(a) else (b, a)
    os.rename(src, dst)
    if os.path.exists(src) or not os.path.isdir(f"{dst}/x/y"):
        raise RuntimeError("directory rename not visible")
    # Editor-style save of one document.
    k = i % 20
    target = f"{dst}/x/y/doc{k}.txt"
    tmp = f"{dst}/x/y/.doc{k}.txt.swp"
    with open(tmp, "w") as fh:
        fh.write(f"doc {k} v{i}\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.rename(tmp, target)
    with open(target) as fh:
        if fh.read() != f"doc {k} v{i}\n":
            raise RuntimeError("content after rename-over")
    names = sorted(os.listdir(f"{dst}/x/y"))
    if names != sorted(f"doc{j}.txt" for j in range(20)):
        raise RuntimeError(f"listing {names[:5]}... ({len(names)})")
    # A store directory renamed away and back (copy-up of a tree, whiteouts).
    if i % 5 == 0:
        s1, s2 = f"{drive}/repos/mpmath/doc", f"{drive}/repos/mpmath/doc-moved"
        if os.path.exists(s1):
            n = sum(len(fs) for _, _, fs in os.walk(s1))
            os.rename(s1, s2)
            os.rename(s2, s1)
            if sum(len(fs) for _, _, fs in os.walk(s1)) != n or os.path.exists(s2):
                raise RuntimeError("store directory changed by a rename and back")


# ---- toggles -------------------------------------------------------------------------------
def read_state():
    try:
        with open(f"{work}/toggle-state.json") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def toggle_round(i):
    s1 = read_state()
    if not s1 or s1.get("changing"):
        time.sleep(0.05)
        return
    seen_top, seen_dir, content_ok = None, None, True
    try:
        seen_top = sorted(os.listdir(f"{drive}/toggle"))
    except FileNotFoundError:
        seen_top = []
    try:
        seen_dir = sorted(os.listdir(f"{drive}/toggle/dir"))
    except FileNotFoundError:
        seen_dir = None
    stats = {}
    for name in [f"t{k:02d}.txt" for k in range(s1["n"])]:
        try:
            with open(f"{drive}/toggle/{name}") as fh:
                stats[name] = fh.read()
        except FileNotFoundError:
            stats[name] = None
        except PermissionError:
            # Hidden between open and read: an open handle on a hidden item errors. Only
            # possible across a change, which the second state read below detects.
            stats[name] = "EACCES"
    s2 = read_state()
    if not s2 or s2["seq"] != s1["seq"]:
        bump("toggles", "skipped")
        return
    want_top = sorted(s1["visible"] + (["dir"] if s1["dir_visible"] else []))
    if seen_top != want_top:
        raise RuntimeError(f"seq {s1['seq']} epoch {s1['epoch']}: listing {seen_top} != {want_top}")
    if s1["dir_visible"] != (seen_dir is not None):
        raise RuntimeError(f"seq {s1['seq']}: toggle/dir visible={seen_dir is not None}, want {s1['dir_visible']}")
    for name, content in stats.items():
        want = f"toggle item {name}\n" if name in s1["visible"] else None
        if content != want:
            raise RuntimeError(f"seq {s1['seq']}: {name} read {content!r}, want {want!r}")
    bump("toggles", "checked")


def writer():
    while time.time() < deadline + 5:
        with lock:
            snap = json.loads(json.dumps(counts))
        snap["time"] = time.time()
        with open(f"{work}/progress.json.tmp", "w") as fh:
            json.dump(snap, fh)
        os.replace(f"{work}/progress.json.tmp", f"{work}/progress.json")
        time.sleep(10)


ts = [loop("git", git_round), loop("pytests", py_round), loop("small", small_round),
      loop("renames", rename_round), loop("toggles", toggle_round)]
w = threading.Thread(target=writer, daemon=True)
w.start()
for t in ts:
    t.join()
with lock:
    snap = dict(counts, time=time.time(), done=True)
with open(f"{work}/progress.json", "w") as fh:
    json.dump(snap, fh)
print(json.dumps(counts, indent=1))
