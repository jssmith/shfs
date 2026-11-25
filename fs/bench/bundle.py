#!/usr/bin/env python3
"""Writes an OCI bundle config.json for a gVisor sandbox.

usage: bundle.py <bundle dir> <rootfs> [<dest>=<host dir> ...]

The sandbox runs `sleep infinity` as root with a read-only root file system, a tmpfs /tmp
and the given bind mounts (read-write). Commands are run in it with `runsc exec`.
"""
import json
import sys

bundle, rootfs, *binds = sys.argv[1:]
mounts = [
    {"destination": "/proc", "type": "proc", "source": "proc"},
    {"destination": "/dev", "type": "tmpfs", "source": "tmpfs"},
    {"destination": "/sys", "type": "sysfs", "source": "sysfs",
     "options": ["nosuid", "noexec", "nodev", "ro"]},
    {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev"]},
]
for b in binds:
    dest, src = b.split("=", 1)
    mounts.append({"destination": dest, "type": "bind", "source": src, "options": ["rbind", "rw"]})
caps = ["CAP_AUDIT_WRITE", "CAP_KILL", "CAP_NET_BIND_SERVICE", "CAP_DAC_OVERRIDE",
        "CAP_FOWNER", "CAP_CHOWN"]
config = {
    "ociVersion": "1.0.0",
    "process": {
        "user": {"uid": 0, "gid": 0},
        "args": ["sleep", "infinity"],
        "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "TERM=xterm", "HOME=/tmp"],
        "cwd": "/",
        "capabilities": {k: caps for k in ["bounding", "effective", "inheritable", "permitted"]},
        "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 4096, "soft": 4096}],
        "terminal": False,
    },
    "root": {"path": rootfs, "readonly": True},
    "hostname": "a2-sandbox",
    "mounts": mounts,
    "linux": {"namespaces": [{"type": t} for t in ["pid", "network", "ipc", "uts", "mount"]]},
}
with open(f"{bundle}/config.json", "w") as f:
    json.dump(config, f, indent=1)
