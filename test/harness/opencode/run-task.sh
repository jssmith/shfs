#!/usr/bin/env bash
# Run one task in OpenCode unattended and check the result.
#
#   test/harness/opencode/run-task.sh [--expect-tool drive_echo] [--expect-text TEXT] \
#       [--out FILE.jsonl] "task prompt"
#   test/harness/opencode/run-task.sh --file tasks/echo.txt --expect-tool drive_echo
#
# Prints one JSON summary line: tools called (name, status, input), final text,
# tokens, wall time, OpenCode's session id. Exit 1 if an expectation fails.
# Sign in first with auth.sh; runs reuse the stored token.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
expect_tool="" expect_text="" out="" prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-tool) expect_tool="$2"; shift 2 ;;
    --expect-text) expect_text="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --file) prompt="$(cat "$2")"; shift 2 ;;
    *) prompt="$1"; shift ;;
  esac
done
[ -n "$prompt" ] || { echo "no task prompt" >&2; exit 2; }
: "${OC_HOME:=/tmp/a3-data/opencode}"
out="${out:-$OC_HOME/runs/$(date +%Y%m%dT%H%M%S)-$$.jsonl}"
mkdir -p "$(dirname "$out")"

start=$(date +%s%3N)
status=0
timeout "${TASK_TIMEOUT:-600}" "$here/oc.sh" run --format json "$prompt" > "$out" 2> "${out%.jsonl}.err" || status=$?
ms=$(( $(date +%s%3N) - start ))

summary=$(jq -s -c --argjson ms "$ms" --argjson status "$status" '{
  exit: $status, ms: $ms,
  session: (map(.sessionID) | map(select(.)) | first),
  tools: [ .[] | select(.type=="tool_use") | .part | {tool, status: .state.status, input: .state.input} ],
  text: ([ .[] | select(.type=="text") | .part.text ] | join("\n")),
  tokens: ([ .[] | select(.type=="step_finish") | .part.tokens.total ] | add),
  errors: [ .[] | select(.type=="error") | .error ]
}' "$out")
echo "$summary"

fail=0
[ "$status" = 0 ] || fail=1
if [ -n "$expect_tool" ] && ! echo "$summary" | jq -e --arg t "$expect_tool" '.tools | any(.tool==$t and .status=="completed")' >/dev/null; then
  echo "expected a completed call to $expect_tool" >&2; fail=1
fi
if [ -n "$expect_text" ] && ! echo "$summary" | jq -e --arg s "$expect_text" '.text | contains($s)' >/dev/null; then
  echo "expected the reply to contain: $expect_text" >&2; fail=1
fi
exit $fail
