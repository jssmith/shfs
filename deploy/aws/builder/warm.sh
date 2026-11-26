#!/usr/bin/env bash
# Run from the /validate hook: touch what a build touches (Node, vitest, runsc,
# the rootfs), so Lambda prefetches it on every start (decision 0007, run 6:
# without this the CPU ran about 4.5x slow for minutes).
set -u
bash /opt/builder/prepare.sh
ulimit -n 8192
cd /opt/warm
export AGENT_DRIVE_RUNSC=/usr/local/bin/runsc AGENT_DRIVE_ROOTFS=/opt/data/images/default/rootfs \
       AGENT_DRIVE_TEST_IMAGE_ROOTFS=/opt/data/images/default/rootfs AGENT_DRIVE_TEST_PREFIX=warm
deploy/aws/ci.sh smoke "$AGENT_DRIVE_ROOTFS" >/dev/null 2>&1
npx vitest run server/src/merge test/e2e/src/shell.test.ts >/dev/null 2>&1
node -e 'let x=0;for(let i=0;i<3e8;i++)x+=i%7'
echo "[warm] done"
