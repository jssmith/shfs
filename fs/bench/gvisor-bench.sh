#!/usr/bin/env bash
# Benchmarks: the session file system daemon against a plain bind mount of the same files,
# inside gVisor and on the host. Builds fresh stores from the source trees each time.
# Daemons: drive = kernel caching (60 s timeouts) with invalidation, the default proposed;
#          drive_zero = zero timeouts, every operation reaches the daemon.
# Usage: gvisor-bench.sh [runs]   (default 7)
# Needs: target/release/agent-drive-fs, /tmp/a2-gv/rootfs (make-rootfs.sh),
#        /tmp/a2-src/{sympy,mpmath} (Git checkouts).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=$here/../target/release/agent-drive-fs
runs=${1:-7}
rootfs=/tmp/a2-gv/rootfs
out=/tmp/a2-gv/bench-work
export GVISOR_SIDECAR_BINARIES_DIR=${GVISOR_SIDECAR_BINARIES_DIR:-/tmp/a2-gv/gvisor-bin}
runsc=(runsc --root /tmp/a2-runsc --network=none)
daemons=()
mnts=()

cleanup() {
  for s in a2-bench-shared a2-bench-excl; do
    "${runsc[@]}" kill "$s" KILL >/dev/null 2>&1
    "${runsc[@]}" delete -force "$s" >/dev/null 2>&1
  done
  for p in "${daemons[@]}"; do kill -INT "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  for m in "${mnts[@]}"; do mountpoint -q "$m" && fusermount3 -u "$m"; done
}
trap cleanup EXIT

store() { # name, entry/attr timeout ms -> mounts a daemon, prints the mount point
  local data=/tmp/a2-data/$1 id=$1
  rm -rf "$data"
  "$bin" stub --data "$data" --dir-id "$id" --synthetic \
    --tree /tmp/a2-src/sympy --prefix repos/sympy --tree /tmp/a2-src/mpmath --prefix repos/mpmath >/dev/null
  local mnt=$data/sessions/$id/mnt
  "$bin" mount --data "$data" --dir-id "$id" --name "a2-fsd-${1#a2-}" \
    --entry-timeout-ms "$2" --attr-timeout-ms "$2" >"/tmp/a2-gv/$1.log" 2>&1 &
  daemons+=($!)
  mnts+=("$mnt")
  for _ in $(seq 50); do mountpoint -q "$mnt" && break; sleep 0.1; done
  mountpoint -q "$mnt" || { echo "mount $1 failed" >&2; exit 1; }
}
plain() { # name -> a materialised copy, as the thin drive mounts today
  rm -rf "/tmp/a2-plain-$1"
  "$bin" materialize --data /tmp/a2-data/a2-bg --dir-id a2-bg --out "/tmp/a2-plain-$1" >/dev/null
}

rm -rf "$out"; mkdir -p "$out" /tmp/a2-runsc
cp "$here/bench.py" "$out/"
store a2-bg 60000
store a2-bgz 0
store a2-bh 60000
plain s; plain e; plain h
mg=/tmp/a2-data/a2-bg/sessions/a2-bg/mnt
mgz=/tmp/a2-data/a2-bgz/sessions/a2-bgz/mnt
mh=/tmp/a2-data/a2-bh/sessions/a2-bh/mnt

echo "== gVisor, --file-access-mounts=shared"
mkdir -p "$out/b-shared"
python3 "$here/bundle.py" "$out/b-shared" "$rootfs" "/drive=$mg" "/drive_zero=$mgz" "/plain=/tmp/a2-plain-s" "/work=$out"
"${runsc[@]}" --file-access-mounts=shared run -bundle "$out/b-shared" -detach a2-bench-shared </dev/null >"$out/shared.log" 2>&1 || { cat "$out/shared.log"; exit 1; }
"${runsc[@]}" exec a2-bench-shared python3 /work/bench.py "$runs" /work/gvisor-shared.json \
  drive=/drive drive_zero=/drive_zero plain=/plain

echo "== gVisor, default file access (plain copy only)"
mkdir -p "$out/b-excl"
python3 "$here/bundle.py" "$out/b-excl" "$rootfs" "/plain=/tmp/a2-plain-e" "/work=$out"
"${runsc[@]}" run -bundle "$out/b-excl" -detach a2-bench-excl </dev/null >"$out/excl.log" 2>&1 || { cat "$out/excl.log"; exit 1; }
"${runsc[@]}" exec a2-bench-excl python3 /work/bench.py "$runs" /work/gvisor-excl.json plain_exclusive=/plain

echo "== host, no sandbox"
python3 "$here/bench.py" "$runs" "$out/host.json" drive=$mh plain=/tmp/a2-plain-h

for id in a2-bg a2-bgz a2-bh; do
  echo "$id opens recorded: $("$bin" opens --data /tmp/a2-data/$id --dir-id $id)"
done
echo "results in $out"
