
# ---- The builder MicroVM image (Amazon Linux 2023, Lambda-managed base) -----
# The toolchain the build needs, the sandbox rootfs built from this commit's
# sandbox/ (stage "sandbox" above), and the runner. The code to build is not in
# the image: each build clones the commit it is given (run.sh). Amazon Linux
# 2023 has no tesseract package, so the OCR extraction tests skip here; the VM
# (Ubuntu) has it.
FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y tar bzip2 gzip xz findutils util-linux procps-ng git python3 \
      libstdc++ shadow-utils which unzip zip jq zstd openssl poppler-utils \
      ImageMagick fuse3 \
 && dnf clean all
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node -v && npm -v
# AWS CLI v2 from AWS (S3 conditional puts need a current CLI).
RUN cd /tmp && curl -fsSL -o awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" \
 && unzip -q awscliv2.zip && ./aws/install && rm -rf aws awscliv2.zip && aws --version
COPY install-runsc.sh /tmp/install-runsc.sh
RUN GVISOR_RELEASE=20261123.0 bash /tmp/install-runsc.sh /usr/local/bin && runsc --version
COPY --from=sandbox / /opt/data/images/default/rootfs/
COPY image.json /opt/data/images/default/image.json
COPY SANDBOX_SHA256 /opt/data/images/default/SANDBOX_SHA256
RUN cd /opt/data/images/default/rootfs && rm -f .dockerenv \
 && printf '127.0.0.1 localhost\n::1 localhost\n' > etc/hosts \
 && : > etc/resolv.conf && echo sandbox > etc/hostname
# The runner, with the one SDK client it needs (to terminate its own MicroVM).
COPY builder/ /opt/builder/
RUN cd /opt/builder && npm ci --omit=dev --no-fund --no-audit
# A copy of the repository at image time, used only to warm the snapshot (/validate).
COPY src/ /opt/warm/
RUN cd /opt/warm && npm ci --no-fund --no-audit && npm run build
EXPOSE 8080 9000
CMD ["node", "/opt/builder/runner.mjs"]
