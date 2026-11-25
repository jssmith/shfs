#!/usr/bin/env bash
# Start Open WebUI in Docker as the chat-app test client.
#
#   test/harness/openwebui/start.sh          # start (idempotent)
#   test/harness/openwebui/start.sh stop     # stop and remove the container
#
# Host networking, so the container reaches the drive (or the stub) on localhost
# and its OAuth callback is http://localhost:$OWUI_PORT/oauth/clients/…/callback.
# Model: an OpenAI-compatible provider, Fireworks by default; the key is the
# placeholder "proxy-injected", which the egress proxy here replaces. Data in
# $OWUI_DATA, outside the repository.
set -euo pipefail
name="${OWUI_NAME:-a3-openwebui}"
port="${OWUI_PORT:-9310}"
data="${OWUI_DATA:-/tmp/a3-data/openwebui}"
image="${OWUI_IMAGE:-ghcr.io/open-webui/open-webui:main}"

if [ "${1:-}" = stop ]; then docker rm -f "$name" >/dev/null 2>&1 || true; echo "stopped $name"; exit 0; fi
if docker ps --format '{{.Names}}' | grep -qx "$name"; then echo "$name already running on :$port"; exit 0; fi
docker rm -f "$name" >/dev/null 2>&1 || true
mkdir -p "$data"

args=(run -d --name "$name" --network host
  -v "$data:/app/backend/data"
  -e PORT="$port" -e WEBUI_URL="http://localhost:$port"
  -e WEBUI_NAME="Agent Drive test client"
  -e ENABLE_SIGNUP=true -e DEFAULT_USER_ROLE=user
  -e ENABLE_OLLAMA_API=false
  -e ENABLE_OPENAI_API=true
  -e OPENAI_API_BASE_URL="${OWUI_OPENAI_BASE_URL:-https://api.fireworks.ai/inference/v1}"
  -e OPENAI_API_KEY="${OWUI_OPENAI_API_KEY:-proxy-injected}"
  -e ENABLE_TOOL_SERVERS=true
  # No downloads of embedding or speech models at start; not needed for tools.
  -e OFFLINE_MODE=true -e RAG_EMBEDDING_MODEL_AUTO_UPDATE=false -e HF_HUB_OFFLINE=1
  -e ENABLE_WEB_SEARCH=false -e ENABLE_CODE_INTERPRETER=false
  -e GLOBAL_LOG_LEVEL="${OWUI_LOG_LEVEL:-INFO}"
)
# Behind an egress proxy (as in the build workspace), pass it and its CA through.
proxy="${HTTPS_PROXY:-${https_proxy:-}}"
if [ -n "$proxy" ]; then
  args+=(-e HTTPS_PROXY="$proxy" -e https_proxy="$proxy"
         -e NO_PROXY="localhost,127.0.0.1,::1" -e no_proxy="localhost,127.0.0.1,::1")
fi
ca="${OWUI_CA_FILE:-${SSL_CERT_FILE:-}}"
if [ -n "$ca" ] && [ -f "$ca" ]; then
  args+=(-v "$ca:/etc/ssl/certs/a3-proxy-ca.pem:ro"
         -e SSL_CERT_FILE=/etc/ssl/certs/a3-proxy-ca.pem
         -e REQUESTS_CA_BUNDLE=/etc/ssl/certs/a3-proxy-ca.pem
         -e AIOHTTP_CLIENT_SESSION_SSL=true)
fi
docker "${args[@]}" "$image" >/dev/null

printf 'waiting for %s on :%s ' "$name" "$port"
for _ in $(seq 1 180); do
  if curl -fsS "http://localhost:$port/health" >/dev/null 2>&1; then echo ok; exit 0; fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then echo; docker logs --tail 30 "$name"; exit 1; fi
  printf '.'; sleep 2
done
echo; echo "timed out"; docker logs --tail 30 "$name"; exit 1
