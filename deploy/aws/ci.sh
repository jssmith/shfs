#!/usr/bin/env bash
# The build steps. The builder MicroVM runs them from the commit it builds
# (deploy/aws/builder/run.sh); they also run on any Linux machine with the tools.
#
#   deploy/aws/ci.sh install            Node 22, system packages, runsc, Docker daemon
#   deploy/aws/ci.sh smoke ROOTFS       start one gVisor sandbox with debug logs
#   deploy/aws/ci.sh test               npm ci, build, sandbox rootfs, npm test (gVisor tests included)
#   deploy/aws/ci.sh package <out>      release.tar.zst + manifest.json in <out>
#   deploy/aws/ci.sh archive <stage> <out>   (the second half of package: archive a staged tree)
#   deploy/aws/ci.sh publish <out>      sign the manifest with KMS, upload to S3 (never
#                                       overwriting), run AgentDrive-Deploy on the dev VM, wait
#
# Environment (the builder MicroVM sets these; deploy/aws/builder/run.sh):
#   BUILD_SOURCE_VERSION   the commit; it is the release version
#   BUILD_ID, BUILD_ARN    recorded in the manifest; SOURCE_URL (default github.com/jssmith/shfs)
#   ARTIFACT_BUCKET, SIGNING_KEY_ARN, DEPLOY_DOCUMENT (AgentDrive-Deploy),
#   DEPLOY_TAG_VALUE (dev), AWS_REGION
#   AGENT_DRIVE_ROOTFS     a ready sandbox rootfs; unset, test builds one with Docker
#   TEST_MAX_WORKERS       cap on vitest's parallel workers (the builder sets 4)
#   GVISOR_TESTS   run (default) | skip   skip leaves AGENT_DRIVE_RUNSC unset, so the
#                                         gVisor e2e suites skip themselves
#   DEPLOY_WAIT_SECONDS  how long to wait for the deploy (default 2400)
# No secrets: AWS access is the build machine's role, inside the AWS CLI.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${NODE_MAJOR:=22}"
: "${CI_DATA:=$repo/../ci-data}"
log() { printf '\n[ci] %s\n' "$*"; }

sha256() { sha256sum "$1" | cut -d' ' -f1; }

# What setup.sh installs from a release: if none of these change, the VM does
# not rerun setup.sh. Paths are relative to the release root.
provision_hash() { # release-root
  (cd "$1" && find deploy/aws/setup.sh deploy/aws/systemd deploy/cloudflare sandbox -type f -print0 2>/dev/null \
    | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
}

c_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q --no-install-recommends \
    ca-certificates curl jq zstd xz-utils bzip2 \
    tesseract-ocr tesseract-ocr-eng poppler-utils imagemagick fuse3
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
    local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp file
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
    file=$(grep -o "node-v[0-9.]*-linux-x64.tar.xz" "$tmp/SHASUMS256.txt" | head -1)
    curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file"
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
    mkdir -p /opt/node
    tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
    rm -rf "$tmp"
  fi
  "$repo/sandbox/install-runsc.sh" /usr/local/bin
  if ! docker info >/dev/null 2>&1; then
    log "starting dockerd"
    (nohup dockerd > /var/log/dockerd.log 2>&1 &)
    for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
    docker info >/dev/null
  fi
}

node_path() { [ -x /opt/node/bin/node ] && export PATH="/opt/node/bin:$PATH"; node -v; }

# Start one sandbox the way the server does (runsc.ts), bounded and with debug
# logs, so a CI host where gVisor hangs says why instead of timing out tests.
c_smoke() { # rootfs
  local rootfs="$1" dir platform ok=0
  dir="$(mktemp -d)"
  for platform in systrap ptrace; do
    rm -rf "$dir/$platform"; mkdir -p "$dir/$platform/bundle" "$dir/$platform/state" "$dir/$platform/log"
    cat > "$dir/$platform/bundle/config.json" <<JSON
{"ociVersion":"1.0.0","process":{"args":["/bin/echo","sandbox-ok"],"cwd":"/","env":["PATH=/usr/bin:/bin"],"user":{"uid":0,"gid":0}},
 "root":{"path":"$rootfs","readonly":true},"hostname":"ci-smoke",
 "mounts":[{"destination":"/proc","type":"proc","source":"proc"},{"destination":"/tmp","type":"tmpfs","source":"tmpfs"}],
 "linux":{"namespaces":[{"type":"pid"},{"type":"mount"},{"type":"ipc"},{"type":"uts"}]}}
JSON
    log "runsc smoke ($platform)"
    local t0=$SECONDS out rc=0
    out="$(timeout -s KILL 30 runsc --root "$dir/$platform/state" --debug --debug-log="$dir/$platform/log/" \
      --network=none --platform="$platform" --file-access-mounts=shared \
      run -bundle "$dir/$platform/bundle" "ci-smoke-$platform" 2>&1)" || rc=$?
    log "runsc smoke ($platform): exit $rc in $((SECONDS - t0))s: ${out:0:200}"
    if [ "$rc" = 0 ] && [[ "$out" == *sandbox-ok* ]]; then
      [ "$platform" = systrap ] && ok=1
    else
      log "runsc debug logs ($platform), last lines of each:"
      for f in "$dir/$platform/log/"*; do [ -f "$f" ] && { echo "--- $(basename "$f")"; tail -n 25 "$f"; }; done
    fi
    timeout 10 runsc --root "$dir/$platform/state" delete --force "ci-smoke-$platform" >/dev/null 2>&1 || true
    umount "$dir/$platform/state/null-netns" 2>/dev/null || true
    [ "$ok" = 1 ] && break
  done
  rm -rf "$dir"
  [ "$ok" = 1 ]
}

