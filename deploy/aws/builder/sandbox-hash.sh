#!/usr/bin/env bash
# The hash of what the sandbox rootfs is built from. The builder image records
# it; a build whose sandbox/ hashes differently tests against a stale rootfs and
# is not released (run.sh).
set -euo pipefail
cd "${1:?repo}"
find sandbox -type f ! -name '*.md' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
