#!/usr/bin/env bash
# Build the session sandbox root file system as a plain directory tree at
#   $AGENT_DRIVE_DATA/images/<name>/rootfs   (name defaults to "default")
# plus image.json next to it (the environment a session should be started with).
#
# Uses Docker only as a build tool: the image is exported and flattened, and the
# result is run by runsc, never by Docker. Base images come from public.ecr.aws.
#
# Environment:
#   AGENT_DRIVE_DATA   required; the data directory (contracts §1)
#   IMAGE_NAME         default "default"
#   NAME_PREFIX        prefix for the Docker image tag and the export container
#                      (default "agent-drive-"; on the shared dev machine use "a3-")
#   HTTPS_PROXY, NO_PROXY   passed to the build when set
#   BUILD_CA_FILE      a CA bundle the build should trust (e.g. an egress proxy's);
#                      given as a BuildKit secret, so it is not written into the image.
#                      Defaults to $SSL_CERT_FILE when that is set.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${AGENT_DRIVE_DATA:?set AGENT_DRIVE_DATA}"
name="${IMAGE_NAME:-default}"
prefix="${NAME_PREFIX:-agent-drive-}"
tag="${prefix}sandbox:${name}"
dest="$AGENT_DRIVE_DATA/images/$name"
ca="${BUILD_CA_FILE:-${SSL_CERT_FILE:-}}"

log() { printf '[sandbox/build] %s\n' "$*" >&2; }

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable; start it (e.g. 'dockerd &' or 'systemctl start docker')." >&2
  exit 1
fi

args=(build --network host -t "$tag" -f "$here/Dockerfile")
[ -n "${HTTPS_PROXY:-}" ] && args+=(--build-arg "HTTPS_PROXY=$HTTPS_PROXY")
[ -n "${NO_PROXY:-}" ] && args+=(--build-arg "NO_PROXY=$NO_PROXY")
[ -n "$ca" ] && [ -f "$ca" ] && args+=(--secret "id=ca,src=$ca")

log "building $tag"
start=$(date +%s)
DOCKER_BUILDKIT=1 docker "${args[@]}" "$here"
log "built in $(( $(date +%s) - start ))s"

mkdir -p "$dest"
tmp="$dest/rootfs.new"
rm -rf "$tmp" && mkdir -p "$tmp"
cid=$(docker create --name "${prefix}sandbox-export-$$" "$tag" /bin/true)
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
log "exporting to $tmp"
docker export "$cid" | tar -x -C "$tmp" --numeric-owner
rm -f "$tmp/.dockerenv"
# Docker writes these at container start; give them sane static contents.
printf '127.0.0.1 localhost\n::1 localhost\n' > "$tmp/etc/hosts"
: > "$tmp/etc/resolv.conf"
echo sandbox > "$tmp/etc/hostname"

# The environment and user a session should run with; the server reads this
# when it writes the OCI config.json for a session.
cat > "$dest/image.json.new" <<EOF
{
  "name": "$name",
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "docker_image_id": "$(docker image inspect -f '{{.Id}}' "$tag")",
  "user": { "uid": 1000, "gid": 1000 },
  "cwd": "/work",
  "env": [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/home/agent",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "TZ=UTC",
    "NODE_PATH=/usr/local/lib/node_modules"
  ],
  "mounts": { "drive": "/drive", "work": "/work" }
}
EOF

# Swap in atomically-ish: the old tree is kept until the new one is in place.
if [ -d "$dest/rootfs" ]; then mv "$dest/rootfs" "$dest/rootfs.old"; fi
mv "$tmp" "$dest/rootfs"
mv "$dest/image.json.new" "$dest/image.json"
rm -rf "$dest/rootfs.old"

size=$(du -sh --apparent-size "$dest/rootfs" | cut -f1)
log "rootfs at $dest/rootfs ($size)"