c_test() {
  node_path
  cd "$repo"
  # Parallel gVisor suites need more than a container's usual 1024 open files
  # ("creating fd map: ... too many open files" otherwise; decision 0007).
  # Raising the hard limit needs CAP_SYS_RESOURCE, which build machines have.
  ulimit -Hn 65536 2>/dev/null || true
  ulimit -Sn "$(( $(ulimit -Hn) < 8192 ? $(ulimit -Hn) : 8192 ))" 2>/dev/null || true
  log "open files: $(ulimit -Sn) soft, $(ulimit -Hn) hard"
  npm ci --no-fund --no-audit
  npm run build
  if [ "${GVISOR_TESTS:-run}" = run ]; then
    export AGENT_DRIVE_RUNSC="${AGENT_DRIVE_RUNSC:-/usr/local/bin/runsc}"
    if [ -n "${AGENT_DRIVE_ROOTFS:-}" ] && [ -d "$AGENT_DRIVE_ROOTFS" ]; then
      # The builder image holds a rootfs built from sandbox/ (deploy/aws/builder).
      log "using the sandbox rootfs at $AGENT_DRIVE_ROOTFS"
    else
      log "building the sandbox rootfs for the gVisor tests"
      AGENT_DRIVE_DATA="$CI_DATA" NAME_PREFIX=ci- "$repo/sandbox/build.sh"
      export AGENT_DRIVE_ROOTFS="$CI_DATA/images/default/rootfs"
    fi
    export AGENT_DRIVE_TEST_IMAGE_ROOTFS="$AGENT_DRIVE_ROOTFS"
    c_smoke "$AGENT_DRIVE_ROOTFS" || { log "runsc smoke failed with systrap: see the logs above"; exit 1; }
  else
    log "GVISOR_TESTS=$GVISOR_TESTS: gVisor suites will skip"
  fi
  export AGENT_DRIVE_TEST_PREFIX=ci
  # TEST_MAX_WORKERS: the builder MicroVM shows 16 vCPUs (its 4x peak) but is
  # guaranteed only its 4-vCPU baseline; vitest's default of one worker per
  # CPU then overloads it and the gVisor suites hit their timeouts.
  if [ -n "${TEST_MAX_WORKERS:-}" ]; then npm test -- --maxWorkers="$TEST_MAX_WORKERS"; else npm test; fi
}

c_package() { # out
  local out="$1" stage
  node_path
  stage=$(mktemp -d)
  cd "$repo"
  cp package.json package-lock.json "$stage/"
  for w in server cli test; do mkdir -p "$stage/$w" && cp "$w/package.json" "$stage/$w/"; done
  cp -r server/dist "$stage/server/" && cp -r cli/dist "$stage/cli/"
  find "$stage" -name '*.tsbuildinfo' -delete
  # Data files the server reads from src/ at run time (word lists, schemas).
  find server/src cli/src -type f ! -name '*.ts' -exec cp --parents {} "$stage/" \;
  (cd "$stage" && npm ci --omit=dev --ignore-scripts --no-fund --no-audit)
  rm -rf "$stage/test"; rm -f "$stage/node_modules/@agent-drive/test"
  mkdir -p "$stage/deploy" && cp -r deploy/aws deploy/cloudflare "$stage/deploy/"
  rm -rf "$stage/deploy/aws/test"
  cp -r sandbox "$stage/"
  c_archive "$stage" "$out"
  rm -rf "$stage"
}

c_archive() { # stage out
  local stage="$1" out="$2" version="${BUILD_SOURCE_VERSION:-}"
  [[ "$version" =~ ^[0-9a-f]{40}$ ]] || { echo "BUILD_SOURCE_VERSION is not a git sha: '$version'" >&2; exit 1; }
  mkdir -p "$out"
  local built; built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n --arg v "$version" --arg b "$built" '{version: $v, built_at: $b}' > "$stage/RELEASE"
  tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner -cf - . | zstd -q -10 -T0 -o "$out/release.tar.zst"
  local nodev=""; command -v node >/dev/null && nodev=$(node -v)
  jq -n --arg v "$version" --arg id "${BUILD_ID:-local}" --arg arn "${BUILD_ARN:-}" --arg src "${SOURCE_URL:-https://github.com/jssmith/shfs}" \
    --arg b "$built" --arg node "$nodev" --arg a "$(sha256 "$out/release.tar.zst")" \
    --argjson size "$(stat -c %s "$out/release.tar.zst")" \
    --arg setup "$(sha256 "$stage/deploy/aws/setup.sh")" --arg prov "$(provision_hash "$stage")" \
    '{format: 1, version: $v, source: $src, build_id: $id, build_arn: $arn,
      built_at: $b, node_version: $node, archive: {name: "release.tar.zst", sha256: $a, size: $size},
      setup_sha256: $setup, provision_sha256: $prov}' > "$out/manifest.json"
  log "release $version: $(du -h "$out/release.tar.zst" | cut -f1)"
  cat "$out/manifest.json"
}

