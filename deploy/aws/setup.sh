#!/usr/bin/env bash
# Set up an Ubuntu 24.04 machine to run Agent Drive: the development VM on AWS
# (run from the instance's user data, or by hand over Session Manager), and the
# same script later for the real drive VM.
#
#   sudo deploy/aws/setup.sh
#
# Idempotent: safe to run again after a change. Each step can be skipped:
#   SKIP_STEPS="ollama sandbox"   space-separated step names (see main at the bottom)
#
# Configuration (environment, or /etc/agent-drive/setup.env written by user data):
#   AGENT_DRIVE_MOUNT     where the data volume is mounted   (/srv/agent-drive)
#   AGENT_DRIVE_DATA      the data directory                 ($AGENT_DRIVE_MOUNT/data)
#   DATA_VOLUME_ID        EBS volume id of the data disk (vol-…); found by its NVMe serial
#   DATA_DEVICE           or the block device directly (e.g. /dev/nvme1n1)
#   AGENT_DRIVE_PORT      8787
#   AGENT_DRIVE_PUBLIC_URL  the tunnel's HTTPS address, e.g. https://drive.example.com
#   NODE_MAJOR            22
#   GVISOR_RELEASE        latest, or e.g. release-20261123.0
#   OLLAMA_PULL           models to pull after install (none by default)
#
# Needs systemd for the services; without it (a container), units are written
# but not enabled, and that is reported at the end. No secrets are read or
# written: the tunnel token is placed by hand (see deploy/cloudflare/README.md).
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -f /etc/agent-drive/setup.env ] && . /etc/agent-drive/setup.env

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${AGENT_DRIVE_MOUNT:=/srv/agent-drive}"
: "${AGENT_DRIVE_DATA:=$AGENT_DRIVE_MOUNT/data}"
: "${AGENT_DRIVE_PORT:=8787}"
: "${AGENT_DRIVE_PUBLIC_URL:=}"
: "${NODE_MAJOR:=22}"
: "${SKIP_STEPS:=}"
export DEBIAN_FRONTEND=noninteractive

has_systemd() { [ -d /run/systemd/system ]; }
log() { printf '\n[setup] %s\n' "$*"; }
skipped=() done_steps=()
step() { # name function
  if [[ " $SKIP_STEPS " == *" $1 "* ]]; then log "skip $1 (SKIP_STEPS)"; skipped+=("$1"); return; fi
  log "step $1"; local t=$SECONDS; "$2"; done_steps+=("$1 ($((SECONDS - t))s)")
}

# --- steps -------------------------------------------------------------------

s_packages() {
  apt-get update -q
  apt-get install -y -q --no-install-recommends \
    ca-certificates curl gnupg git jq xfsprogs zstd xz-utils unzip sqlite3 \
    build-essential python3 \
    tesseract-ocr tesseract-ocr-eng poppler-utils \
    docker.io
}

s_data_volume() {
  local dev="${DATA_DEVICE:-}"
  if [ -z "$dev" ] && [ -n "${DATA_VOLUME_ID:-}" ]; then
    # Nitro instances expose EBS volumes as NVMe devices whose serial is the volume id.
    local serial="${DATA_VOLUME_ID/-/}"
    for _ in $(seq 1 60); do
      dev=$(ls /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_"$serial" 2>/dev/null || true)
      [ -n "$dev" ] && break; sleep 5    # the attachment can lag the boot
    done
  fi
  if [ -z "$dev" ]; then
    echo "no data volume given or found; using $AGENT_DRIVE_DATA on the root disk"
    mkdir -p "$AGENT_DRIVE_DATA"; return
  fi
  dev=$(readlink -f "$dev")
  if ! blkid "$dev" >/dev/null 2>&1; then
    echo "formatting $dev as XFS with reflink"
    mkfs.xfs -m reflink=1 -L agent-drive "$dev"
  fi
  local uuid; uuid=$(blkid -s UUID -o value "$dev")
  mkdir -p "$AGENT_DRIVE_MOUNT"
  grep -q "$uuid" /etc/fstab || echo "UUID=$uuid $AGENT_DRIVE_MOUNT xfs defaults,noatime,nofail 0 2" >> /etc/fstab
  mountpoint -q "$AGENT_DRIVE_MOUNT" || mount "$AGENT_DRIVE_MOUNT"
  xfs_info "$AGENT_DRIVE_MOUNT" | grep -o 'reflink=[01]'
  mkdir -p "$AGENT_DRIVE_DATA"
}

