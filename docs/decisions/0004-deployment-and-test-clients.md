# 0004 · Deployment, the sandbox image, and test clients

- **Question:** How does the thin drive get onto an AWS VM behind a Cloudflare
  tunnel, what does a session sandbox run, and how do build agents test the
  drive with real MCP clients without a person at a browser?
- **Measured:** below, each with the command. Machine: the shared build
  workspace (4 vCPU, 15 GB, Ubuntu 24.04, no KVM, egress through a proxy).
- **Decision:** below, in *Choices*.
- **Would change it:** below.

## What works

| Piece | State | How it was checked |
| --- | --- | --- |
| Sandbox image (`sandbox/`) | Builds, exports a plain tree, runs read-only under gVisor (systrap) with `/drive`, `/work`, no network, uid 1000 | `sandbox/build.sh`, then `sandbox/smoke.sh`: 13 checks inside (Python with numpy/pandas, Node with lodash/zod/better-sqlite3, tsc, git, rg, jq, gcc compile, read-only root, no network, `/drive` read, `/work` write) |
| Scripted MCP client (`test/harness/client/`) | OAuth discovery, dynamic registration, PKCE, headless sign-in (Chromium or plain form post), token reuse, tools listed and called | `npm test`: 6 tests in `test/harness/src/stub-oauth.test.ts`, about 0.5 s |
| Stub drive (`test/harness/stub/`) | Contracts §4 surface: `/mcp` with Bearer, both OAuth metadata documents, `/register`, `/authorize` (S256 only), `/token` (code and refresh with rotation), `/healthz`; tools `echo` and `whoami`; a JSON log line per request | The tests above, and the two clients below |
| OpenCode (`test/harness/opencode/`) | Signs in by OAuth unattended; runs a task with `opencode run --format json`; **model → OpenCode → MCP tool → result works** | `auth.sh`, then `run-task.sh --file tasks/echo.txt --expect-tool drive_echo --expect-text opencode-e2e-42` |
| Open WebUI (`test/harness/openwebui/`) | Dynamic registration and the per-user OAuth step done through its API plus headless Chromium; **model → Open WebUI → MCP tool → result works** | `start.sh`, then `connect.ts --chat "…"` |
| AWS template (`deploy/aws/dev-vm.yaml`) | Lints clean; user data renders and parses | `cfn-lint deploy/aws/dev-vm.yaml` (exit 0); `python3 deploy/aws/check-user-data.py deploy/aws/dev-vm.yaml` (`bash -n` ok) |
| Permission set (`deploy/aws/permission-set-policy.json`) | Valid JSON policy; one remaining linter note is a stale entry in the linter's action database | `parliament` (Python API): `RESOURCE_MISMATCH` on `ssm:SendCommand` with an instance ARN, which AWS documents as supported; `RESOURCE_STAR` on `ssm:DescribeDocument` (intended) |
| `setup.sh` | Runs to the end (exit 0, 139 s) in a fresh container: packages 41 s, data volume formatted XFS `reflink=1` and mounted, Node 22.23.5, runsc release-20261123.0, cloudflared 2026.11.2, Ollama 0.40.18 (CPU only) 35 s, `npm ci` and build 5 s, sandbox image 34 s (Docker layers cached; 200 s from scratch) and its smoke test **passed inside the container** (109 ms cold start), units written. Only enabling and starting the systemd units was skipped (no systemd). The first run found a real bug: Ubuntu's `docker.io` lacks buildx, so `docker-buildx` is now installed | `deploy/aws/test-setup-in-container.sh`: a fresh `ubuntu:24.04` container, a 4 GB loop device as the data volume, the host's Docker daemon for the image build |
| Cloudflare quick tunnel | Tunnel created (a `trycloudflare.com` address was issued) but cannot connect from here: the edge needs DNS SRV lookups and port 7844, which this workspace's egress does not allow | `cloudflared tunnel --protocol http2 --url http://localhost:9301` |

