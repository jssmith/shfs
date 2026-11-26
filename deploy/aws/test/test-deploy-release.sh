#!/usr/bin/env bash
# Local test of the release path without AWS: ci.sh archive/publish on the
# build side and deploy-release.sh on the VM side, with stub `aws`, `systemctl`
# and `curl` commands. A directory stands in for S3; an ECDSA P-256 key pair
# made here with openssl stands in for the KMS signing key (KMS signs the
# SHA-256 digest with ECDSA and returns a DER signature, which is what
# `openssl dgst -sha256 -sign` produces, so verification is real crypto).
#
#   deploy/aws/test/test-deploy-release.sh        (no root needed)
#
# The stub server's health comes from the release itself: a release whose
# HEALTH file says "bad" fails /healthz, so a failed deploy can be staged.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
aws_dir="$(cd "$here/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/a9-deploy-test.XXXXXX")"
trap '[ -n "${KEEP_WORK:-}" ] || rm -rf "$work"' EXIT

pass=0 failures=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$*"; }
bad() { failures=$((failures + 1)); printf 'FAIL %s\n' "$*"; }
fails() { ! "$@"; }
quiet_fails() { ! "$@" >/dev/null 2>&1; }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

# --- fake KMS key, fake S3, stubs --------------------------------------------
openssl ecparam -name prime256v1 -genkey -noout -out "$work/kms.pem" 2>/dev/null
openssl pkey -in "$work/kms.pem" -pubout -outform DER -out "$work/kms.pub.der"
openssl ecparam -name prime256v1 -genkey -noout -out "$work/other.pem" 2>/dev/null
mkdir -p "$work/s3/a9-bucket" "$work/bin" "$work/vm"
export FAKE="$work"

cat > "$work/bin/aws" <<'EOF'
#!/usr/bin/env bash
# Stub AWS CLI: the few calls ci.sh and deploy-release.sh make.
set -euo pipefail
echo "aws $*" >> "$FAKE/aws.log"
args=()
while [ $# -gt 0 ]; do case "$1" in --region) shift 2 ;; *) args+=("$1"); shift ;; esac; done
set -- "${args[@]}"
opt() { local k="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$k" ] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
  "s3api get-object")
    src="$FAKE/s3/$(opt --bucket "$@")/$(opt --key "$@")"
    [ -f "$src" ] || { echo "An error occurred (NoSuchKey)" >&2; exit 254; }
    cp "$src" "${!#}" ;;
  "s3api put-object")
    [ "$(opt --if-none-match "$@")" = "*" ] || { echo "stub: put-object without --if-none-match" >&2; exit 1; }
    dst="$FAKE/s3/$(opt --bucket "$@")/$(opt --key "$@")"
    [ -e "$dst" ] && { echo "An error occurred (PreconditionFailed)" >&2; exit 254; }
    mkdir -p "$(dirname "$dst")"; body=$(opt --body "$@"); cp "$body" "$dst"; echo '"etag"' ;;
  "kms get-public-key") base64 -w0 "$FAKE/kms.pub.der"; echo ;;
  "kms sign")
    msg=$(opt --message "$@"); msg="${msg#fileb://}"
    [ "$(opt --message-type "$@")" = DIGEST ] || exit 1
    # Sign the given digest as-is (what KMS does for MessageType DIGEST).
    openssl pkeyutl -sign -inkey "$FAKE/kms.pem" -in "$msg" | base64 -w0; echo ;;
  "ssm send-command")
    echo "$*" > "$FAKE/send-command"; echo "cmd-0001" ;;
  "ssm list-command-invocations")
    if [[ " $* " == *" --details "* ]]; then printf 'i-0123\t%s\tdeploy output\n' "$(cat "$FAKE/ssm-status")"
    else cat "$FAKE/ssm-status"; fi ;;
  *) echo "stub aws: unexpected call: $*" >&2; exit 1 ;;
esac
EOF

cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE/systemctl.log"
case "$1" in
  restart) readlink "$DEPLOY_ROOT/current" > "$FAKE/running" 2>/dev/null || : > "$FAKE/running" ;;
  stop) : > "$FAKE/running" ;;
  is-active) [ -s "$FAKE/running" ] ;;
esac
EOF

cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
# Stub /healthz: answers for whatever release was running at the last restart.
run=$(cat "$FAKE/running" 2>/dev/null || true)
[ -n "$run" ] && [ "$(cat "$DEPLOY_ROOT/$run/HEALTH" 2>/dev/null)" = ok ] || exit 7
echo '{"ok":true,"version":"0.0.0"}'
EOF
for c in apt-get snap; do printf '#!/bin/sh\necho "stub: %s must not run" >&2; exit 1\n' "$c" > "$work/bin/$c"; done
chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"

