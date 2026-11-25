#!/usr/bin/env bash
# Builds the benchmark sandbox root file system: a copy of an exported python:3.12-slim
# image (the source is never modified) plus the host's git and ripgrep with their libraries.
# Usage: make-rootfs.sh <source rootfs> <dest dir>
set -euo pipefail
src=$1
dst=$2
rm -rf "$dst"
mkdir -p "$dst"
cp -a "$src" "$dst/rootfs"
r=$dst/rootfs
mkdir -p "$r/opt/a2/bin" "$r/opt/a2/lib" "$r/drive" "$r/plain" "$r/work"
for b in /usr/bin/git /usr/bin/rg; do
  cp "$b" "$r/opt/a2/bin/"
  for lib in $(ldd "$b" | awk '/=>/ && $1 != "libc.so.6" {print $3}'); do
    cp --update=none "$lib" "$r/opt/a2/lib/"
  done
done
for b in git rg; do
  cat > "$r/usr/local/bin/$b" <<EOF
#!/bin/sh
LD_LIBRARY_PATH=/opt/a2/lib exec /opt/a2/bin/$b "\$@"
EOF
  chmod +x "$r/usr/local/bin/$b"
done
echo "rootfs ready at $r"