c_publish() { # out
  local out="$1" version
  : "${ARTIFACT_BUCKET:?}" "${SIGNING_KEY_ARN:?}"
  local document="${DEPLOY_DOCUMENT:-AgentDrive-Deploy}" tag="${DEPLOY_TAG_VALUE:-dev}"
  version=$(jq -r .version "$out/manifest.json")
  [[ "$version" =~ ^[0-9a-f]{40}$ ]] || { echo "bad version in manifest" >&2; exit 1; }

  # Sign the manifest's SHA-256 digest; the private key never leaves KMS.
  openssl dgst -sha256 -binary "$out/manifest.json" > "$out/manifest.digest"
  aws kms sign --key-id "$SIGNING_KEY_ARN" --message "fileb://$out/manifest.digest" --message-type DIGEST \
    --signing-algorithm ECDSA_SHA_256 --query Signature --output text | base64 -d > "$out/manifest.sig"
  rm -f "$out/manifest.digest"
  # Check it the way the VM will, before uploading.
  aws kms get-public-key --key-id "$SIGNING_KEY_ARN" --query PublicKey --output text | base64 -d \
    | openssl pkey -pubin -inform DER -out "$out/signing-key.pem"
  openssl dgst -sha256 -verify "$out/signing-key.pem" -signature "$out/manifest.sig" "$out/manifest.json"
  rm -f "$out/signing-key.pem"

  # Upload; If-None-Match makes each put fail if the object exists, so a
  # release is never overwritten. The manifest goes last: once it is there,
  # the release is complete.
  local f
  for f in release.tar.zst manifest.sig manifest.json; do
    log "upload s3://$ARTIFACT_BUCKET/releases/$version/$f"
    aws s3api put-object --bucket "$ARTIFACT_BUCKET" --key "releases/$version/$f" --body "$out/$f" \
      --if-none-match '*' --output text --query ETag >/dev/null \
      || { echo "upload of releases/$version/$f failed (it may exist already; releases are never overwritten)" >&2; exit 1; }
  done
  deploy "$version" "$document" "$tag"
}

deploy() { # version document tag
  local version="$1" document="$2" tag="$3" cmd
  log "running $document Version=$version on instances tagged agent-drive=$tag"
  cmd=$(aws ssm send-command --document-name "$document" --targets "Key=tag:agent-drive,Values=$tag" \
    --parameters "Version=$version" --max-concurrency 1 --max-errors 0 --timeout-seconds 600 \
    --comment "build ${BUILD_ID:-manual}" --query Command.CommandId --output text)
  log "command $cmd"
  local deadline=$((SECONDS + ${DEPLOY_WAIT_SECONDS:-2400})) statuses="" n
  while [ "$SECONDS" -lt "$deadline" ]; do
    sleep "${DEPLOY_POLL_SECONDS:-15}"
    statuses=$(aws ssm list-command-invocations --command-id "$cmd" --query 'CommandInvocations[].Status' --output text)
    n=$(wc -w <<<"$statuses")
    if [ "$n" -gt 0 ] && ! grep -qwE 'Pending|InProgress|Delayed|Cancelling' <<<"$statuses"; then break; fi
    echo "  deploy status: ${statuses:-no invocations yet}"
  done
  aws ssm list-command-invocations --command-id "$cmd" --details \
    --query 'CommandInvocations[].[InstanceId,Status,CommandPlugins[0].Output]' --output text || true
  n=$(wc -w <<<"$statuses")
  if [ "$n" -eq 0 ]; then echo "no instance tagged agent-drive=$tag took the command" >&2; exit 1; fi
  if [ "$(tr -s '[:space:]' '\n' <<<"$statuses" | grep -cvx Success)" != 0 ]; then
    echo "deploy did not succeed: $statuses (full log on the VM: /var/log/agent-drive-deploy.log)" >&2; exit 1
  fi
  log "deployed $version"
}

case "${1:-}" in
  install) c_install ;;
  test) c_test ;;
  smoke) c_smoke "${2:?rootfs dir}" ;;
  package) c_package "${2:?out dir}" ;;
  archive) c_archive "${2:?stage dir}" "${3:?out dir}" ;;
  publish) c_publish "${2:?out dir}" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
