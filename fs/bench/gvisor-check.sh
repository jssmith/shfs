#!/usr/bin/env bash
# Correctness of the session file system inside gVisor: mounts the daemon on the host, starts a
# sandbox with it at /drive (--file-access-mounts=shared, --network=none), and repeats the key
# checks from inside. Cleans up the sandbox and the mount on exit, also after failures.
# Usage: [FS_FLAGS="--entry-timeout-ms 60000 --attr-timeout-ms 60000"] gvisor-check.sh [rootfs]
# (rootfs default /tmp/a2-gv/rootfs, see make-rootfs.sh; FS_FLAGS are extra daemon flags)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=$here/../target/release/agent-drive-fs
rootfs=${1:-/tmp/a2-gv/rootfs}
data=/tmp/a2-data/check
id=a2-check
sbx=a2-check-sbx
mnt=$data/sessions/$id/mnt
work=/tmp/a2-gv/check-work
bundle=/tmp/a2-gv/check-bundle
runsc=(runsc --root /tmp/a2-runsc --network=none --file-access-mounts=shared)
pass=0
fail=0

cleanup() {
  "${runsc[@]}" kill "$sbx" KILL >/dev/null 2>&1
  "${runsc[@]}" delete -force "$sbx" >/dev/null 2>&1
  [ -n "${daemon:-}" ] && kill -INT "$daemon" 2>/dev/null && wait "$daemon" 2>/dev/null
  mountpoint -q "$mnt" && fusermount3 -u "$mnt"
}
trap cleanup EXIT

check() { # description, expected, actual
  if [ "$2" == "$3" ]; then
    echo "PASS  $1"; pass=$((pass + 1))
  else
    echo "FAIL  $1: expected [$2], got [$3]"; fail=$((fail + 1))
  fi
}
ex() { "${runsc[@]}" exec "$sbx" "$@" 2>&1; }

rm -rf "$data" "$work" "$bundle"
mkdir -p "$work" "$bundle" /tmp/a2-runsc
"$bin" stub --data "$data" --dir-id "$id" --synthetic >/dev/null
"$bin" mount --data "$data" --dir-id "$id" --name a2-fsd-check ${FS_FLAGS:-} >/tmp/a2-gv/check-daemon.log 2>&1 &
daemon=$!
for _ in $(seq 50); do mountpoint -q "$mnt" && break; sleep 0.1; done
mountpoint -q "$mnt" || { echo "mount failed"; cat /tmp/a2-gv/check-daemon.log; exit 1; }

python3 "$here/bundle.py" "$bundle" "$rootfs" "/drive=$mnt" "/work=$work"
"${runsc[@]}" run -bundle "$bundle" -detach "$sbx" </dev/null >/tmp/a2-gv/check-sandbox.log 2>&1 \
  || { echo "sandbox failed"; cat /tmp/a2-gv/check-sandbox.log; exit 1; }

upper=$data/sessions/$id/upper
check "listing of /drive" "_by notes projects" "$(ex ls /drive | xargs)"
check "ringed item absent" "absent" "$(ex sh -c 'test -e /drive/finance && echo present || echo absent')"
check "read from blob" "buy milk write spike" "$(ex cat /drive/notes/todo.txt | xargs)"
check "symlink target" "../../../projects/acme/plan.md" "$(ex readlink /drive/_by/project/acme/plan.md)"
check "read through symlink" "Plan for Acme Robotics (synthetic)." "$(ex cat /drive/_by/project/acme/plan.md)"

ex sh -c 'echo third >> /drive/notes/todo.txt' >/dev/null
check "append, seen inside" "buy milk write spike third" "$(ex cat /drive/notes/todo.txt | xargs)"
check "append, copied up on host" "buy milk write spike third" "$(xargs <"$upper/notes/todo.txt")"

ex sh -c 'mkdir /drive/out && echo new > /drive/out/new.txt' >/dev/null
check "create in new directory" "new" "$(cat "$upper/out/new.txt")"

ex sh -c 'printf edited > /drive/notes/.readme.md.swp && mv /drive/notes/.readme.md.swp /drive/notes/readme.md' >/dev/null
check "rename-over, content" "edited" "$(ex cat /drive/notes/readme.md)"
check "rename-over, listing" "readme.md todo.txt" "$(ex ls -A /drive/notes | xargs)"
check "rename-over, no whiteout for target" "0" "$(grep -c '^notes/readme.md$' "$data/sessions/$id/whiteouts")"

ex rm /drive/projects/acme/budget.csv >/dev/null
check "unlink, listing" "plan.md" "$(ex ls /drive/projects/acme | xargs)"
check "unlink, whiteout" "projects/acme/budget.csv" "$(cat "$data/sessions/$id/whiteouts")"

ex mv /drive/notes/todo.txt /drive/projects/todo.txt >/dev/null
check "rename across directories" "readme.md" "$(ex ls /drive/notes | xargs)"
check "renamed content" "buy milk write spike third" "$(ex cat /drive/projects/todo.txt | xargs)"

# Hide on epoch. Prime gVisor's own caches first, then the server hides the item.
ex sh -c 'ls -l /drive/projects/acme; cat /drive/projects/acme/plan.md; stat /drive/projects/acme/plan.md' >/dev/null
# A process inside holds the file open across the hide.
ex python3 -c '
import os, time
f = open("/drive/projects/acme/plan.md", "rb"); f.read(4)
open("/work/ready", "w").close()
while not os.path.exists("/work/go"): time.sleep(0.01)
try:
    os.lseek(f.fileno(), 0, 0); f.raw.read(100); print("read ok")
except OSError as e:
    print("read error", e.errno)
' >"$work/held.out" 2>&1 &
held=$!
for _ in $(seq 200); do [ -e "$work/ready" ] && break; sleep 0.05; done
"$bin" hide --data "$data" --dir-id "$id" --path projects/acme/plan.md >/dev/null
check "hidden: next listing" "" "$(ex ls /drive/projects/acme | xargs)"
check "hidden: next lookup" "gone" "$(ex sh -c 'stat /drive/projects/acme/plan.md >/dev/null 2>&1 && echo there || echo gone')"
check "hidden: symlink dangles" "gone" "$(ex sh -c 'cat /drive/_by/project/acme/plan.md >/dev/null 2>&1 && echo there || echo gone')"
touch "$work/go"
wait "$held"
check "hidden: held-open handle errors" "error" "$(awk '{print ($1 == "read" && $2 == "error") ? "error" : $0}' "$work/held.out")"

"$bin" bump --data "$data" --dir-id "$id" >/dev/null
check "listing after unrelated epoch bump" "readme.md" "$(ex ls /drive/notes | xargs)"

kill -INT "$daemon"; wait "$daemon"; daemon=
check "one activity row per open" "yes" "$(n=$("$bin" opens --data "$data" --dir-id "$id"); [ "$n" -ge 8 ] && echo yes || echo "no ($n)")"
echo "opens recorded: $("$bin" opens --data "$data" --dir-id "$id")"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