## Sandbox image

Built with Docker as a build tool only (`sandbox/Dockerfile`), from
`public.ecr.aws/ubuntu/ubuntu:24.04` with Node 22 copied from
`public.ecr.aws/docker/library/node:22-bookworm` (no Docker Hub, so no 429s),
then `docker export` to `$AGENT_DRIVE_DATA/images/default/rootfs`, plus
`image.json` with the environment, user and working directory a session should
start with.

| Measure | Value | Command |
| --- | --- | --- |
| Root file system size | **1,726 MB** (apparent), 65,865 files | `du -s --apparent-size`, `find | wc -l` in `smoke.sh` |
| Compressed (registry) size | 617 MB | `docker image ls` content size |
| Largest parts | Python packages 639 MB (scipy 109, pandas 81, numpy 43), npm globals 285 MB, shared libraries 281 MB | `du -sh` |
| Cold start to first `exec` answered | **58–77 ms** (3 runs: 62, 58, 77) | `smoke.sh`: `runsc run -detach` then `runsc exec … /bin/true` |
| `runsc run -detach` alone | 44–59 ms | same |
| Warm `exec` | 13–14 ms | same |
| Stop and delete | 13–24 ms | same |
| Build, with cached layers / from scratch | 48 s / 200 s (base images already pulled) | `sandbox/build.sh` |

Contents: Python 3.12 with ~35 common packages (numpy, pandas, scipy,
matplotlib, requests, httpx, bs4, lxml, PyYAML, openpyxl, python-docx,
python-pptx, pypdf, pdfplumber, pydantic, pytest, ruff, …), Node 22 with npm,
pnpm, TypeScript, tsx, prettier, eslint, vitest and common libraries (zod,
lodash, date-fns, marked, yaml, csv-parse, cheerio, better-sqlite3), Git,
ripgrep, fd, jq, sqlite3, build-essential, cmake, poppler-utils, ImageMagick.
Lists in `sandbox/python-packages.txt` and `sandbox/npm-packages.txt`.

Found on the way: **current runsc releases need their sidecar binaries.** The
release is now one archive, `gvisor.tar.bz2`, with `runsc` and a `gvisor-bin/`
directory (`gvisor_sentry` and helpers). A lone `runsc` (as in
`/usr/local/bin/runsc` on this workspace) fails with
`sidecar "gvisor_sentry" not usable`. `sandbox/install-runsc.sh` installs both,
verified by SHA-512. Also: `runsc --network none` leaves an `nsfs` bind mount
at `<root>/null-netns` that must be unmounted before the state directory can
be removed.

## Test clients

All runs against the stub on `localhost:9301`, model
`accounts/fireworks/models/kimi-k3` through Fireworks' OpenAI-compatible API
(key injected by the workspace's egress proxy; configs hold only the
placeholder `proxy-injected`). `glm-5p3` also passed a one-call tool check.

| Client | Sign-in | Tool call end to end | Cost of one run | Observed MCP behaviour |
| --- | --- | --- | --- | --- |
| Scripted SDK client (`@modelcontextprotocol/sdk` 1.32.2) | Headless Chromium: 0.6 s from first request to connected; form post: 0.16 s | n/a (no model): `echo` and `whoami` called directly | none | One transport session per run; terminates it with `DELETE` at the end |
| OpenCode 1.19.6 | `opencode mcp auth` opens the URL with `xdg-open`; a stand-in `xdg-open` (`opencode/bin/xdg-open`) completes it in Chromium, landing on OpenCode's own listener at `127.0.0.1:19876` (fixed port) | Yes: `drive_echo` called with the right input, reply contained the result; 6.6 s | about 20 k tokens (most of it OpenCode's system prompt) | Registers a new client on each `mcp auth`/`mcp debug`; one transport session per `opencode run`, never terminated; tools are named `drive_<tool>` |
| Open WebUI 0.13.4 (`ghcr.io/open-webui/open-webui:main`) | `/api/v1/configs/oauth/clients/register?type=mcp` registers; `/oauth/clients/mcp:drive/authorize` in Chromium with the session cookie set does the user step | Yes: `drive_echo` called (`tool_type: mcp`), reply `owui-e2e-7`; 4.1 s | under 1 k tokens | Probes `server/discover` first (a newer, stateless protocol revision; the stub, on the 1.x SDK, answers 400 and the client falls back to `initialize`); a new transport session per chat request |