s_node() {
  if command -v node >/dev/null && [ "$(command node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then
    echo "node $(command node -v) already installed"; return
  fi
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp; tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
  local file; file=$(grep -o "node-v[0-9.]*-linux-x64.tar.xz" "$tmp/SHASUMS256.txt" | head -1)
  curl -fsSL --retry 3 -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude README.md --exclude LICENSE
  rm -rf "$tmp"
  command node -v
}

s_gvisor() {
  "$repo/sandbox/install-runsc.sh" /usr/local/bin
  # KVM where the instance has nested virtualization; systrap otherwise.
  if [ -e /dev/kvm ]; then echo kvm > /etc/agent-drive/runsc-platform; else echo systrap > /etc/agent-drive/runsc-platform; fi
  echo "runsc platform: $(cat /etc/agent-drive/runsc-platform)"
}

s_cloudflared() {
  if ! command -v cloudflared >/dev/null; then
    mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL --retry 3 https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
      > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -q && apt-get install -y -q cloudflared
  fi
  command cloudflared --version
}

s_ollama() {
  if ! command -v ollama >/dev/null; then
    local tmp; tmp=$(mktemp -d)
    curl -fsSL --retry 3 -o "$tmp/ollama.tar.zst" "https://ollama.com/download/ollama-linux-amd64.tar.zst"
    # CPU only on this VM: leave out the GPU libraries (most of the archive).
    tar --zstd -xf "$tmp/ollama.tar.zst" -C /usr/local --exclude 'lib/ollama/cuda_*' --exclude 'lib/ollama/rocm*' --exclude 'lib/ollama/vulkan*'
    rm -rf "$tmp"
  fi
  id ollama >/dev/null 2>&1 || useradd --system --home-dir /usr/share/ollama --create-home --shell /usr/sbin/nologin ollama
  mkdir -p "$AGENT_DRIVE_DATA/ollama" && chown ollama:ollama "$AGENT_DRIVE_DATA/ollama"
  command ollama --version 2>&1 | tail -1 || true
}

s_app() {
  # The server and CLI from this checkout.
  (cd "$repo" && npm ci --no-fund --no-audit && npm run build)
  cat > /usr/local/bin/agent-drive <<EOF
#!/bin/sh
exec node "$repo/cli/dist/index.js" "\$@"
EOF
  chmod 0755 /usr/local/bin/agent-drive
}

s_docker_daemon() {
  if docker info >/dev/null 2>&1; then return; fi
  if has_systemd; then systemctl enable --now docker; else
    (dockerd > /var/log/dockerd.log 2>&1 &); for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  docker info >/dev/null
}

s_sandbox() {
  s_docker_daemon
  AGENT_DRIVE_DATA="$AGENT_DRIVE_DATA" "$repo/sandbox/build.sh"
  # Smoke test needs to start a gVisor sandbox, which needs a real VM (or a
  # privileged container); report rather than fail where it cannot.
  if RUNSC_PLATFORM="$(cat /etc/agent-drive/runsc-platform 2>/dev/null || echo systrap)" \
     AGENT_DRIVE_DATA="$AGENT_DRIVE_DATA" "$repo/sandbox/smoke.sh"; then
    echo "sandbox smoke test passed"
  else
    echo "WARNING: sandbox smoke test failed (expected inside an unprivileged container)"
  fi
}

s_config() {
  mkdir -p /etc/agent-drive
  umask 022
  cat > /etc/agent-drive/agent-drive.env <<EOF
# Written by deploy/aws/setup.sh; contracts §4. No secrets here.
AGENT_DRIVE_DATA=$AGENT_DRIVE_DATA
AGENT_DRIVE_PORT=$AGENT_DRIVE_PORT
AGENT_DRIVE_PUBLIC_URL=$AGENT_DRIVE_PUBLIC_URL
RUNSC_PLATFORM=$(cat /etc/agent-drive/runsc-platform 2>/dev/null || echo systrap)
OLLAMA_HOST=http://127.0.0.1:11434
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
}

s_units() {
  install -m 0644 "$repo/deploy/aws/systemd/agent-drive.service" /etc/systemd/system/agent-drive.service
  install -m 0644 "$repo/deploy/aws/systemd/ollama.service" /etc/systemd/system/ollama.service
  install -m 0644 "$repo/deploy/cloudflare/cloudflared-agent-drive.service" /etc/systemd/system/cloudflared-agent-drive.service
  install -m 0644 "$repo/deploy/cloudflare/cloudflared-quick.service" /etc/systemd/system/cloudflared-quick.service
  sed -i "s#@AGENT_DRIVE_REPO@#$repo#g; s#@AGENT_DRIVE_DATA@#$AGENT_DRIVE_DATA#g" \
    /etc/systemd/system/agent-drive.service /etc/systemd/system/ollama.service
  mkdir -p /etc/cloudflared && chmod 0700 /etc/cloudflared
  if ! has_systemd; then echo "no systemd: units written, not enabled"; skipped+=("units-enable"); return; fi
  systemctl daemon-reload
  systemctl enable --now ollama.service
  for m in ${OLLAMA_PULL:-}; do command ollama pull "$m"; done
  systemctl enable agent-drive.service
  systemctl restart agent-drive.service || true
  # The named tunnel starts once its token is in place (deploy/cloudflare/README.md).
  systemctl enable cloudflared-agent-drive.service
  if [ -s /etc/cloudflared/agent-drive.token ]; then systemctl restart cloudflared-agent-drive.service; fi
}

s_check() {
  echo "runsc:      $(command -v runsc) $(runsc --version 2>/dev/null | head -1)"
  echo "tesseract:  $(tesseract --version 2>&1 | head -1)"
  echo "pdftotext:  $(pdftotext -v 2>&1 | head -1)"
  echo "node:       $(command node -v)"
  echo "cloudflared:$(command cloudflared --version 2>/dev/null | head -1)"
  echo "ollama:     $(command -v ollama || echo missing)"
  echo "rootfs:     $(du -sh --apparent-size "$AGENT_DRIVE_DATA/images/default/rootfs" 2>/dev/null | cut -f1 || echo missing)"
  if has_systemd; then
    for u in agent-drive ollama cloudflared-agent-drive; do echo "$u: $(systemctl is-active $u.service || true)"; done
    if curl -fsS -m 5 "http://localhost:$AGENT_DRIVE_PORT/healthz"; then echo; else echo "healthz: not answering yet"; fi
  fi
}

# --- main --------------------------------------------------------------------
mkdir -p /etc/agent-drive
step packages s_packages
step data-volume s_data_volume
step node s_node
step gvisor s_gvisor
step cloudflared s_cloudflared
step ollama s_ollama
step config s_config
step app s_app
step sandbox s_sandbox
step units s_units
log "done: ${done_steps[*]}"
[ ${#skipped[@]} = 0 ] || log "skipped: ${skipped[*]}"
s_check
