#!/usr/bin/env bash
# Package the trigger function: index.mjs plus its two SDK clients.
#   deploy/aws/trigger/make-zip.sh OUT.zip
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(realpath -m "${1:?out.zip}")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp "$here/index.mjs" "$here/package.json" "$here/package-lock.json" "$tmp/"
(cd "$tmp" && npm ci --omit=dev --no-fund --no-audit -q && rm -f package-lock.json && zip -qr "$out" .)
echo "$out $(du -h "$out" | cut -f1) $(sha256sum "$out" | cut -d' ' -f1)"
