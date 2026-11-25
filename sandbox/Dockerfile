# The session sandbox root file system. Built by sandbox/build.sh and exported
# as a plain directory tree; never run with Docker in production, only with runsc.
# Base images come from public.ecr.aws, not Docker Hub (rate limits).
ARG BASE_IMAGE=public.ecr.aws/ubuntu/ubuntu:24.04
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm

FROM ${NODE_IMAGE} AS node

FROM ${BASE_IMAGE}
ARG DEBIAN_FRONTEND=noninteractive
# Build-time only: an HTTPS proxy and its CA, when the build host needs them.
# The CA arrives as a BuildKit secret, so it is never written into a layer.
ARG HTTPS_PROXY
ARG NO_PROXY

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git git-lfs openssh-client \
      build-essential pkg-config cmake autoconf automake libtool \
      python3 python3-dev python3-pip python3-venv python-is-python3 \
      ripgrep fd-find jq sqlite3 file tree less nano vim-tiny \
      unzip zip xz-utils bzip2 zstd patch diffutils rsync bc \
      procps psmisc lsof strace time \
      poppler-utils imagemagick \
      libssl-dev libffi-dev zlib1g-dev libxml2-dev libxslt1-dev libjpeg-dev libpng-dev \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Node from the official image's binaries (glibc build, runs on Ubuntu 24.04).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node /usr/local/include/node /usr/local/include/node
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

COPY python-packages.txt npm-packages.txt /tmp/pkgs/

# Common Python packages, system-wide (the sandbox is single-purpose, so PEP 668's
# guard against breaking the OS Python does not buy anything here).
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi; \
    pip install --no-cache-dir --break-system-packages --ignore-installed \
      -r /tmp/pkgs/python-packages.txt

# Common npm packages, globally; NODE_PATH (see image.json) makes them requireable.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm install -g --no-fund --no-audit $(grep -v '^#' /tmp/pkgs/npm-packages.txt | tr '\n' ' ') \
 && npm cache clean --force

# An unprivileged user for sessions, and the mount points the server fills.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd --create-home --uid 1000 --shell /bin/bash agent \
 && mkdir -p /drive /work \
 && chown agent:agent /work \
 && rm -rf /tmp/pkgs /root/.cache /root/.npm /tmp/* \
 && printf '%s\n' 'export NODE_PATH=/usr/local/lib/node_modules' > /etc/profile.d/agent-drive.sh

WORKDIR /work
