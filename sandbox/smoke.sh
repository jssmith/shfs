#!/usr/bin/env bash
# Start the built rootfs under gVisor the way a session will run, check the
# tools inside, and time the cold start. Needs root and runsc.
#
#   AGENT_DRIVE_DATA=/tmp/a3-data NAME_PREFIX=a3- sandbox/smoke.sh
#
# Prints one JSON line of timings at the end. Cleans up what it starts.
set -euo pipefail

: "${AGENT_DRIVE_DATA:?set AGENT_DRIVE_DATA}"
prefix="${NAME_PREFIX:-agent-drive-}"
image="$AGENT_DRIVE_DATA/images/${IMAGE_NAME:-default}"
rootfs="$image/rootfs"
runsc="${RUNSC:-runsc}"
platform="${RUNSC_PLATFORM:-systrap}"
id="${prefix}smoke-$$"
work="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}smoke.XXXXXX")"
state="$work/state"          # runsc --root: keeps our sandboxes apart from others'
bundle="$work/bundle"
mkdir -p "$state" "$bundle" "$work/drive" "$work/work"
chown 1000:1000 "$work/work"
echo "synthetic file for the smoke test" > "$work/drive/hello.txt"

rs() { "$runsc" --root "$state" --platform "$platform" --network none "$@"; }
cleanup() {
  rs kill "$id" KILL >/dev/null 2>&1 || true
  sleep 0.2
  rs delete -force "$id" >/dev/null 2>&1 || true
  # runsc --network none leaves a namespace bind mount in its state directory.
  umount "$state/null-netns" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

[ -d "$rootfs" ] || { echo "no rootfs at $rootfs; run sandbox/build.sh" >&2; exit 1; }
envjson=$(jq -c '.env' "$image/image.json")

# A config shaped like a session's: read-only root, /drive and /work bind-mounted,
# no network, unprivileged user, no capabilities.
jq -n --arg root "$rootfs" --arg drive "$work/drive" --arg w "$work/work" --argjson env "$envjson" '{
  ociVersion: "1.0.2",
  process: {
    user: { uid: 1000, gid: 1000 }, cwd: "/work", env: $env,
    args: ["/bin/sleep", "infinity"],
    capabilities: { bounding: [], effective: [], permitted: [] },
    noNewPrivileges: true
  },
  root: { path: $root, readonly: true },
  hostname: "sandbox",
  mounts: [
    { destination: "/proc", type: "proc", source: "proc" },
    { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["nosuid","strictatime","mode=755","size=65536k"] },
    { destination: "/tmp", type: "tmpfs", source: "tmpfs", options: ["nosuid","nodev","mode=1777"] },
    { destination: "/home/agent", type: "tmpfs", source: "tmpfs", options: ["nosuid","nodev","mode=755","uid=1000","gid=1000"] },
    { destination: "/drive", type: "bind", source: $drive, options: ["rbind","rw"] },
    { destination: "/work", type: "bind", source: $w, options: ["rbind","rw"] }
  ],
  linux: { namespaces: [ {type:"pid"}, {type:"network"}, {type:"ipc"}, {type:"uts"}, {type:"mount"} ] }
}' > "$bundle/config.json"

ms() { date +%s%3N; }

# Cold start: create + start detached, then wait until the first exec answers.
t0=$(ms)
if ! rs run -bundle "$bundle" -detach "$id" < /dev/null > "$work/run.log" 2>&1; then
  echo "runsc run failed:" >&2; cat "$work/run.log" >&2; exit 1
fi
t1=$(ms)
rs exec "$id" /bin/true
t2=$(ms)

# First and warm exec latency.
t3=$(ms); rs exec "$id" /bin/true; t4=$(ms)

check() { # name, command...
  local name="$1"; shift
  if out=$(rs exec "$id" "$@" 2>&1); then
    printf '  ok   %-10s %s\n' "$name" "$(echo "$out" | head -1)"
  else
    printf '  FAIL %-10s %s\n' "$name" "$(echo "$out" | tail -1)"; fail=1
  fi
}
fail=0
echo "checks inside the sandbox:"
check whoami    /usr/bin/id -un
check python    python3 -c 'import sys, numpy, pandas, requests, yaml, pypdf; print(sys.version.split()[0], "numpy", numpy.__version__)'
check node      node -e 'require("lodash"); require("zod"); require("better-sqlite3"); console.log(process.version)'
check tsc       tsc --version
check git       git --version
check rg        rg --version
check jq        jq --version
check gcc       gcc --version
check drive     cat /drive/hello.txt
check write     sh -c 'echo x > /work/out && cat /work/out'
check ro-root   sh -c 'if touch /usr/x 2>/dev/null; then echo writable; exit 1; else echo read-only; fi'
check no-net    python3 -c 'import socket
try:
    socket.create_connection(("1.1.1.1", 80), timeout=2); print("reachable"); raise SystemExit(1)
except OSError as e: print("no network:", e.__class__.__name__)'
check compile   sh -c 'cd /tmp && printf "int main(){return 0;}" > a.c && gcc a.c -o a && ./a && echo compiled'

# Stop and time it.
t5=$(ms)
rs kill "$id" KILL >/dev/null 2>&1 || true
rs delete -force "$id" >/dev/null 2>&1 || true
t6=$(ms)

size=$(du -s --apparent-size --block-size=1M "$rootfs" | cut -f1)
files=$(find "$rootfs" -xdev | wc -l)
printf '{"platform":"%s","rootfs_mb":%s,"rootfs_files":%s,"run_detach_ms":%s,"cold_start_to_first_exec_ms":%s,"warm_exec_ms":%s,"stop_ms":%s,"checks_ok":%s}\n' \
  "$platform" "$size" "$files" $((t1-t0)) $((t2-t0)) $((t4-t3)) $((t6-t5)) $([ $fail = 0 ] && echo true || echo false)
exit $fail
