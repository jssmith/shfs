#!/usr/bin/env bash
# Sign OpenCode in to the drive's MCP server without a person: `opencode mcp auth`
# opens the authorization URL with xdg-open, which here is bin/xdg-open (headless
# Chromium). OpenCode stores the token in $OC_HOME and reuses it on later runs.
#
#   AGENT_DRIVE_MCP_URL=https://drive.example.com/mcp test/harness/opencode/auth.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/bin:$PATH"
"$here/oc.sh" mcp logout drive >/dev/null 2>&1 || true
timeout "${AUTH_TIMEOUT:-90}" "$here/oc.sh" mcp auth drive < /dev/null
"$here/oc.sh" mcp list
