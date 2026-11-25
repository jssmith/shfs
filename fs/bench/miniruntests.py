#!/usr/bin/env python3
"""Runs pytest-style test modules (plain `test_*` functions with asserts) without pytest.

usage: miniruntests.py <tests dir> <module> [...]   prints "passed N failed M" and exits 1
on any failure. Used by soak.py to run part of mpmath's own test suite from the drive.
"""
import importlib.util
import inspect
import os
import sys
import traceback

d = sys.argv[1]
passed = failed = 0
for name in sys.argv[2:]:
    spec = importlib.util.spec_from_file_location(name, os.path.join(d, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for fname, f in sorted(vars(mod).items()):
        if fname.startswith("test") and inspect.isfunction(f) and not inspect.signature(f).parameters:
            try:
                f()
                passed += 1
            except Exception:
                failed += 1
                print(f"FAIL {name}.{fname}", file=sys.stderr)
                traceback.print_exc()
print(f"passed {passed} failed {failed}")
sys.exit(1 if failed else 0)
