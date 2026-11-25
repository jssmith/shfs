#!/usr/bin/env bash
# Install gVisor's runsc and its sidecar binaries.
#
# Since late 2026 runsc ships as one archive, gvisor.tar.bz2, holding `runsc`
# and a `gvisor-bin/` directory (gvisor_sentry and helpers). runsc looks for the
# sidecars in gvisor-bin next to itself (or in $GVISOR_SIDECAR_BINARIES_DIR);
# a lone runsc binary fails with: sidecar "gvisor_sentry" not usable.
#
#   sandbox/install-runsc.sh [dest-dir]     (default /usr/local/bin)
#   GVISOR_RELEASE=release-20261123.0 sandbox/install-runsc.sh   (pin a release)
set -euo pipefail

dest="${1:-/usr/local/bin}"
release="${GVISOR_RELEASE:-latest}"
arch="$(uname -m)"
url="https://storage.googleapis.com/gvisor/releases/release/${release}/${arch}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
curl -fsSL --retry 3 -o gvisor.tar.bz2 "$url/gvisor.tar.bz2"
curl -fsSL --retry 3 -o gvisor.tar.bz2.sha512 "$url/gvisor.tar.bz2.sha512"
sha512sum -c gvisor.tar.bz2.sha512
tar -xjf gvisor.tar.bz2

mkdir -p "$dest"
install -m 0755 runsc "$dest/runsc"
install -m 0755 containerd-shim-runsc-v1 "$dest/containerd-shim-runsc-v1"
rm -rf "$dest/gvisor-bin.new"
mkdir -p "$dest/gvisor-bin.new"
install -m 0755 gvisor-bin/* "$dest/gvisor-bin.new/"
rm -rf "$dest/gvisor-bin"
mv "$dest/gvisor-bin.new" "$dest/gvisor-bin"
"$dest/runsc" --version