export DEPLOY_ROOT="$work/vm/root" DEPLOY_STATE="$work/vm/state" DEPLOY_LOG="$work/vm/deploy.log"
export HEALTH_TIMEOUT=2 HEALTH_INTERVAL=0.2 DEPLOY_ALLOW_NONROOT=1
export ARTIFACT_BUCKET=a9-bucket SIGNING_KEY_ARN=arn:aws:kms:us-east-2:111122223333:key/test DEPLOY_POLL_SECONDS=0

# --- releases ---------------------------------------------------------------
sha_for() { printf '%040x' "$1"; }
# make_release <n> [health=ok] [setup variant=1]: stage a tree, archive it with
# ci.sh archive, sign and upload with ci.sh publish (stub S3/KMS/SSM).
make_release() {
  local v; v=$(sha_for "$1")
  local stage="$work/stage-$1" out="$work/out-$1"
  rm -rf "$stage" "$out"; mkdir -p "$stage/deploy/aws/systemd" "$stage/sandbox" "$stage/server/dist"
  echo "${2:-ok}" > "$stage/HEALTH"
  echo 'console.log("server")' > "$stage/server/dist/main.js"
  cat > "$stage/deploy/aws/setup.sh" <<EOF
#!/usr/bin/env bash
# variant ${3:-1}
echo "\$AGENT_DRIVE_HOME \$(jq -r .version "\$(dirname "\$0")/../../RELEASE")" >> "$FAKE/setup-runs"
EOF
  echo "unit" > "$stage/deploy/aws/systemd/agent-drive.service"
  echo "FROM scratch ${4:-}" > "$stage/sandbox/Dockerfile"
  BUILD_SOURCE_VERSION="$v" BUILD_ID="a9-test:$1" "$aws_dir/ci.sh" archive "$stage" "$out" >/dev/null
  echo Success > "$work/ssm-status"
  "$aws_dir/ci.sh" publish "$out" > "$work/publish-$1.log" 2>&1
}

deploy() { # <n> -> exit status of deploy-release.sh
  "$aws_dir/deploy-release.sh" --version "$(sha_for "$1")" --bucket a9-bucket --key-id "$SIGNING_KEY_ARN" --region us-east-2 \
    > "$work/deploy-$1.log" 2>&1
}
current() { readlink "$DEPLOY_ROOT/current" 2>/dev/null || echo none; }
setup_runs() { wc -l < "$work/setup-runs" 2>/dev/null || echo 0; }
nreleases() { find "$DEPLOY_ROOT/releases" -mindepth 1 -maxdepth 1 -type d | wc -l; }

# 1. good release
make_release 1
check "publish uploads archive, signature, manifest" test -f "$work/s3/a9-bucket/releases/$(sha_for 1)/manifest.sig"
check "publish sends AgentDrive-Deploy with only Version" grep -q -- "--document-name AgentDrive-Deploy --targets Key=tag:agent-drive,Values=dev --parameters Version=$(sha_for 1)" "$work/send-command"
check "good release deploys" deploy 1
check "current points at release 1" test "$(current)" = "releases/$(sha_for 1)"
check "setup.sh ran once, with AGENT_DRIVE_HOME=current" grep -qx "$DEPLOY_ROOT/current $(sha_for 1)" "$work/setup-runs"
check "service restarted" grep -q "systemctl restart agent-drive.service" "$work/systemctl.log"
check "log written" grep -q "manifest signature verified" "$DEPLOY_LOG"
check "manifest kept with the release" test -f "$DEPLOY_ROOT/releases/$(sha_for 1)/manifest.json"

# 2. never overwrite a release
out1="$work/out-1"
check "publish refuses to overwrite an existing release" quiet_fails "$aws_dir/ci.sh" publish "$out1"

# 3. same provisioning: setup.sh not rerun
make_release 2
check "second release deploys" deploy 2
check "setup.sh not rerun when unchanged" test "$(setup_runs)" = 1
check "current points at release 2" test "$(current)" = "releases/$(sha_for 2)"

# 4. changed setup.sh, or a changed sandbox file: rerun
make_release 3 ok 2
check "release with changed setup.sh deploys" deploy 3
check "setup.sh rerun when changed" test "$(setup_runs)" = 2
make_release 4 ok 2 "changed"
deploy 4
check "setup.sh rerun when the sandbox image changed" test "$(setup_runs)" = 3