Open WebUI only executes tools for a saved chat processed in the background:
`/api/chat/completions` with `chat_id`, message `id` and a `session_id`, then
reading the chat back. A bare completions call returns the model's tool call
unexecuted. `connect.ts` does the former.

Consequence for the drive (A1, E4): **no client here keeps an MCP transport
session across runs or chats.** The drive's own session id has to travel in
tool arguments, as designed; the transport session id is only useful for
grouping calls within one run. The stub's log shows this directly.

## Choices

| Choice | Over | Why |
| --- | --- | --- |
| CloudFormation | Terraform | Nothing to install beyond the AWS CLI, no state file to keep and protect, deployable from the console, and the AWS MCP Server connector can read the stack. Terraform would earn its place with several environments or providers; there is one VM |
| One stack deployed by Johann as administrator; the agent identity can run EC2 and Run Command but not IAM | Giving the agent identity CloudFormation and IAM | The stack creates the instance role; "no IAM administration" for the agent means it cannot deploy that part. It can rebuild the instance (it may pass the existing role) |
| Public subnet with a public IP and **no inbound rules** | Private subnet with a NAT gateway | Same exposure (nothing inbound), about $30 a month cheaper; SSM and cloudflared are outbound |
| Data on a separate gp3 volume, `DeletionPolicy: Snapshot`, nightly DLM snapshots kept 7 days | Data on the root disk | The VM can be thrown away and rebuilt by the script around the same data |
| XFS with `reflink=1`, formatted by `setup.sh`, found by the EBS volume id in the NVMe serial | Device names | `/dev/sdf` is not stable on Nitro; the serial is |
| Docker only to build the image, exported as a tree | debootstrap | Faster to write and cache, uses ECR Public base images; debootstrap would avoid Docker on the VM, worth it if the image moves to CI |
| Node from nodejs.org tarballs with checksum, cloudflared from Cloudflare's apt repository, Ollama from its tarball without GPU libraries, runsc from the release archive with checksum | `curl | sh` installers | Each step is visible and verifiable |
| Tunnel run with a token file in `/etc/cloudflared`, read by systemd `LoadCredential` into a dynamic user | Credentials JSON in the repo or the unit | No secret in the repository or the unit; the token is placed by hand once |
| Kimi K3 on Fireworks for both clients | GLM 5.3 | Both did a correct tool call in the one-call check; K3 chosen for agentic work. One model keeps runs comparable |

## Validated, and how

```sh
sandbox/install-runsc.sh /tmp/a3-data/bin                       # sha512 OK, release-20261123.0
AGENT_DRIVE_DATA=/tmp/a3-data NAME_PREFIX=a3- sandbox/build.sh  # 48 s cached
RUNSC=/tmp/a3-data/bin/runsc AGENT_DRIVE_DATA=/tmp/a3-data NAME_PREFIX=a3- sandbox/smoke.sh
npm test                                                         # 7 tests pass (6 harness)
npx tsc -p test/harness                                          # harness type-checks
cfn-lint deploy/aws/dev-vm.yaml                                  # exit 0
python3 deploy/aws/check-user-data.py deploy/aws/dev-vm.yaml     # bash -n ok
shellcheck -S warning sandbox/*.sh deploy/aws/*.sh test/harness/opencode/*.sh test/harness/openwebui/*.sh
deploy/aws/test-setup-in-container.sh                            # setup.sh in a fresh ubuntu:24.04
node test/harness/stub/server.ts &                               # stub on :9301
node test/harness/client/run.ts --url http://localhost:9301/mcp --login browser --call 'echo={"text":"hi"}'
test/harness/opencode/auth.sh && test/harness/opencode/run-task.sh --file test/harness/opencode/tasks/echo.txt --expect-tool drive_echo
test/harness/openwebui/start.sh && node test/harness/openwebui/connect.ts --chat "Call the echo tool with the text 'owui-e2e-7' …"
```

