#!/usr/bin/env bash
# Deploy one signed release of Agent Drive on this machine. Runs as root, from
# the SSM document AgentDrive-Deploy (deploy/aws/pipeline.yaml embeds this file
# verbatim; deploy/aws/sync-deploy-document.py keeps the two the same).
#
#   deploy-release.sh --version <git sha> --bucket <bucket> --key-id <kms key arn> [--region <region>]
#
# Steps: fetch releases/<version>/manifest.json and manifest.sig (instance
# role), verify the signature with the KMS public key, download the archive and
# check its sha256, unpack to $root/releases/<version>, run the release's
# deploy/aws/setup.sh when its provisioning hash differs from the last applied
# one, point $root/current at the release, restart agent-drive.service, wait
# for /healthz. On a failure after the switch, point current back at the
# previous release, restart, and exit non-zero. Keeps the last $KEEP releases.
#
# Nothing here is secret and nothing secret is printed: the instance role's
# credentials stay inside the AWS CLI.
#
# Knobs (environment; the defaults are the real machine's, the test overrides them):
#   DEPLOY_ROOT      /opt/agent-drive              releases/ and current live here
#   DEPLOY_STATE     /var/lib/agent-drive/deploy   applied provisioning hash, history
#   DEPLOY_LOG       /var/log/agent-drive-deploy.log
#   HEALTH_URL       http://127.0.0.1:8787/healthz
#   HEALTH_TIMEOUT   180 (seconds)     HEALTH_INTERVAL 2
#   KEEP             5
#   DEPLOY_UNIT      agent-drive.service
set -euo pipefail
umask 022
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
export HOME="${HOME:-/root}"

root="${DEPLOY_ROOT:-/opt/agent-drive}"
state="${DEPLOY_STATE:-/var/lib/agent-drive/deploy}"
logfile="${DEPLOY_LOG:-/var/log/agent-drive-deploy.log}"
health_url="${HEALTH_URL:-http://127.0.0.1:8787/healthz}"
health_timeout="${HEALTH_TIMEOUT:-180}"
health_interval="${HEALTH_INTERVAL:-2}"
keep="${KEEP:-5}"
unit="${DEPLOY_UNIT:-agent-drive.service}"

version="" bucket="" key_id="" region="${AWS_REGION:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --bucket) bucket="${2:-}"; shift 2 ;;
    --key-id) key_id="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ "$version" =~ ^[0-9a-f]{40}$ ]] || { echo "version must be a 40-character git sha, got '$version'" >&2; exit 2; }
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || { echo "bad or missing --bucket" >&2; exit 2; }
[ -n "$key_id" ] || { echo "missing --key-id" >&2; exit 2; }
[ "$(id -u)" = 0 ] || [ -n "${DEPLOY_ALLOW_NONROOT:-}" ] || { echo "run as root" >&2; exit 1; }

mkdir -p "$root/releases" "$state" "$(dirname "$logfile")"
exec > >(tee -a "$logfile") 2>&1

# One deploy at a time.
exec 9>"$state/lock"
flock -w 600 9 || { echo "another deploy is running" >&2; exit 1; }

