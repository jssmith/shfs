#!/usr/bin/env bash
# One build on the builder MicroVM: clone the commit, check it is on the release
# branch, run the commit's own deploy/aws/ci.sh (test; then package and publish,
# which signs, uploads and deploys), record the result, and build again if the
# branch moved on meanwhile. Started by runner.mjs with the run hook's payload.
#
# Environment (from the trigger, deploy/aws/trigger): COMMIT, RELEASE (true|false),
# MICROVM_ID, REPO_URL, BRANCH, ARTIFACT_BUCKET, SIGNING_KEY_ARN, DEPLOY_DOCUMENT,
# DEPLOY_TAG_VALUE, AWS_REGION. No GitHub credentials: the repository is public.
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
: "${COMMIT:?}" "${REPO_URL:?}" "${BRANCH:=main}" "${RELEASE:=false}" "${AWS_REGION:?}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
rootfs=/opt/data/images/default/rootfs
log() { printf '[build %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

bash /opt/builder/prepare.sh
ulimit -Sn 8192 2>/dev/null || true

result() { # commit status detail
  local f; f=$(mktemp)
  jq -n --arg c "$1" --arg s "$2" --arg d "$3" --arg m "${MICROVM_ID:-}" --arg r "$RELEASE" \
    --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg since "$started" \
    '{commit: $c, status: $s, detail: $d, release: ($r == "true"), microvm: $m, started_at: $since, finished_at: $t}' > "$f"
  cat "$f"
  if [ -n "${ARTIFACT_BUCKET:-}" ]; then
    aws s3api put-object --bucket "$ARTIFACT_BUCKET" --key "builds/$1/${MICROVM_ID:-local}.json" \
      --body "$f" --content-type application/json >/dev/null || log "could not record the result"
  fi
  rm -f "$f"
}

build_one() { # commit
  local commit="$1" src=/work/src release="$RELEASE" status detail
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { log "not a commit sha: $commit"; return 2; }
  log "building $commit from $REPO_URL (release: $release)"
  rm -rf "$src" && mkdir -p /work
  git clone -q --filter=blob:none --no-checkout "$REPO_URL" "$src" || { result "$commit" failed "clone failed"; return 1; }
  git -C "$src" checkout -q --detach "$commit" || { result "$commit" failed "commit not in the repository"; return 1; }
  # Only a commit on the release branch is released; any other is only tested.
  if [ "$release" = true ] && ! git -C "$src" merge-base --is-ancestor "$commit" "origin/$BRANCH"; then
    log "$commit is not on $BRANCH: testing only"; release=false
  fi
  # The rootfs is baked into this image; a commit that changes sandbox/ would be
  # tested against the old one, so it is not released until the image is rebuilt.
  local want have
  want=$(bash /opt/builder/sandbox-hash.sh "$src")
  have=$(cat /opt/data/images/default/SANDBOX_SHA256)
  if [ "$want" != "$have" ]; then
    log "sandbox/ changed since the builder image was made ($have -> $want): testing only; rebuild the image"
    release=false; detail="sandbox changed: rebuild the builder image"
  fi
  cd "$src"
  export BUILD_SOURCE_VERSION="$commit" BUILD_ID="${MICROVM_ID:-local}" SOURCE_URL="$REPO_URL" \
         AGENT_DRIVE_ROOTFS="$rootfs" AGENT_DRIVE_TEST_IMAGE_ROOTFS="$rootfs" CI_DATA=/work/ci-data
  if ! deploy/aws/ci.sh test; then result "$commit" failed "tests failed"; return 1; fi
  if [ "$release" != true ]; then result "$commit" tested "${detail:-not released}"; return 0; fi
  rm -rf /work/release
  if ! deploy/aws/ci.sh package /work/release; then result "$commit" failed "package failed"; return 1; fi
  if ! deploy/aws/ci.sh publish /work/release; then result "$commit" failed "publish or deploy failed"; return 1; fi
  result "$commit" released "signed, uploaded and deployed"
}

commit="$COMMIT" rc=0
for round in 1 2 3 4 5; do
  build_one "$commit"; rc=$?
  [ "$RELEASE" = true ] || break
  # Pushes that arrived during this build found the builder busy; build the new head.
  head=$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | cut -f1)
  [ -n "$head" ] && [ "$head" != "$commit" ] || break
  log "$BRANCH moved to $head during the build; building it"
  commit="$head"
done
exit "$rc"
