#!/usr/bin/env bash
# The cost of durable deletes: two daemon builds on the host (kernel caching), each over a
# fresh store of the sympy checkout, timing operations that add whiteouts. Runs alternate
# between the builds. Medians in ms.
#   rm_store      rm -rf of a store directory never written (sympy/core: whiteouts only)
#   rm_copied     rm of 200 store files after appending to each (copied up, then deleted)
#   mv_store_file mv of 200 store files to new names (copy-up, rename, whiteout)
#   mv_store_dir  mv of a store directory (sympy/polys: copy-up of the tree, rename, whiteout)
# Usage: deletes.sh <binary a> <binary b> [runs]   Env: FS_PREFIX (default a8).
set -uo pipefail
bin_a=$1
bin_b=$2
runs=${3:-5}
p=${FS_PREFIX:-a8}
out=/tmp/$p-gv/deletes
daemon=
mnt=

cleanup() {
  [ -n "$daemon" ] && kill -INT "$daemon" 2>/dev/null && wait "$daemon" 2>/dev/null
  [ -n "$mnt" ] && mountpoint -q "$mnt" && fusermount3 -u "$mnt"
  daemon=
}
trap cleanup EXIT
mkdir -p "$out"

now() { date +%s%N; }
ms() { echo $(( ($2 - $1) / 1000000 )); }

one() { # binary label -> prints "label op ms" lines
  local bin=$1 label=$2 id=$p-del data=/tmp/$p-data/$p-del
  rm -rf "$data"
  "$bin" stub --data "$data" --dir-id "$id" --tree /tmp/$p-src/sympy --prefix sympy >/dev/null
  mnt=$data/sessions/$id/mnt
  "$bin" mount --data "$data" --dir-id "$id" --name "$id" --entry-timeout-ms 60000 --attr-timeout-ms 60000 >"$out/$label.log" 2>&1 &
  daemon=$!
  for _ in $(seq 50); do mountpoint -q "$mnt" && break; sleep 0.1; done
  local d=$mnt/sympy/sympy t0 t1
  t0=$(now); rm -rf "$d/core"; t1=$(now); echo "$label rm_store $(ms "$t0" "$t1")"
  mapfile -t files < <(find "$d/printing" -type f -name '*.py' | head -200)
  for f in "${files[@]}"; do echo >>"$f"; done
  t0=$(now); rm -f "${files[@]}"; t1=$(now); echo "$label rm_copied $(ms "$t0" "$t1")"
  mapfile -t files < <(find "$d/functions" -type f -name '*.py' | head -200)
  t0=$(now); for f in "${files[@]}"; do mv "$f" "$f.moved"; done; t1=$(now); echo "$label mv_store_file $(ms "$t0" "$t1")"
  t0=$(now); mv "$d/polys" "$mnt/sympy/polys-moved"; t1=$(now); echo "$label mv_store_dir $(ms "$t0" "$t1")"
  echo "$label whiteouts $(wc -l <"$data/sessions/$id/whiteouts")"
  cleanup
}

for i in $(seq "$runs"); do
  one "$bin_a" a
  one "$bin_b" b
done | tee "$out/raw.txt"
python3 - "$out/raw.txt" <<'EOF'
import statistics, sys, collections
d = collections.defaultdict(list)
for line in open(sys.argv[1]):
    label, op, v = line.split()
    d[(op, label)].append(int(v))
ops = list(dict.fromkeys(op for op, _ in d))
print("| Operation | a | b | b/a |")
print("| --- | ---: | ---: | ---: |")
for op in ops:
    a, b = statistics.median(d[(op, "a")]), statistics.median(d[(op, "b")])
    print(f"| {op} | {a:.0f} | {b:.0f} | {b / a if a else 0:.2f} |")
EOF
