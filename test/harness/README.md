# Test harness: driving MCP clients without a person

Three clients, from fast and deterministic to realistic. All take the drive's
MCP URL (`AGENT_DRIVE_MCP_URL`, default the stub at `http://localhost:9301/mcp`)
and the sign-in credentials of the test user (`AGENT_DRIVE_TEST_USER`,
`AGENT_DRIVE_TEST_PASSWORD`; the stub's are `test` / `test-password`).
Decision record: `docs/decisions/0004-deployment-and-test-clients.md`.

| Client | Run | Needs |
| --- | --- | --- |
| Scripted SDK client | `node test/harness/client/run.ts --url URL --login browser --call 'echo={"text":"hi"}'` | Node 22.18+; Playwright for `--login browser` (else `--login form`) |
| OpenCode | `test/harness/opencode/auth.sh`, then `test/harness/opencode/run-task.sh --expect-tool drive_echo "…"` | `opencode` on PATH, a model key (Fireworks through the proxy here) |
| Open WebUI | `test/harness/openwebui/start.sh`, then `node test/harness/openwebui/connect.ts --chat "…"` | Docker, a model key |

The stub: `node test/harness/stub/server.ts` (port `STUB_PORT`, default 9301).
It logs one JSON line per request: method, path, MCP session id, tool, status.
Its tests run with `npm test` (`test/harness/src/stub-oauth.test.ts`).

What the real server's sign-in page needs for these to work unchanged: a
`<form>` with a user field (`name="username"` or `type="email"`), a
`type="password"` field and a `type="submit"` button. Otherwise set
`LOGIN_USER_SELECTOR`, `LOGIN_PASSWORD_SELECTOR`, `LOGIN_SUBMIT_SELECTOR`.

Everything a run writes (tokens, OpenCode's home, Open WebUI's data) goes to
`/tmp/a3-data/…`, never the repository. Tokens there are for the test user only.

## Multi-turn session experiments (`sessions/`)

`sessions/run-matrix.ts` runs scripted conversations (`sessions/conversations.ts`)
in OpenCode and Open WebUI against a fresh drive per run, in parallel slots,
checks each turn against the drive, and writes an ATIF-v1.8 trajectory per run
(`sessions/atif.ts`, validated by `sessions/validate_atif.py` with Harbor's
models and the `atif` package). `sessions/report.ts` prints the tables from the
trajectories. Data goes under `/tmp/a6-*`. Decision record:
`docs/decisions/0006-session-continuity-experiments.md`, which has the commands.
