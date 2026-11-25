#!/usr/bin/env bash
# Benchmarks: the session file system daemon against a plain bind mount of the same files,
# inside gVisor and on the host. Builds fresh stores from the source trees each time.
# Daemons: drive = kernel caching (60 s timeouts) with invalidation, the default proposed;
#          drive_zero = zero timeouts, every operation reaches the daemon.
# Usage: gvisor-bench.sh [runs]   (default 7)
# Needs: target/release/agent-drive-fs, /tmp/${p}-gv/rootfs (make-rootfs.sh),
#        /tmp/${p}-src/{sympy,mpmath} (Git checkouts).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=${BIN:-$here/../target/release/agent-drive-fs}
p=${FS_PREFIX:-a2}  # name prefix for mounts, sandboxes, processes and /tmp data
runs=${1:-7}
rootfs=/tmp/${p}-gv/rootfs
out=/tmp/${p}-gv/bench-work
runsc=(runsc --root /tmp/${p}-runsc --network=none)
daemons=()
mnts=()

cleanup() {
  for s in ${p}-bench-shared ${p}-bench-excl; do
    "${runsc[@]}" kill "$s" KILL >/dev/null 2>&1
    "${runsc[@]}" delete -force "$s" >/dev/null 2>&1
  done
  for p in "${daemons[@]}"; do kill -INT "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  for m in "${mnts[@]}"; do mountpoint -q "$m" && fusermount3 -u "$m"; done
  mountpoint -q /tmp/${p}-runsc/null-netns && umount /tmp/${p}-runsc/null-netns
}
trap cleanup EXIT

store() { # name, entry/attr timeout ms -> mounts a daemon, prints the mount point
  local data=/tmp/${p}-data/$1 id=$1
  rm -rf "$data"
  "$bin" stub --data "$data" --dir-id "$id" --synthetic \
    --tree /tmp/${p}-src/sympy --prefix repos/sympy --tree /tmp/${p}-src/mpmath --prefix repos/mpmath >/dev/null
  local mnt=$data/sessions/$id/mnt
  "$bin" mount --data "$data" --dir-id "$id" --name "${p}-fsd-${1#${p}-}" \
    --entry-timeout-ms "$2" --attr-timeout-ms "$2" >"/tmp/${p}-gv/$1.log" 2>&1 &
  daemons+=($!)
  mnts+=("$mnt")
  for _ in $(seq 50); do mountpoint -q "$mnt" && break; sleep 0.1; done
  mountpoint -q "$mnt" || { echo "mount $1 failed" >&2; exit 1; }
}
plain() { # name -> a materialised copy, as the thin drive mounts today
  rm -rf "/tmp/${p}-plain-$1"
  "$bin" materialize --data /tmp/${p}-data/${p}-bg --dir-id ${p}-bg --out "/tmp/${p}-plain-$1" >/dev/null
}

rm -rf "$out"; mkdir -p "$out" /tmp/${p}-runsc
cp "$here/bench.py" "$out/"
store ${p}-bg 60000
store ${p}-bgz 0
store ${p}-bh 60000
plain s; plain e; plain h
mg=/tmp/${p}-data/${p}-bg/sessions/${p}-bg/mnt
mgz=/tmp/${p}-data/${p}-bgz/sessions/${p}-bgz/mnt
mh=/tmp/${p}-data/${p}-bh/sessions/${p}-bh/mnt

echo "== gVisor, --file-access-mounts=shared"
mkdir -p "$out/b-shared"
python3 "$here/bundle.py" "$out/b-shared" "$rootfs" "/drive=$mg" "/drive_zero=$mgz" "/plain=/tmp/${p}-plain-s" "/work=$out"
"${runsc[@]}" --file-access-mounts=shared run -bundle "$out/b-shared" -detach ${p}-bench-shared </dev/null >"$out/shared.log" 2>&1 || { cat "$out/shared.log"; exit 1; }
"${runsc[@]}" exec ${p}-bench-shared python3 /work/bench.py "$runs" /work/gvisor-shared.json \
  drive=/drive drive_zero=/drive_zero plain=/plain

echo "== gVisor, default file access (plain copy only)"
mkdir -p "$out/b-excl"
python3 "$here/bundle.py" "$out/b-excl" "$rootfs" "/plain=/tmp/${p}-plain-e" "/work=$out"
"${runsc[@]}" run -bundle "$out/b-excl" -detach ${p}-bench-excl </dev/null >"$out/excl.log" 2>&1 || { cat "$out/excl.log"; exit 1; }
"${runsc[@]}" exec ${p}-bench-excl python3 /work/bench.py "$runs" /work/gvisor-excl.json plain_exclusive=/plain

echo "== host, no sandbox"
python3 "$here/bench.py" "$runs" "$out/host.json" drive=$mh plain=/tmp/${p}-plain-h

for id in ${p}-bg ${p}-bgz ${p}-bh; do
  echo "$id opens recorded: $("$bin" opens --data /tmp/${p}-data/$id --dir-id $id)"
done
echo "results in $out"
