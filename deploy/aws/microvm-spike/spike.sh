#!/usr/bin/env bash
# What a Lambda MicroVM can do for Agent Drive: gVisor sandboxes, FUSE, and the
# full test suite. Prints one "SPIKE-RESULT {json}" line at the end.
set -u
cd /opt/agent-drive
export PATH=/usr/local/bin:$PATH
rootfs=/opt/data/images/default/rootfs
t0=$(date +%s)
step() { echo; echo "SPIKE ==== $* ($(( $(date +%s) - t0 ))s)"; }

step environment
echo "commit $(cat COMMIT)"
uname -a
nproc; free -m | head -2; df -h / /tmp | tail -n +1
grep -E '^(Cap(Eff|Bnd)|Seccomp|NoNewPrivs)' /proc/self/status
echo "uid $(id -u)"
ls -l /dev/fuse /dev/kvm /dev/net/tun 2>&1
cat /proc/sys/kernel/yama/ptrace_scope 2>&1 | sed 's/^/ptrace_scope /'
stat -fc 'cgroup fs %T' /sys/fs/cgroup 2>&1
mount | grep -E ' / | /tmp | /sys/fs/cgroup' | head -5

step fuse
fuse_open=$(python3 -c 'import os; os.close(os.open("/dev/fuse", os.O_RDWR)); print("yes")' 2>&1 | tail -1)
echo "open /dev/fuse: $fuse_open"

step cgroups
# cgroup v2 "no internal processes": the container starts in the root cgroup,
# which then cannot give controllers to children (runsc fails with "write
# cgroup.subtree_control: device or resource busy"). Move every process into
# a child cgroup first, as Docker-in-Docker does, then enable the controllers.
cg=/sys/fs/cgroup
echo "controllers: $(cat $cg/cgroup.controllers)"
echo "subtree before: $(cat $cg/cgroup.subtree_control)"
mkdir -p $cg/init
for pid in $(cat $cg/cgroup.procs); do echo "$pid" > $cg/init/cgroup.procs 2>/dev/null || echo "could not move $pid"; done
for c in $(cat $cg/cgroup.controllers); do echo "+$c" > $cg/cgroup.subtree_control 2>/dev/null || echo "could not enable $c"; done
echo "subtree after: $(cat $cg/cgroup.subtree_control)"
cgroups_ok=$([ -n "$(cat $cg/cgroup.subtree_control)" ] && echo yes || echo no)

step "runsc smoke"
s0=$(date +%s)
deploy/aws/ci.sh smoke "$rootfs"; smoke=$?
smoke_s=$(( $(date +%s) - s0 ))

step "full test suite with gVisor"
export AGENT_DRIVE_RUNSC=/usr/local/bin/runsc AGENT_DRIVE_ROOTFS="$rootfs" \
       AGENT_DRIVE_TEST_IMAGE_ROOTFS="$rootfs" AGENT_DRIVE_TEST_PREFIX=mv
v0=$(date +%s)
npx vitest run --reporter=default > /tmp/vitest.log 2>&1; tests=$?
tests_s=$(( $(date +%s) - v0 ))
grep -v -E 'ExperimentalWarning|trace-warnings' /tmp/vitest.log | tail -n 60
summary=$(grep -E '^ +(Test Files|Tests) ' /tmp/vitest.log | tr -s ' ' | tr '\n' ';')

step done
printf 'SPIKE-RESULT {"kernel":"%s","nproc":%s,"fuse_open":"%s","cgroups":"%s","smoke_exit":%s,"smoke_s":%s,"tests_exit":%s,"tests_s":%s,"summary":"%s","total_s":%s}\n' \
  "$(uname -r)" "$(nproc)" "$fuse_open" "$cgroups_ok" "$smoke" "$smoke_s" "$tests" "$tests_s" "$summary" "$(( $(date +%s) - t0 ))"
