#!/usr/bin/env bash
# Soak: the daemon (kernel caching, the proposed default) mounted into a gVisor sandbox
# (--file-access-mounts=shared, --network=none) under a long mixed workload (soak.py inside:
# Git, mpmath's tests, small files, renames, checks of hidden and shown items) while the host
# bumps the epoch to hide and show items and samples the daemon's memory (soak_host.py).
# Usage: soak.sh [seconds]   (default 1500)   Env: FS_PREFIX (default a8), BIN.
# Needs /tmp/$p-gv/rootfs (make-rootfs.sh) and /tmp/$p-src/{sympy,mpmath}.
# Results in /tmp/$p-soak/work: samples.jsonl, progress.json, failures.log, summary.txt.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
secs=${1:-1500}
p=${FS_PREFIX:-a8}
bin=${BIN:-$here/../target/release/agent-drive-fs}
root=/tmp/$p-soak
data=$root/data
id=$p-soak
mnt=$data/sessions/$id/mnt
work=$root/work
sbx=$p-soak-sbx
runsc=(runsc --root /tmp/$p-runsc --network=none --file-access-mounts=shared)
daemon=
hostpid=

cleanup() {
  [ -n "$hostpid" ] && kill "$hostpid" 2>/dev/null
  "${runsc[@]}" kill "$sbx" KILL >/dev/null 2>&1
  "${runsc[@]}" delete -force "$sbx" >/dev/null 2>&1
  [ -n "$daemon" ] && kill -INT "$daemon" 2>/dev/null && wait "$daemon" 2>/dev/null
  mountpoint -q "$mnt" && fusermount3 -u "$mnt"
  umount /tmp/$p-runsc/null-netns 2>/dev/null
}
trap cleanup EXIT

rm -rf "$root"
mkdir -p "$work" "$root/toggle-src/dir" /tmp/$p-runsc
for k in $(seq -f %02g 0 19); do echo "toggle item t$k.txt" >"$root/toggle-src/t$k.txt"; done
for k in 0 1 2 3 4; do echo "dir item $k" >"$root/toggle-src/dir/d$k.txt"; done
"$bin" stub --data "$data" --dir-id "$id" --synthetic \
  --tree /tmp/$p-src/sympy --prefix repos/sympy --tree /tmp/$p-src/mpmath --prefix repos/mpmath \
  --tree "$root/toggle-src" --prefix toggle >/dev/null || exit 1
blobs_before=$(cd "$data/blobs" && find . -type f -printf '%p %s %T@ %m\n' | sort | sha256sum)

"$bin" mount --data "$data" --dir-id "$id" --name "$p-soak-fsd" \
  --entry-timeout-ms 60000 --attr-timeout-ms 60000 >"$work/daemon.log" 2>&1 &
daemon=$!
for _ in $(seq 50); do mountpoint -q "$mnt" && break; sleep 0.1; done
mountpoint -q "$mnt" || { echo "mount failed"; cat "$work/daemon.log"; exit 1; }

cp "$here/soak.py" "$here/miniruntests.py" "$work/"
mkdir -p "$root/bundle"
python3 "$here/bundle.py" "$root/bundle" /tmp/$p-gv/rootfs "/drive=$mnt" "/work=$work"
"${runsc[@]}" run -bundle "$root/bundle" -detach "$sbx" </dev/null >"$work/sandbox.log" 2>&1 \
  || { echo "sandbox failed"; cat "$work/sandbox.log"; exit 1; }

python3 "$here/soak_host.py" "$data" "$id" "$work" "$secs" "$daemon" &
hostpid=$!
echo "soak: $secs s, daemon pid $daemon, results in $work"
"${runsc[@]}" exec "$sbx" python3 /work/soak.py "$secs" /work >"$work/soak.out" 2>&1
echo "workload exit $?"
wait "$hostpid"; hostpid=

# Final checks from inside: the repository is whole and the drive lists.
fsck=$("${runsc[@]}" exec "$sbx" sh -c 'cd /drive/repos/sympy && git fsck --no-progress --no-dangling && git status --porcelain --untracked-files=no | wc -l' 2>&1)
blobs_after=$(cd "$data/blobs" && find . -type f -printf '%p %s %T@ %m\n' | sort | sha256sum)
{
  echo "workload: $(cat "$work/soak.out" | tr -d '\n' | head -c 2000)"
  echo "final fsck and status lines: $fsck"
  echo "blob store unchanged: $([ "$blobs_before" == "$blobs_after" ] && echo yes || echo NO)"
  echo "failures: $(cat "$work/failures.log" 2>/dev/null | grep -c '^[0-9][0-9]:')"
  grep '^[0-9][0-9]:' "$work/failures.log" 2>/dev/null | cut -c1-300 | head -20
  echo "daemon alive: $(kill -0 "$daemon" 2>/dev/null && echo yes || echo NO)"
  echo "symlinks in upper/: $(find "$data/sessions/$id/upper" -type l | wc -l)"
} | tee "$work/summary.txt"
python3 - "$work/samples.jsonl" <<'EOF' | tee -a "$work/summary.txt"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
print("| t (s) | RSS (MiB) | peak RSS (MiB) | fds | inodes | paths | handles | whiteouts | upper (MiB) | activity rows | epoch bumps |")
print("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for r in rows[::max(1, len(rows) // 12)] + rows[-1:]:
    s = r["stats"]
    print(f"| {r['t']} | {r['rss_kb'] / 1024:.1f} | {r['hwm_kb'] / 1024:.1f} | {r['fds']} | {s.get('inodes')} | {s.get('paths')} "
          f"| {s.get('handles')} | {s.get('whiteouts')} | {r['upper_kb'] / 1024:.0f} | {r['activity_rows']} | {r['toggler'].get('bumps')} |")
EOF
