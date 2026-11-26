#!/usr/bin/env bash
# Assemble the code artifact for the builder MicroVM image: a zip with one
# Dockerfile (the sandbox rootfs stage from sandbox/Dockerfile, then
# Dockerfile.builder), the runner, and the repository at HEAD for warming.
#
#   deploy/aws/builder/make-image.sh OUT.zip
#
# Then upload it and create or update the MicroVM image (see deploy/aws/PIPELINE.md).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$(realpath -m "${1:?out.zip}")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# The sandbox stage as is, minus its build-secret mounts (they pass a proxy CA,
# which the MicroVM image builder does not need), named "sandbox".
sed -e 's/--mount=type=secret,id=ca,required=false //' \
    -e 's/^FROM \${BASE_IMAGE}$/FROM ${BASE_IMAGE} AS sandbox/' \
    "$repo/sandbox/Dockerfile" > "$tmp/Dockerfile"
grep -q 'AS sandbox$' "$tmp/Dockerfile" || { echo "sandbox stage not found" >&2; exit 1; }
if grep -q -- '--mount=type=secret' "$tmp/Dockerfile"; then echo "secret mount left" >&2; exit 1; fi
cat "$here/Dockerfile.builder" >> "$tmp/Dockerfile"

cp "$repo/sandbox/python-packages.txt" "$repo/sandbox/npm-packages.txt" "$repo/sandbox/install-runsc.sh" \
   "$repo/deploy/aws/microvm-spike/image.json" "$tmp/"
"$here/sandbox-hash.sh" "$repo" > "$tmp/SANDBOX_SHA256"
mkdir "$tmp/builder" "$tmp/src"
cp "$here/runner.mjs" "$here/run.sh" "$here/warm.sh" "$here/prepare.sh" "$here/sandbox-hash.sh" "$here/package.json" "$here/package-lock.json" "$tmp/builder/"
git -C "$repo" archive HEAD | tar -x -C "$tmp/src"
(cd "$tmp" && rm -f "$out" && zip -qr "$out" .)
echo "$out $(du -h "$out" | cut -f1) $(sha256sum "$out" | cut -d' ' -f1) sandbox=$(cat "$tmp/SANDBOX_SHA256")"
