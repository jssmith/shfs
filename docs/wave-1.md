# Wave 1: a thin drive that works end to end, and the uncertainties it can't answer

Status: **proposed, for Johann's review** (second version) · 2026-11-25
Goals, in order: **eliminate the largest uncertainties**, and **get something usable working end to end**. The first version of this plan ran isolated spikes and left the end-to-end drive for last; this one builds the thinnest working drive first and uses it to answer the biggest questions in the real agent apps.

## What is most uncertain

| Rank | Uncertainty | Why it matters | How wave 1 settles it |
| --- | --- | --- | --- |
| 1 | Do claude.ai, ChatGPT and Claude Code work with this MCP design: our OAuth sign-in through a Cloudflare tunnel, a secret session id held across long and compacted conversations, waiting for an approval, separate conversations kept apart? (A1, E4, E6) | The whole product rests on it, and only the real apps can answer | The thin drive on AWS, connected to all three; the server logs what each app actually does |
| 2 | Can an agent work productively with a shell over `/drive`? (A2, E1) | The core experience | Claude Code and a chat app doing real tasks on the thin drive |
| 3 | Does the ring check catch sensitive files, scans included? (A4, E3) | The only wall; until it works, only non-sensitive folders go in | Corpus generator plus the check, measured; then a sample of Johann's files |
| 4 | Can the drive's file system daemon be correct and fast enough? (A9) | It replaces the copied session folders | Built alongside; the thin drive starts with copies, so this doesn't block |

Lower uncertainty, so built rather than spiked, or deferred: merge and undo (A3: well-understood, built into the thin drive with invariant tests); the package registry (A5: common packages baked into the image first); sandbox hardening (A6: the red-team checks become tests in the thin drive); Agent Substrate (A8: after wave 1).

## The thin drive (done when Johann uses it)

Johann uploads a non-sensitive folder from his Mac, connects Claude Code and claude.ai, asks an agent to do something, sees the session in the app, and undoes its merge.

| Part | In the thin version | Later |
| --- | --- | --- |
| Store | SQLite and blobs; items in a plain tree; labels; change packages | Unchanged, extended |
| Ingest | `drive put <folder>` over HTTPS | `drive watch`, web upload |
| Reading | Text extraction and OCR; full-text search | Better extraction |
| Sessions | `start_session` with a secret id, `resume_session`; one gVisor sandbox per session with a **copied** `/drive`; `run`, `search`, `read`, `write` | The file system daemon (A9); suspend and resume |
| Merge | `checkpoint` and `finish`: all-or-nothing, conflicts reported, no three-way merge yet; `undo` of a whole merge | Three-way merge, conflicts as files, `resolve` |
| Rings | Rules-only check that hides matches; **only non-sensitive folders go in** until the check passes its marks | Model check, approvals, taint, declassification |
| MCP sign-in | OAuth 2.1 with dynamic client registration for one user | Passkeys in the app |
| App | One page: sessions, what each read and changed, undo | The P0 app |
| Hosting | The AWS development VM behind a Cloudflare tunnel, set up by one script | The real drive VM |
| Instrumentation | Logs per call: transport session, whether the session id came back, gaps between calls, retries | Kept for E4 and E6 |

## Test clients

The real apps (claude.ai, ChatGPT, Claude Code) give the final answers on uncertainty 1, but they need Johann and a public address. Two open-source clients let the build agents test on their own, here and in CI:

| Client | Used for | Why this one |
| --- | --- | --- |
| **[OpenCode](https://opencode.ai)** | Agent-in-the-loop tests: the E1 tasks over `/drive`, scripted and repeatable; long and compacted conversations to see whether the session id survives; regression runs in CI | Runs unattended (`opencode run`, JSON output); remote MCP over Streamable HTTP with OAuth (discovery, PKCE, refresh); any model provider. OAuth is done once with `opencode mcp auth`, then runs reuse the stored token |
| **[Open WebUI](https://docs.openwebui.com/features/extensibility/mcp)** | The chat-app case: OAuth with dynamic client registration, several conversations against one drive, tools used from a chat | Native MCP (Streamable HTTP) with OAuth 2.1 and dynamic client registration documented; the closest open stand-in for a claude.ai connector |

LibreChat is the fallback for the chat-app case if Open WebUI's OAuth gets in the way. Both test clients need a model API key (§ What Johann needs).

## Who does what

The thin drive's server is one codebase, so it isn't split across many agents early. Pieces with a clear boundary run in parallel.

| Who | Work | Depends on |
| --- | --- | --- |
| Lead session | Repository skeleton; then the thin drive's server: store, ingest, MCP with OAuth, sessions in gVisor, merge and undo with invariant tests | — |
| Agent 1 | Reading and the ring check: extraction, OCR, rules, the index; the **synthetic corpus generator** with ground truth; recall and precision measured against the marks; then the local model | Skeleton |
| Agent 2 | The drive file system daemon in Rust (A9), against a stub store, mounted into gVisor; measured; swapped into the thin drive when it passes | Skeleton |
| Agent 3 | Deployment: the AWS VM definition and setup script (gVisor, Tesseract, Ollama, cloudflared, systemd), the Cloudflare tunnel, backups; the one-page app; the **test harness**: OpenCode and Open WebUI set up against the drive, the E1 tasks scripted for OpenCode | Skeleton; Johann's AWS and Cloudflare steps for the deployed part |
| Johann | AWS development account and connector; a Cloudflare account and a domain for the tunnel; a non-sensitive folder or two; about an hour connecting claude.ai and ChatGPT to the drive and trying the A1 script | — |

Same rules as before: separate worktrees and branches, own ports and names, synthetic data only, nothing to `main` without review.

## Order of checkpoints

1. Skeleton in place; agents start.
2. The thin drive works here: OpenCode runs the E1 tasks against it unattended, and Open WebUI connects through OAuth.
3. It's on the AWS VM behind the tunnel; Johann connects claude.ai and ChatGPT; the A1 script gives the first answers to uncertainty 1.
4. Johann uses it with a non-sensitive folder; ring check numbers on the corpus.
5. **Agent Drive is developed on Agent Drive** [J: as soon as possible]. What that needs beyond the thin drive:
   - the `agent-drive` repository in the drive, and a sandbox image with Node 24, Rust, Git and the usual tools;
   - package installs from npm, crates.io and PyPI: a minimal allow-list proxy for untainted sessions (the first piece of A5);
   - pushing to GitHub **from the host**, never the sandbox: a `drive git push <folder>` command commits the merged tree and pushes with a key held on the host (a first, small step toward the Git-native extension);
   - tests that start gVisor sandboxes can't run inside one (no nested gVisor), so those run in CI or through a host-side test tool;
   - a `.mcp.json` in the repository pointing at the drive, so new Claude Code sessions, cloud ones included, open a drive session and work there.
6. Next wave picks from: the file system daemon swapped in, approvals and taint, the model ring check on Johann's sample, Agent Substrate.

## What Johann needs to provide, and when

| Item | Needed by checkpoint |
| --- | --- |
| AWS development account, dedicated user, connector | 3 |
| Cloudflare account and a domain (a free quick tunnel works for a first test) | 3 |
| One or two non-sensitive folders | 4 |
| About an hour in claude.ai and ChatGPT | 3 |
| A model API key for OpenCode and Open WebUI (Anthropic or another provider) | 2 |
| A deploy key for `agent-drive`, held on the VM, for `drive git push` | 5 |
