#!/usr/bin/env bash
# Two daemon builds side by side: both mounted (kernel caching and zero timeouts each) in one
# gVisor sandbox with --file-access-mounts=shared, plus a plain copy, and bench.py run over all
# of them interleaved, so machine noise falls on both builds alike. Then the same on the host.
# Usage: compare.sh <binary a> <binary b> [runs]   (labels a, a_zero, b, b_zero, plain)
# Env: FS_PREFIX (default a8) names mounts, sandboxes, processes and /tmp data.
# Needs: /tmp/$p-gv/rootfs (make-rootfs.sh), /tmp/$p-src/{sympy,mpmath} (Git checkouts).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin_a=$1
bin_b=$2
runs=${3:-7}
p=${FS_PREFIX:-a8}
rootfs=/tmp/$p-gv/rootfs
out=/tmp/$p-gv/compare-work
runsc=(runsc --root /tmp/$p-runsc --network=none)
sbx=$p-compare
daemons=()
mnts=()

cleanup() {
  "${runsc[@]}" kill "$sbx" KILL >/dev/null 2>&1
  "${runsc[@]}" delete -force "$sbx" >/dev/null 2>&1
  for d in "${daemons[@]}"; do kill -INT "$d" 2>/dev/null; wait "$d" 2>/dev/null; done
  for m in "${mnts[@]}"; do mountpoint -q "$m" && fusermount3 -u "$m"; done
  umount /tmp/$p-runsc/null-netns 2>/dev/null
}
trap cleanup EXIT

store() { # binary, id, timeout ms -> mounts a daemon on a fresh store
  local bin=$1 id=$2 data=/tmp/$p-data/$2
  rm -rf "$data"
  "$bin" stub --data "$data" --dir-id "$id" --synthetic \
    --tree /tmp/$p-src/sympy --prefix repos/sympy --tree /tmp/$p-src/mpmath --prefix repos/mpmath >/dev/null
  local mnt=$data/sessions/$id/mnt
  "$bin" mount --data "$data" --dir-id "$id" --name "$id" \
    --entry-timeout-ms "$3" --attr-timeout-ms "$3" >"$out/$id.log" 2>&1 &
  daemons+=($!)
  mnts+=("$mnt")
  for _ in $(seq 50); do mountpoint -q "$mnt" && break; sleep 0.1; done
  mountpoint -q "$mnt" || { echo "mount $id failed" >&2; cat "$out/$id.log" >&2; exit 1; }
}
m() { echo "/tmp/$p-data/$1/sessions/$1/mnt"; }

rm -rf "$out"; mkdir -p "$out" /tmp/$p-runsc
cp "$here/bench.py" "$out/"
store "$bin_a" $p-ca 60000
store "$bin_a" $p-caz 0
store "$bin_b" $p-cb 60000
store "$bin_b" $p-cbz 0
rm -rf "/tmp/$p-plain-c"
"$bin_a" materialize --data /tmp/$p-data/$p-ca --dir-id $p-ca --out "/tmp/$p-plain-c" >/dev/null

echo "== gVisor, --file-access-mounts=shared"
mkdir -p "$out/bundle"
python3 "$here/bundle.py" "$out/bundle" "$rootfs" "/a=$(m $p-ca)" "/a_zero=$(m $p-caz)" \
  "/b=$(m $p-cb)" "/b_zero=$(m $p-cbz)" "/plain=/tmp/$p-plain-c" "/work=$out"
"${runsc[@]}" --file-access-mounts=shared run -bundle "$out/bundle" -detach "$sbx" </dev/null >"$out/sandbox.log" 2>&1 \
  || { cat "$out/sandbox.log"; exit 1; }
"${runsc[@]}" exec "$sbx" python3 /work/bench.py "$runs" /work/gvisor.json \
  a=/a b=/b a_zero=/a_zero b_zero=/b_zero plain=/plain
"${runsc[@]}" kill "$sbx" KILL >/dev/null 2>&1; "${runsc[@]}" delete -force "$sbx" >/dev/null 2>&1

echo "== host, no sandbox"
python3 "$here/bench.py" "$runs" "$out/host.json" a="$(m $p-ca)" b="$(m $p-cb)" plain="/tmp/$p-plain-c"

python3 - "$out" <<'EOF'
import json, sys
d = sys.argv[1]
g = json.load(open(f"{d}/gvisor.json")); h = json.load(open(f"{d}/host.json"))
ms = lambda r, k: r[k]["median"] * 1000
print("| Benchmark | gVisor a | gVisor b | b/a | gVisor a, zero | gVisor b, zero | b/a, zero | gVisor plain | host a | host b | b/a, host |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for b in g:
    r = g[b]; s = h[b]
    print(f"| {b} | {ms(r,'a'):.0f} | {ms(r,'b'):.0f} | {ms(r,'b')/ms(r,'a'):.2f} | {ms(r,'a_zero'):.0f} | {ms(r,'b_zero'):.0f} "
          f"| {ms(r,'b_zero')/ms(r,'a_zero'):.2f} | {ms(r,'plain'):.0f} | {ms(s,'a'):.0f} | {ms(s,'b'):.0f} | {ms(s,'b')/ms(s,'a'):.2f} |")
EOF
echo "results in $out"
