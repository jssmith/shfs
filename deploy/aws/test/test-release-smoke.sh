#!/usr/bin/env bash
# Package this checkout with ci.sh, deploy the package with deploy-release.sh
# (stub aws; a stub systemctl that starts the real server from
# $root/current), and check that the release answers /healthz. Shows that a
# release holds everything the server needs to run. setup.sh is not run (its
# provisioning hash is recorded as applied), so nothing is installed here.
#
#   npm ci && npm run build && deploy/aws/test/test-release-smoke.sh
#
# Port PORT (default 9931). No root needed.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
port="${PORT:-9931}"
w="$(mktemp -d "${TMPDIR:-/tmp}/a9-release-smoke.XXXXXX")"
export W="$w"
stop_server() { pkill -f "$w/root/current/server" 2>/dev/null || true; }
trap 'stop_server; rm -rf "$w"' EXIT
mkdir -p "$w/bin" "$w/data"
v=$(printf 'a9%038d' 1)

[ -f "$repo/server/dist/main.js" ] || { echo "build first: npm ci && npm run build" >&2; exit 1; }
CODEBUILD_RESOLVED_SOURCE_VERSION="$v" "$repo/deploy/aws/ci.sh" package "$w/out" > "$w/package.log" 2>&1 \
  || { cat "$w/package.log"; exit 1; }
# A key pair standing in for KMS; sign the manifest's digest as KMS does.
openssl ecparam -name prime256v1 -genkey -noout -out "$w/k.pem" 2>/dev/null
openssl pkey -in "$w/k.pem" -pubout -outform DER -out "$w/k.der"
openssl dgst -sha256 -sign "$w/k.pem" -out "$w/out/manifest.sig" "$w/out/manifest.json"
mkdir -p "$w/s3/releases/$v" && cp "$w/out/"* "$w/s3/releases/$v/"

cat > "$w/bin/aws" <<'EOF'
#!/usr/bin/env bash
args=(); while [ $# -gt 0 ]; do case "$1" in --region) shift 2 ;; *) args+=("$1"); shift ;; esac; done; set -- "${args[@]}"
case "$1 $2" in
  "s3api get-object") cp "$W/s3/$6" "$7" ;;   # get-object --bucket B --key K OUT
  "kms get-public-key") base64 -w0 "$W/k.der" ;;
  *) exit 1 ;;
esac
EOF
cat > "$w/bin/systemctl" <<EOF
#!/usr/bin/env bash
case "\$1" in
  restart)
    pkill -f "$w/root/current/server" || true
    (AGENT_DRIVE_DATA="$w/data" AGENT_DRIVE_PORT=$port AGENT_DRIVE_RUNSC=none setsid \\
      node --disable-warning=ExperimentalWarning "$w/root/current/server/dist/main.js" serve \\
      > "$w/server.log" 2>&1 < /dev/null &) ;;
  is-active) pgrep -f "$w/root/current/server" >/dev/null ;;
esac
EOF
chmod +x "$w/bin/"*
export PATH="$w/bin:$PATH"

mkdir -p "$w/state"
jq -r .provision_sha256 "$w/out/manifest.json" > "$w/state/provision.sha256"
DEPLOY_ROOT="$w/root" DEPLOY_STATE="$w/state" DEPLOY_LOG="$w/deploy.log" DEPLOY_ALLOW_NONROOT=1 \
  HEALTH_URL="http://127.0.0.1:$port/healthz" HEALTH_TIMEOUT=30 HEALTH_INTERVAL=0.5 \
  "$repo/deploy/aws/deploy-release.sh" --version "$v" --bucket a9-bucket --key-id k --region us-east-2 \
  || { echo "--- server log"; cat "$w/server.log" 2>/dev/null; exit 1; }
echo "healthz: $(curl -fsS "http://127.0.0.1:$port/healthz")"
echo "release size: $(du -h "$w/out/release.tar.zst" | cut -f1); smoke test passed"
