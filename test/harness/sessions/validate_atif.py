"""Validate ATIF trajectory files with two independent implementations.

  python3 -I test/harness/sessions/validate_atif.py --harbor-src DIR FILE...

1. Harbor's own Pydantic models and TrajectoryValidator (RFC 0001), loaded from
   a checkout of github.com/harbor-framework/harbor (DIR = its src/ folder).
   Only harbor/models/trajectories and harbor/utils/trajectory_validator are
   imported; the package's __init__ (which needs an installed distribution) is
   skipped.
2. The `atif` package from PyPI (Pydantic models for ATIF v1.8), if installed.

Prints one line per file and exits non-zero if any file fails either check.
"""
import argparse
import importlib.util
import json
import sys
import types


def load_harbor(src: str):
    pkg = types.ModuleType("harbor")
    pkg.__path__ = [f"{src}/harbor"]
    sys.modules["harbor"] = pkg
    for name in ("harbor.models", "harbor.utils"):
        sub = types.ModuleType(name)
        sub.__path__ = [f"{src}/{name.replace('.', '/')}"]
        sys.modules[name] = sub
    from harbor.utils.trajectory_validator import TrajectoryValidator  # noqa: E402

    return TrajectoryValidator


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--harbor-src", required=True)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    TrajectoryValidator = load_harbor(a.harbor_src)
    atif = None
    if importlib.util.find_spec("atif"):
        import atif  # type: ignore
    bad = 0
    for f in a.files:
        v = TrajectoryValidator()
        ok_h = v.validate(f)
        errs = [] if ok_h else v.get_errors()
        ok_a = None
        if atif is not None:
            try:
                model = getattr(atif, "Trajectory")
                model.model_validate(json.load(open(f)))
                ok_a = True
            except Exception as e:  # noqa: BLE001
                ok_a = False
                errs.append(f"atif: {str(e)[:300]}")
        ok = ok_h and ok_a is not False
        bad += not ok
        print(f"{'ok  ' if ok else 'FAIL'} harbor={ok_h} atif={ok_a} {f}")
        for e in errs[:10]:
            print(f"     {e}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
