# Working in agent-drive

Agent Drive: one owned home for a person's files and context, with a computer attached; agents connect over MCP and work in sessions. Design documents are in the separate design repository (jssmith/design-agent-drive, `docs/`); the current work plan is `docs/wave-1.md`, the boundaries between parts are `docs/contracts.md`.

## Rules

- **Synthetic data only.** Never put real personal data in this repository, its tests or its logs. The repository will be public.
- **No secrets** in code, tests, logs or commits. No tokens inside session sandboxes, ever.
- **Stay in your area.** Parallel agents each own directories (see `docs/wave-1.md`). Changing a contract in `docs/contracts.md` or `server/src/store/schema.sql` needs the lead session's review; say so in the commit message.
- **Every spike ends with a decision record** in `docs/decisions/NNNN-title.md`: the question, what was measured (numbers, how), the decision, what would change it.
- **Measure, don't assert.** Claims about speed, correctness or isolation come with the command that shows them.
- Tests: `npm test` (Vitest) for TypeScript, `cargo test` in `fs/` for Rust. Add tests with the code.

## Conventions

- TypeScript, ES modules, strict mode, Node 22 or later. Small modules, plain functions, no framework unless it earns its place.
- Rust for `fs/` only.
- Writing in docs: plain, short sentences; tables for comparisons.
- Commit messages: imperative subject; body says why. Do not name the AI assistant or model that wrote the code in commits, code or docs. Naming the models a component or test uses (a local ring-check model, a test client's model) is fine and belongs in decision records.

## The shared machine

Several agents may share one workspace. Use your assigned port range and name prefix for servers, sandboxes and containers; keep scratch files under your own scratch directory; unmount and stop what you start. Docker, if needed, may have to be started: `dockerd` as a background process. gVisor's `runsc` is at `/usr/local/bin/runsc` with its sidecars in `/usr/local/bin/gvisor-bin/` (the environment's setup script installs both; `sandbox/install-runsc.sh` does the same elsewhere).

When changing `server/src/mcp/tools.ts` or `skill.ts`, update `docs/mcp-tools.md` in the same commit.
