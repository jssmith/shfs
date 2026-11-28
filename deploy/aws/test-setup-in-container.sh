#!/usr/bin/env bash
# Run setup.sh in a fresh Debian 13 container, as close to a new VM as a
# container gets: a loop device stands in for the EBS data volume, the host's
# Docker daemon builds the sandbox image, and there is no systemd (units are
# written, not enabled). Removes the container and the loop device at the end;
# the log stays in $OUT.
#
#   deploy/aws/test-setup-in-container.sh            # log in $OUT/setup.log
# Environment: NAME (a3-setup-test), OUT (/tmp/a3-data/setup-test), SKIP_STEPS
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="${NAME:-a3-setup-test}"
out="${OUT:-/tmp/a3-data/setup-test}"
image="${IMAGE:-public.ecr.aws/docker/library/debian:trixie}"
mkdir -p "$out"

# A 4 GB sparse file as the "data volume".
truncate -s 4G "$out/data.img"
loop=$(losetup --find --show "$out/data.img")
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  losetup -d "$loop" 2>/dev/null || true
}
trap cleanup EXIT

# The checkout without node_modules or build output, as a clone would be.
tar -C "$repo" --exclude=node_modules --exclude=dist --exclude='*.tsbuildinfo' --exclude=.git -cf "$out/repo.tar" .

env_args=()
for v in HTTPS_PROXY https_proxy NO_PROXY no_proxy; do
  [ -n "${!v:-}" ] && env_args+=(-e "$v=${!v}")
done
ca="${SSL_CERT_FILE:-}"
if [ -n "$ca" ] && [ -f "$ca" ]; then
  env_args+=(-v "$ca:/etc/a3-ca.pem:ro" -e SSL_CERT_FILE=/etc/a3-ca.pem -e CURL_CA_BUNDLE=/etc/a3-ca.pem
             -e NODE_EXTRA_CA_CERTS=/etc/a3-ca.pem -e BUILD_CA_FILE=/etc/a3-ca.pem)
fi

docker rm -f "$name" >/dev/null 2>&1 || true
start=$(date +%s)
set +e
docker run --name "$name" --network host --privileged \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$out/repo.tar:/repo.tar:ro" \
  --device "$loop" \
  -e DATA_DEVICE="$loop" -e NAME_PREFIX=a3-ct- \
  -e SKIP_STEPS="${SKIP_STEPS:-}" \
  "${env_args[@]}" \
  "$image" bash -c '
    set -e
    mkdir -p /opt/agent-drive && tar -xf /repo.tar -C /opt/agent-drive
    exec /opt/agent-drive/deploy/aws/setup.sh' > "$out/setup.log" 2>&1
status=$?
set -e
echo "setup.sh exit $status after $(( $(date +%s) - start ))s; log: $out/setup.log"
grep -E '^\[setup\]' "$out/setup.log" || true
tail -12 "$out/setup.log"
exit $status
