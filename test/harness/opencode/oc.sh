#!/usr/bin/env bash
# Run OpenCode in an isolated home for the harness, so test runs never touch a
# person's own OpenCode config, tokens or sessions. All arguments go to opencode.
#
#   test/harness/opencode/oc.sh mcp list
#   test/harness/opencode/oc.sh run --format json "Call the drive echo tool with 'hi'"
#
# Environment:
#   OC_HOME              default /tmp/a3-data/opencode
#   AGENT_DRIVE_MCP_URL  default http://localhost:9301/mcp (the stub)
#   OC_MODEL             default accounts/fireworks/models/kimi-k3
#   OC_API_KEY           default "proxy-injected": the egress proxy here injects the
#                        real key for api.fireworks.ai. Elsewhere, set a real key in the
#                        environment; it is written only into $OC_HOME, never the repo.
set -euo pipefail
: "${OC_HOME:=/tmp/a3-data/opencode}"
: "${AGENT_DRIVE_MCP_URL:=http://localhost:9301/mcp}"
: "${OC_MODEL:=accounts/fireworks/models/kimi-k3}"
: "${OC_API_KEY:=proxy-injected}"
export XDG_CONFIG_HOME="$OC_HOME/config" XDG_DATA_HOME="$OC_HOME/data" \
       XDG_STATE_HOME="$OC_HOME/state" XDG_CACHE_HOME="$OC_HOME/cache"
project="${OC_PROJECT:-$OC_HOME/project}"
mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$project"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
umask 077
sed -e "s#\${AGENT_DRIVE_MCP_URL}#$AGENT_DRIVE_MCP_URL#" \
    -e "s#\${OC_MODEL}#$OC_MODEL#g" \
    -e "s#\${OC_API_KEY}#$OC_API_KEY#" \
    "$here/opencode.template.json" > "$XDG_CONFIG_HOME/opencode/opencode.json"
cd "$project"
exec opencode "$@"
