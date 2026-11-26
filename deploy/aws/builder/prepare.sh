#!/usr/bin/env bash
# Make the MicroVM's container able to run gVisor sandboxes (decision 0007).
set -u
cg=/sys/fs/cgroup
if [ ! -f $cg/cgroup.controllers ]; then echo "[prepare] no cgroup v2 here; nothing to do"; exit 0; fi
# cgroup v2: a cgroup holding processes cannot give controllers to children, so
# runsc fails with "write cgroup.subtree_control: device or resource busy".
# Move every process into a child cgroup first, as Docker-in-Docker does.
if [ -z "$(cat $cg/cgroup.subtree_control)" ]; then
  mkdir -p $cg/init
  for pid in $(cat $cg/cgroup.procs); do echo "$pid" > $cg/init/cgroup.procs 2>/dev/null || true; done
  for c in $(cat $cg/cgroup.controllers); do echo "+$c" > $cg/cgroup.subtree_control 2>/dev/null || echo "[prepare] could not enable $c"; done
fi
echo "[prepare] cgroup controllers for children: $(cat $cg/cgroup.subtree_control)"
