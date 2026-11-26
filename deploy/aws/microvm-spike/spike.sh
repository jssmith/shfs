#!/usr/bin/env bash
# What a Lambda MicroVM can do for Agent Drive: gVisor sandboxes, FUSE, and the
# full test suite. Prints one "SPIKE-RESULT {json}" line at the end.
set -u
cd /opt/agent-drive
export PATH=/usr/local/bin:$PATH
rootfs=/opt/data/images/default/rootfs
t0=$(date +%s)
step() { echo; echo "SPIKE ==== $* ($(( $(date +%s) - t0 ))s)"; }

cpu_ms() { node -e 'let t=Date.now(),x=0;for(let i=0;i<3e8;i++)x+=i%7;console.log(Date.now()-t)'; }
step environment
echo "SPIKE-BENCH cpu_start_ms=$(cpu_ms)"
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

step limits
# The container starts with a low open-files limit; parallel gVisor suites hit
# "creating fd map: duplicating payload files: too many open files" (run 2).
echo "nofile before: $(ulimit -Sn) soft, $(ulimit -Hn) hard; fs.nr_open $(cat /proc/sys/fs/nr_open)"
# 1048576 hung the suite in run 3 (no output for 6 minutes); 65536 is enough.
ulimit -Hn "${SPIKE_NOFILE:-65536}" 2>/dev/null || true
ulimit -Sn "$(ulimit -Hn)"
echo "nofile after: $(ulimit -Sn) soft, $(ulimit -Hn) hard"
nofile=$(ulimit -Sn)

step "process start cost by open-files limit"
# Run 4 (limit 65536) was about 6x slower than run 2 (1024); run 3 (1048576) hung.
# Time 200 process starts from bash, Node and Python, and one runsc smoke, per limit.
for lim in 1024 8192 65536; do
  ( ulimit -Sn "$lim"
    a=$(date +%s%N); for i in $(seq 200); do /bin/true; done; b=$(date +%s%N)
    n=$(node -e 'const {spawnSync}=require("child_process");const t=Date.now();for(let i=0;i<200;i++)spawnSync("/bin/true");console.log(Date.now()-t)')
    py=$(python3 -c 'import subprocess,time;t=time.time();[subprocess.run(["/bin/true"]) for _ in range(200)];print(int((time.time()-t)*1000))')
    c=$(date +%s); deploy/aws/ci.sh smoke "$rootfs" >/dev/null 2>&1; sm=$?; d=$(date +%s)
    echo "SPIKE-BENCH nofile=$lim bash_ms=$(( (b-a)/1000000 )) node_ms=$n python_ms=$py smoke_exit=$sm smoke_s=$((d-c))" )
done
ulimit -Sn "${SPIKE_NOFILE_TESTS:-8192}"
echo "nofile for the test suite: $(ulimit -Sn)"
nofile=$(ulimit -Sn)

step "runsc smoke"
s0=$(date +%s)
deploy/aws/ci.sh smoke "$rootfs"; smoke=$?
smoke_s=$(( $(date +%s) - s0 ))

step "full test suite with gVisor"
export AGENT_DRIVE_RUNSC=/usr/local/bin/runsc AGENT_DRIVE_ROOTFS="$rootfs" \
       AGENT_DRIVE_TEST_IMAGE_ROOTFS="$rootfs" AGENT_DRIVE_TEST_PREFIX=mv
v0=$(date +%s)
# Stream progress (one line per file) so a hang shows where it is.
npx vitest run --reporter=default 2>&1 | grep --line-buffered -v -E 'ExperimentalWarning|trace-warnings' | tee /tmp/vitest.log; tests=${PIPESTATUS[0]}
tests_s=$(( $(date +%s) - v0 ))
summary=$(grep -E '^ +(Test Files|Tests) ' /tmp/vitest.log | tr -s ' ' | tr '\n' ';')

step done
echo "SPIKE-BENCH cpu_end_ms=$(cpu_ms)"
printf 'SPIKE-RESULT {"kernel":"%s","nproc":%s,"fuse_open":"%s","cgroups":"%s","nofile":"%s","smoke_exit":%s,"smoke_s":%s,"tests_exit":%s,"tests_s":%s,"summary":"%s","total_s":%s}\n' \
  "$(uname -r)" "$(nproc)" "$fuse_open" "$cgroups_ok" "$nofile" "$smoke" "$smoke_s" "$tests" "$tests_s" "$summary" "$(( $(date +%s) - t0 ))"