# 5. bad signature: signed by another key
make_release 5
v5="$work/s3/a9-bucket/releases/$(sha_for 5)"
openssl dgst -sha256 -sign "$work/other.pem" -out "$v5/manifest.sig" "$v5/manifest.json"
check "bad signature refused" fails deploy 5
check "bad signature: reason logged" grep -q "signature does not verify" "$work/deploy-5.log"
check "bad signature: current unchanged" test "$(current)" = "releases/$(sha_for 4)"
check "bad signature: nothing unpacked" test ! -e "$DEPLOY_ROOT/releases/$(sha_for 5)"

# 6. tampered manifest (signature no longer matches)
make_release 6
sed -i 's/"format": 1/"format": 1, "x": 1/' "$work/s3/a9-bucket/releases/$(sha_for 6)/manifest.json"
check "tampered manifest refused" fails deploy 6

# 7. bad checksum: archive replaced after signing
make_release 7
printf 'garbage' > "$work/s3/a9-bucket/releases/$(sha_for 7)/release.tar.zst"
check "bad checksum refused" fails deploy 7
check "bad checksum: reason logged" grep -q "does not match the manifest" "$work/deploy-7.log"
check "bad checksum: current unchanged" test "$(current)" = "releases/$(sha_for 4)"

# 8. a valid signed manifest copied under another version's path
mkdir -p "$work/s3/a9-bucket/releases/$(sha_for 8)"
cp "$work/s3/a9-bucket/releases/$(sha_for 1)/"* "$work/s3/a9-bucket/releases/$(sha_for 8)/"
check "manifest for another version refused" fails deploy 8

# 9. failed health check rolls back
make_release 9 bad
restarts_before=$(grep -c restart "$work/systemctl.log")
check "unhealthy release fails" fails deploy 9
check "unhealthy: current rolled back to release 4" test "$(current)" = "releases/$(sha_for 4)"
check "unhealthy: restarted twice (new, then previous)" test "$(( $(grep -c restart "$work/systemctl.log") - restarts_before ))" = 2
check "unhealthy: previous release running again" test "$(cat "$work/running")" = "releases/$(sha_for 4)"
check "unhealthy: failed release removed" test ! -e "$DEPLOY_ROOT/releases/$(sha_for 9)"
check "unhealthy: rollback logged" grep -q "rolled back; releases/$(sha_for 4) is healthy" "$work/deploy-9.log"

# 10. bad version strings never reach S3
check "non-sha version refused" quiet_fails "$aws_dir/deploy-release.sh" --version "main; rm -rf /" --bucket a9-bucket --key-id k

# 11. redeploying the current release restarts it in place
runs_before=$(setup_runs)
check "redeploy of current release" deploy 4
check "redeploy after the unhealthy release reapplies its setup.sh" test "$(setup_runs)" = $((runs_before + 1))
check "redeploy: still current" test "$(current)" = "releases/$(sha_for 4)"

# 12. rollback by hand: deploy an older, retained version
check "deploy older release 2 again" deploy 2
check "older release is current" test "$(current)" = "releases/$(sha_for 2)"
check "older release with older setup.sh reruns setup" test "$(tail -1 "$work/setup-runs")" = "$DEPLOY_ROOT/current $(sha_for 2)"

# 13. pruning keeps 5
for i in 10 11 12 13 14 15; do make_release "$i"; deploy "$i" || bad "deploy $i"; done
check "pruning keeps 5 releases" test "$(nreleases)" = 5
check "current is release 15" test "$(current)" = "releases/$(sha_for 15)"
check "oldest pruned" test ! -e "$DEPLOY_ROOT/releases/$(sha_for 2)"

# 14. first deploy that fails health leaves no current
export DEPLOY_ROOT="$work/vm2/root" DEPLOY_STATE="$work/vm2/state"
make_release 16 bad
check "first deploy, unhealthy, fails" fails deploy 16
check "first deploy failed: no current" test "$(current)" = none

# 15. publish fails the build when the deploy fails
make_release 17 || true
echo Failed > "$work/ssm-status"
BUILD_SOURCE_VERSION=$(sha_for 18) "$aws_dir/ci.sh" archive "$work/stage-17" "$work/out-18" >/dev/null
check "publish fails when the deploy failed" quiet_fails "$aws_dir/ci.sh" publish "$work/out-18"

echo
echo "$pass passed, $failures failed"
[ "$failures" = 0 ]