## Not tested here, and why

| Needs | What | First thing to run |
| --- | --- | --- |
| AWS account (Johann, `deploy/aws/ACCOUNT-SETUP.md`) | Stack deployment; that `CpuOptions.NestedVirtualization` is accepted for m8i.2xlarge in the chosen region and `/dev/kvm` appears; the data volume found by serial; user data end to end; the permission set's effect (Access Analyzer `validate-policy` and a denied `SendCommand` to an untagged instance); DLM snapshots | `aws cloudformation deploy …` (ACCOUNT-SETUP step 6), then `runsc --platform=kvm` in `smoke.sh` |
| systemd (a real VM) | `agent-drive`, `ollama`, `cloudflared-agent-drive` units starting; `LoadCredential` with `DynamicUser` for cloudflared | `systemctl status agent-drive ollama cloudflared-agent-drive` |
| Cloudflare account and domain | Named tunnel, hostname, TLS at the edge, SSE through the tunnel, Bot Fight Mode not interfering | `deploy/cloudflare/README.md` §2, then the scripted client against `https://drive-dev.<domain>/mcp` |
| The real server | Everything above against `agent-drive serve` instead of the stub; `/usr/local/bin/agent-drive` assumes `cli/dist/index.js` | `AGENT_DRIVE_MCP_URL=http://localhost:8787/mcp` with each client |
| Longer agent runs | The E1 tasks for OpenCode, compacted conversations, several Open WebUI chats against one drive session | Write E1 prompts as files in `test/harness/opencode/tasks/` once the drive's tools exist |

## Proposed for the contracts (lead's review)

1. §4: add the sign-in page shape the harness relies on: a `<form>` with
   `name="username"` (or `type="email"`), `type="password"`, `type="submit"`.
2. §4: `agent-drive serve` should answer the newer `server/discover` probe, or
   at least not break on it (Open WebUI sends it first). The TypeScript SDK 2.x
   (`@modelcontextprotocol/server` 2.4.0) is out alongside 1.32.2; worth a look
   before the server settles on 1.x.
3. §4: the CLI package gets `"bin": { "agent-drive": "dist/index.js" }`, so
   setup can `npm install -g ./cli` instead of writing a wrapper.
4. §4: `RUNSC_PLATFORM` (`kvm` or `systrap`) in the server's environment;
   `setup.sh` writes it from whether `/dev/kvm` exists.
5. §1: `images/<name>/image.json` beside `rootfs/`, with the session's `env`,
   `user` and `cwd` (written by `sandbox/build.sh`); the image sets
   `NODE_PATH` so global npm packages resolve.
6. §4: expire idle MCP transport sessions server-side; none of the clients
   tested sends `DELETE` reliably.
7. §4: a JSON-response mode (`enableJsonResponse`) as an option, since
   Cloudflare quick tunnels do not carry Server-Sent Events.

## Would change it

- KVM available on the VM (nested virtualization accepted): switch gVisor to
  `--platform=kvm` and measure again; if not, stay on systrap.
- The sandbox image needs to be built in CI and pulled: move to debootstrap or
  an OCI registry and drop Docker from the VM.
- A second environment (the real drive VM with different settings): reconsider
  Terraform or nested stacks.
- Open WebUI's background-chat API changes between versions (it is `main`
  here): pin the image tag that passed.
