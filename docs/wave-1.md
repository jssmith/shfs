# Wave 1: phase A spikes

Status: **proposed, for Johann's review** · 2026-11-25
Implements phase A of the [implementation plan](https://github.com/jssmith/design-agent-drive/blob/main/docs/implementation-plan.md). The open questions each spike answers are in the [register](https://github.com/jssmith/design-agent-drive/blob/main/docs/open-questions.md).

## How the work is split

- **Step 0, done first by the lead session:** the repository skeleton every agent builds on (TypeScript workspace on Node 24 with Vitest, a Rust workspace for `fs/`, shared conventions, a CI workflow). About an hour. Agents start from it so they don't each invent a layout.
- **Then five agents in parallel**, each in its own git worktree and branch (`spike/a3-merge`, …), each writing only under its own directories, so they cannot conflict. Each ends with a decision record in `docs/decisions/`, its numbers, and a pushed branch. Nothing merges to `main` until the lead session has reviewed it, and Johann sees the decision records.
- **Shared machine rules:** this workspace has 4 CPUs and 15 GB of RAM, and the agents share Docker, gVisor and mounts. Each agent gets its own port range, name prefix for sandboxes and containers, and scratch directory, and cleans up after itself. Heavy steps (Rust release builds, a Kubernetes cluster) are not run at the same time.
- **Test data is synthetic only.** No agent touches anything outside the repository and its scratch directory.

## The agents

| Agent | Spike | Builds | Measures and decides | Code kept? |
| --- | --- | --- | --- | --- |
| 1 | **A3 · Merge and undo** | The store's working-space model in TypeScript: base states, change packages, all-or-nothing merge with three-way text merge, conflicts as files, `resolve`, undo with per-item conflicts. A randomised test that runs thousands of interleaved session operations and checks after each step that merged work is never lost, undo never overwrites, a failed merge changes nothing, and states reconstruct exactly | Correctness under the invariants; time to merge 10k items | Yes: becomes `server/src/merge` |
| 2 | **A9 · Drive file system** | A Rust daemon on fuse-backend-rs over a stub store: per-session listings, reads from blobs, writes to a working space, rename-over-existing, symlink views, an open log. Mounted with FUSE into gVisor (`--file-access-mounts=shared`) | Live hide on trash (must be immediate); latency and throughput for `git status`, `ripgrep`, a Python import, against a plain bind mount; whether fuse-backend-rs can also serve virtio-fs (the KVM half waits for the AWS VM) | Yes: becomes `fs/` |
| 3 | **A5 · Package registry** | A caching PyPI and npm registry in TypeScript. Two ways for a gVisor sandbox to reach it with no other network: a network namespace whose only route is the registry, and a mounted Unix socket with a tiny forwarder. A cache-only mode for tainted sessions | Install times for 20 common packages, cold and warm; that nothing else is reachable; which mechanism | Registry yes; mechanism code only if chosen |
| 4 | **A6 · Sandbox** | A red-team script run inside gVisor: reach the internet, host services, the store, other sessions' directories, ringed items via symlinks, `..`, hard links and xattrs; survive checkpoint and restore with anything it shouldn't have. Checkpoint size and restore time with real workloads. Whether `runsc` runs rootless | The gVisor configuration for phase B; rootless or root | Red-team suite yes, as a test |
| 5 | **Synthetic corpus** | A generator for test data: receipts rendered as images and scanned PDFs (for OCR), fake bank statements with valid-format fake account numbers, fake IDs, the 200-item credentials-like set, contracts, notes and photos. Ground-truth labels for every item | Nothing; it's the shared test data for A2, A4, the leak suite and end-to-end tests | Yes: `test/fixtures` |

**After wave 1:** A8 (Agent Substrate on a single-node Kubernetes cluster), once A6 and A9 are done, since it needs both and is the heaviest on this machine. Then A2 (Claude Code working through `/drive`), which needs A3, A9 and the corpus.

**Not in wave 1, and why:** A1 needs your claude.ai and ChatGPT accounts (about an hour, with a script I'll write); A4 needs a sample of your files to label; A7 needs the API key; the virtio-fs half of A9 needs the AWS VM.

## Your parallel track (AWS)

1. A separate AWS account for development (an AWS Organizations member account), with a budget alert.
2. A dedicated IAM Identity Center user with a role in that account only: EC2 full access there, `ssm:SendCommand` allowed only on instances tagged `agent-drive=dev`, no IAM administration, no billing.
3. Add the AWS MCP connector at claude.ai, signed in as that user.
4. A new session then tests `send-command` and creates the first development VM from a script this session writes.

I'll write the exact steps for 1 and 2 when you're ready.

## Cost and time

Five agents working for roughly one to three hours each. Step 0 and the reviews are done by the lead session.
