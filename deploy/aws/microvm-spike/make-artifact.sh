#!/usr/bin/env bash
# Assemble the code artifact for the Lambda MicroVM spike (decision 0007):
# a zip with a Dockerfile at its root that builds
#   1. the sandbox rootfs, from sandbox/Dockerfile (stage "sandbox"), and
#   2. an Amazon Linux 2023 MicroVM image with runsc, Node, the repository at
#      HEAD and that rootfs, which runs spike.sh when the MicroVM starts.
#
#   deploy/aws/microvm-spike/make-artifact.sh OUT.zip
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$(realpath -m "${1:?out.zip}")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# Stage 1: the sandbox Dockerfile as is, minus the build-secret mounts (they only
# pass a proxy CA, which the MicroVM image builder does not need), its final
# stage named "sandbox".
sed -e 's/--mount=type=secret,id=ca,required=false //' \
    -e 's/^FROM \${BASE_IMAGE}$/FROM ${BASE_IMAGE} AS sandbox/' \
    "$repo/sandbox/Dockerfile" > "$tmp/Dockerfile"
grep -q 'AS sandbox$' "$tmp/Dockerfile" || { echo "sandbox stage not found" >&2; exit 1; }
grep -q -- '--mount=type=secret' "$tmp/Dockerfile" && { echo "secret mount left" >&2; exit 1; }
cat "$here/Dockerfile.microvm" >> "$tmp/Dockerfile"

cp "$repo/sandbox/python-packages.txt" "$repo/sandbox/npm-packages.txt" \
   "$repo/sandbox/install-runsc.sh" "$here/runner.mjs" "$here/spike.sh" "$here/image.json" "$tmp/"
mkdir "$tmp/src"
git -C "$repo" archive HEAD | tar -x -C "$tmp/src"
git -C "$repo" rev-parse HEAD > "$tmp/src/COMMIT"
(cd "$tmp" && rm -f "$out" && zip -qr "$out" .)
echo "$out $(du -h "$out" | cut -f1) $(sha256sum "$out" | cut -d' ' -f1)"
