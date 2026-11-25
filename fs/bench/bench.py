#!/usr/bin/env python3
"""Benchmarks run inside the sandbox (or on the host) against one or more roots that hold the
same files. Runs are interleaved across roots so machine noise falls on all of them alike.

usage: bench.py <runs> <out.json> <label>=<root> [...]

Each root has repos/sympy (a Git checkout, .git included) and repos/mpmath.
Benchmarks (wall time, one warm-up run first, which is not counted):
  git_status   git status --porcelain in repos/sympy
  rg           rg -c 'def ' over repos/sympy
  find         find repos/sympy -type f (a metadata walk)
  py_import    python3 -c 'import sympy' with the checkout on PYTHONPATH (bytecode cached by
               the warm-up)
  small_files  create and write 1000 files of 1 KiB in a new directory, in-process
"""
import json
import os
import shutil
import statistics
import subprocess
import sys
import time

runs = int(sys.argv[1])
out = sys.argv[2]
roots = dict(a.split("=", 1) for a in sys.argv[3:])
env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")


def sh(args, cwd=None, extra_env=None):
    e = dict(env, **(extra_env or {}))
    t = time.perf_counter()
    r = subprocess.run(args, cwd=cwd, env=e, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    dt = time.perf_counter() - t
    if r.returncode not in (0, 1):
        raise RuntimeError(f"{args} in {cwd}: {r.returncode} {r.stderr[:400]!r}")
    return dt


def git_status(root):
    return sh(["git", "-c", "core.fileMode=false", "status", "--porcelain"], cwd=f"{root}/repos/sympy")


def rg(root):
    return sh(["rg", "-c", "def ", f"{root}/repos/sympy"])


def find(root):
    return sh(["find", f"{root}/repos/sympy", "-type", "f"])


def py_import(root):
    pp = f"{root}/repos/sympy:{root}/repos/mpmath"
    return sh([sys.executable, "-c", "import sympy"], cwd="/tmp", extra_env={"PYTHONPATH": pp})


counter = [0]


def small_files(root):
    counter[0] += 1
    d = f"{root}/a2-small-{os.getpid()}-{counter[0]}"
    payload = b"x" * 1024
    t = time.perf_counter()
    os.mkdir(d)
    for i in range(1000):
        with open(f"{d}/f{i:04d}.txt", "wb") as f:
            f.write(payload)
    dt = time.perf_counter() - t
    shutil.rmtree(d)
    return dt


benches = [git_status, rg, find, py_import, small_files]
results = {}
for b in benches:
    for label, root in roots.items():
        b(root)  # warm-up
    times = {label: [] for label in roots}
    for _ in range(runs):
        for label, root in roots.items():
            times[label].append(b(root))
    results[b.__name__] = {
        label: {"median": statistics.median(ts), "min": min(ts), "max": max(ts), "runs": ts}
        for label, ts in times.items()
    }
    print(b.__name__, {k: round(v["median"] * 1000, 1) for k, v in results[b.__name__].items()}, flush=True)
with open(out, "w") as f:
    json.dump(results, f, indent=1)