log() { printf '%s [deploy %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${version:0:12}" "$*"; }
fail() { log "FAILED: $*"; exit 1; }
aws_() { if [ -n "$region" ]; then aws --region "$region" "$@"; else aws "$@"; fi; }

# --- tools this script needs; the VM may have nothing beyond the Debian image.
ensure_tools() {
  local missing=()
  for t in zstd jq curl openssl flock sha256sum; do command -v "$t" >/dev/null || missing+=("$t"); done
  if [ ${#missing[@]} -gt 0 ]; then
    log "installing ${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q && apt-get install -y -q --no-install-recommends zstd jq curl openssl util-linux coreutils
  fi
  if ! command -v aws >/dev/null; then
    # Debian's awscli package (apt verifies it); the VM's first boot installs it
    # too. snap is the fallback on Ubuntu machines without it.
    log "installing the AWS CLI"
    if apt-get install -y -q --no-install-recommends awscli; then :; else snap install aws-cli --classic; fi
  fi
}

# --- download and verify -----------------------------------------------------
tmp=""
switched=0 previous="" release_dir=""
cleanup() {
  local rc=$?
  set +e
  if [ "$rc" != 0 ] && [ "$switched" = 1 ]; then rollback; fi
  [ -n "$tmp" ] && rm -rf "$tmp"
  if [ "$rc" = 0 ]; then log "done: $(readlink "$root/current")"; else log "exit $rc"; fi
  exit "$rc"
}
trap cleanup EXIT

fetch() { # key dest
  aws_ s3api get-object --bucket "$bucket" --key "releases/$version/$1" "$2" >/dev/null \
    || fail "cannot fetch s3://$bucket/releases/$version/$1"
}

verify_manifest() {
  fetch manifest.json "$tmp/manifest.json"
  fetch manifest.sig "$tmp/manifest.sig"
  aws_ kms get-public-key --key-id "$key_id" --query PublicKey --output text > "$tmp/pub.b64" \
    || fail "cannot read the release signing public key"
  base64 -d "$tmp/pub.b64" > "$tmp/pub.der" || fail "public key is not base64"
  openssl pkey -pubin -inform DER -in "$tmp/pub.der" -out "$tmp/pub.pem" 2>/dev/null || fail "public key unreadable"
  # KMS signed the SHA-256 digest of manifest.json (MessageType DIGEST,
  # ECDSA_SHA_256, DER signature); openssl dgst -verify checks exactly that.
  openssl dgst -sha256 -verify "$tmp/pub.pem" -signature "$tmp/manifest.sig" "$tmp/manifest.json" >/dev/null 2>&1 \
    || fail "manifest signature does not verify; refusing release"
  log "manifest signature verified"
  jq -e . "$tmp/manifest.json" >/dev/null || fail "manifest is not JSON"
  [ "$(jq -r .format "$tmp/manifest.json")" = 1 ] || fail "unknown manifest format"
  # A signed manifest for another version, copied under this path, is refused.
  [ "$(jq -r .version "$tmp/manifest.json")" = "$version" ] || fail "manifest is for version $(jq -r .version "$tmp/manifest.json")"
}

fetch_archive() {
  local name want got
  name=$(jq -r .archive.name "$tmp/manifest.json")
  want=$(jq -r .archive.sha256 "$tmp/manifest.json")
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || fail "bad archive name in manifest"
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || fail "bad archive sha256 in manifest"
  fetch "$name" "$tmp/$name"
  got=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
  [ "$got" = "$want" ] || fail "archive sha256 $got does not match the manifest's $want; refusing release"
  log "archive sha256 ok ($(du -h "$tmp/$name" | cut -f1))"
  archive="$tmp/$name"
}

unpack() {
  release_dir="$root/releases/$version"
  if [ "$(readlink "$root/current" 2>/dev/null || true)" = "releases/$version" ]; then
    log "release is already current; restarting it"
    return
  fi
  local stage="$root/releases/.$version.new"
  rm -rf "$stage" && mkdir -p "$stage"
  tar --zstd -xf "$archive" -C "$stage" --no-same-owner || fail "cannot unpack archive"
  cp "$tmp/manifest.json" "$stage/manifest.json"
  [ -f "$stage/deploy/aws/setup.sh" ] || fail "release has no deploy/aws/setup.sh"
  [ "$(sha256sum "$stage/deploy/aws/setup.sh" | cut -d' ' -f1)" = "$(jq -r .setup_sha256 "$tmp/manifest.json")" ] \
    || fail "setup.sh does not match the manifest"
  rm -rf "$release_dir"
  mv "$stage" "$release_dir"
  log "unpacked to $release_dir"
}

# --- provisioning: setup.sh only when what it installs changed ---------------
provision() {
  local want have=""
  want=$(jq -r .provision_sha256 "$tmp/manifest.json")
  [ -f "$state/provision.sha256" ] && have=$(cat "$state/provision.sha256")
  if [ "$want" = "$have" ]; then
    log "provisioning unchanged ($want); setup.sh not run"
    return
  fi
  log "provisioning changed (${have:-none} -> $want); running setup.sh"
  AGENT_DRIVE_HOME="$root/current" bash "$release_dir/deploy/aws/setup.sh" || fail "setup.sh failed"
  echo "$want" > "$state/provision.sha256.new" && mv "$state/provision.sha256.new" "$state/provision.sha256"
  log "setup.sh done"
}

# --- switch, restart, check ------------------------------------------------------
point_current_at() { # target relative to $root, or "" to remove
  if [ -z "$1" ]; then rm -f "$root/current"; return; fi
  ln -sfn "$1" "$root/current.new"
  mv -Tf "$root/current.new" "$root/current"
}

restart() {
  systemctl daemon-reload
  systemctl restart "$unit"
}

healthy() {
  local deadline=$((SECONDS + health_timeout)) body
  while [ "$SECONDS" -lt "$deadline" ]; do
    if body=$(curl -fsS -m 5 "$health_url" 2>/dev/null) && jq -e '.ok == true' >/dev/null 2>&1 <<<"$body"; then
      systemctl is-active --quiet "$unit" && return 0
    fi
    sleep "$health_interval"
  done
  return 1
}

rollback() {
  log "rolling back to ${previous:-nothing}"
  point_current_at "$previous"
  switched=0
  if [ -n "$previous" ]; then
    restart || log "restart after rollback failed"
    if healthy; then log "rolled back; $previous is healthy"; else log "rolled back, but $previous is not healthy either"; fi
  else
    systemctl stop "$unit" || true
  fi
  # The failed release is not kept (it is not the current one any more).
  [ -n "$release_dir" ] && [ "releases/$version" != "$previous" ] && rm -rf "$release_dir"
}

prune() {
  local cur n=0 v
  cur=$(readlink "$root/current")
  # Newest first by the time each release was last deployed (touched below).
  while read -r v; do
    n=$((n + 1))
    if [ "$n" -gt "$keep" ] && [ "releases/$v" != "$cur" ]; then
      log "pruning release $v"
      rm -rf "${root:?}/releases/$v"
    fi
  done < <(find "$root/releases" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{40}' -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2)
}

main() {
  log "deploying s3://$bucket/releases/$version"
  ensure_tools
  tmp=$(mktemp -d "$root/.deploy.XXXXXX")
  verify_manifest
  fetch_archive
  unpack
  provision
  previous=$(readlink "$root/current" 2>/dev/null || true)
  [ "$previous" = "releases/$version" ] && previous=$(cat "$state/previous" 2>/dev/null || true)
  switched=1
  point_current_at "releases/$version"
  log "current -> releases/$version (previous: ${previous:-none})"
  restart || fail "restart of $unit failed"
  healthy || fail "$health_url not healthy within ${health_timeout}s"
  switched=0
  log "healthy"
  touch "$release_dir"
  [ -n "$previous" ] && [ "$previous" != "releases/$version" ] && echo "$previous" > "$state/previous"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" >> "$state/history"
  prune
}

main
