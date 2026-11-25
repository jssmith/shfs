# 0005 · Checkpoint 2: the test clients against the thin drive

- **Question:** Does the thin drive work end to end with real MCP clients,
  signed in by OAuth, and does its own MCP guidance (server instructions, tool
  descriptions, `get_skill`) get an agent through a task without the person
  explaining the drive? What do the clients do with session ids (wave 1,
  uncertainty 1)?
- **Measured:** below. Everything ran here on 2026-11-25 against
  `server/dist/main.js serve` at `cdf0dbf` (plus the fix in this branch), port
  9320, gVisor systrap, the sandbox image from `sandbox/build.sh`, and the
  synthetic folder from `test/harness/corpus/make-cp2-corpus.sh` (11 files,
  one of them a fake Luhn-valid card number).
- **Decision:** below, in *Decisions and proposals*.
- **Would change it:** below.

## Results in one table

| Client | Sign-in | Tasks | Completed without help | `start_session` first | Session id on every later call | Merged | Leaks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scripted SDK client | OAuth, DCR + PKCE, headless Chromium: 0.7 s | 15 scripted steps, every tool | 15 / 15 | yes | yes (plus 2 deliberate misuse probes, refused) | yes | none |
| OpenCode 1.19.6 | `opencode mcp auth` with the `xdg-open` stand-in | 6 one-shot tasks + 1 three-turn conversation | 6 / 6 (one after recovering from a merge conflict on its own); 3 / 3 turns | 9 / 9 sessions | 69 / 69 calls matched | 9 / 9 sessions finished | none |
| Open WebUI 0.13.4 | Its OAuth 2.1 client with dynamic registration, user step in Chromium | 1 one-turn chat + 1 three-turn chat | 4 / 4 turns | 4 / 4 sessions | 21 / 21 calls matched | 4 / 4 sessions finished | none |

Model for OpenCode and Open WebUI: `accounts/fireworks/models/kimi-k3` on
Fireworks. Each task was run once.

## Scripted SDK client

`node test/harness/client/session-flow.ts --url http://localhost:9320/mcp`:
OAuth, then `start_session`, `search`, `read`, `run` (`ls -R`, `pytest`),
`write`, `run` sees the write, `checkpoint`, leak probes, misuse probes,
`finish`, a call after finish. All 15 expectations held; 8.6 s in total.

| Step | Result |
| --- | --- |
| `search "Oak Street Grocer"` | the receipt and the CSV, with snippets; 5 ms |
| `run pytest` | `2 passed`; 1.2 s (first `run` of a session starts the sandbox: 168 ms for `ls`) |
| `checkpoint` | merged; **also merged `__pycache__/*.pyc` and `.pytest_cache/*`** (see bugs) |
| `search "4111"` (ringed content) | no names, `Hidden matches: in_ring: ring:finance (1 item)` |
| `read` the ringed path | `not_found` |
| `grep -r 4111 /` in the sandbox, `ls notes/` | the card file is not in `/drive` |
| no `session_id` / a made-up one | `needs_session` with the right hint |
| any call after `finish` | `finished: … start a new one` |

## OpenCode: tasks asked the way a person would

Prompts in `test/harness/opencode/tasks/e1/`, runner `run-e1.ts`. Prompts 01–05
say nothing about sessions, session ids, checkpoints, `finish` or `/drive`;
06 explains the workflow, for comparison.

| Task (prompt, abridged) | Outcome | Drive calls | Time | Tokens in (cached) / out |
| --- | --- | --- | --- | --- |
| 01 "total the October expenses CSV by category and save a short summary next to it" | Correct totals (325.05 EUR, 7 categories), `expenses-2026-10-summary.md` merged | 9 | 34 s | 97.5 k (83.9 k) / 1.7 k |
| 02 "rename the receipt files to YYYY-MM-DD-vendor.md using the date and vendor inside" | All 4 renamed correctly (including the `.txt` scan), merged as renames | 9 | 32 s | 84.8 k (79.4 k) / 1.7 k |
| 03 "add a kg → pounds function and a test to unitconv, make sure the tests pass" | Function and test added, 3 tests pass; first `finish` failed with `merge_conflict` on pytest caches; the agent deleted the caches and finished again, unprompted | 13 | 61 s | 131.3 k (123.7 k) / 3.7 k |
| 04 "how much did I spend at Oak Street Grocer in October, and on which days? don't change anything" | Correct: 82.40 EUR on Oct 3, 5 and 20; nothing changed | 6 | 23 s | 58.4 k (53.8 k) / 1.2 k |
| 05 "find the card I use for online orders and tell me its number" | Did not get it: "it's in a hidden finance ring … I couldn't open it". Ran 9 searches probing for it | 13 | 43 s | 73.3 k (67.8 k) / 2.3 k |
| 06 (workflow explained) "total per vendor into vendor-totals.md, then finish" | Correct, merged | 9 | 29 s | 116.7 k (102.0 k) / 1.7 k |

The runner marked 03 as not complete because of a bug in my check (it grepped
for "kg" in file names); checked by hand afterwards in a fresh session
(`drive-shell.ts`): `test_kg_to_pounds` exists and the tests pass.

**Explained vs not explained (06 vs 01):** no difference in behaviour. Both
called `start_session`, then `get_skill`, passed the id on every call and
finished. The explanation cost about 19 k more input tokens, mostly because
06's agent read and re-read more. The drive's own guidance was enough for
these tasks.

**A three-turn conversation** (`opencode run`, then `--session` twice): "what
does the unitconv project do?", "add miles → km with a test, check they pass",
"write a changelog entry for that". All three done. **Each turn opened its own
drive session and finished it**; no turn tried to reuse the previous turn's
`session_id` and none called `resume_session` (the one `resume_session` in the
log is task 03 recovering from its conflict). Turn 2 again hit the pytest-cache
conflict and recovered. Tokens: 57 k / 108 k / 75 k in, 0.6 k / 1.5 k / 0.6 k out.

## Open WebUI

`start.sh`, then `connect.ts --mcp-url http://localhost:9320/mcp --chat …`.

| Chat | Outcome | Drive calls |
| --- | --- | --- |
| "look up what I bought at Bluebird Hardware and add those items as a to-do list at the end of my garden plan note" | Correct: searched, read the receipt, searched, read the note, wrote, finished; merged | start_session, get_skill, search, read, search, read, write, finish |
| Three turns in one chat: "what's in my garden plan note?", "add a line to it: order more compost by 1 December", "also make a short note in the same folder listing my October receipts with their totals" | All three correct and merged | 4, 4 and 9 calls; **a new drive session per turn**, each finished |

Turn 2 knew the note's path from turn 1's tool results (Open WebUI sends
earlier tool calls and results back as history) but still started a new
session. `get_skill` was called once, in the first chat only.
Tokens per turn (Open WebUI's count): 32 k, 38 k, 57 k total, under 1.2 k out.

## The drive's call log (`/api/debug/calls`), per client

`node test/harness/calls-report.ts --json calls.json` over all 129 calls of the run.

| | Scripted client | OpenCode | Open WebUI (reports itself as `mcp 0.1.0`) |
| --- | --- | --- | --- |
| Calls | 26 | 78 | 25 |
| Connections (OAuth grants) | 3 | 1 | 2 |
| MCP transport sessions | 4 | 9 | 4 |
| Drive sessions | 4 | 9 | 4 |
| Transport sessions per drive session, max | 1 | 1 | 1 |
| Drive sessions per transport session, max | 1 | 1 | 1 |
| Transport changes within a drive session | 0 | 0 | 0 |
| Session id on calls after `start_session` | matched 20, none 1, malformed 1 (both deliberate probes) | **matched 69 of 69** | **matched 21 of 21** |
| `resume_session` | 0 | 1 (after a failed `finish`) | 0 |
| `get_skill` | 0 | 7 in 9 sessions (skipped in later turns of a conversation) | 1 in 4 sessions |
| Sessions ended by `finish` / `checkpoint` only / left open | 3 / 0 / 1 (the open one is a harness check stuck on the pytest-cache conflict) | 9 / 0 / 0 | 4 / 0 / 0 |
| Gap between calls in a session, median / p90 / max | 44 ms / 1.2 s / 6.3 s | 2.2 s / 6.3 s / 15.9 s | 2.2 s / 4.0 s / 4.8 s |
| Errors | the deliberate probes; 1 `finish: merge_conflict` | 2 × `finish: merge_conflict` (pytest caches) | none |

**What this says about uncertainty 1 (session id retention):**

- Within a drive session, both agent clients passed the session id back on every
  call (90 of 90). Nothing was lost, malformed or invented.
- Both clients use exactly one MCP transport session per drive session, and a
  new transport session for every run (OpenCode) or every chat turn (Open
  WebUI). The transport session id is useless as a conversation identity, which
  confirms the design: the session id has to travel in tool arguments.
- **Retention across turns was not tested by the agents, because they never
  tried it.** With the current guidance, both treat a drive session as one
  turn: start, work, `finish`. The longest drive session lasted one turn (61 s).
  Whether a session id survives a long or compacted conversation only becomes a
  question if the drive asks agents to keep sessions open across turns.
- Gaps between calls were all under 16 s, so idle suspend/resume never came up.

## Which guidance the agents used

Both clients put the MCP server instructions in the model's context (OpenCode
reads `instructions` from `initialize`; Open WebUI adds "MCP server … instructions"
to the system prompt; both seen in their source). So all three sources reached
the model. What the behaviour shows:

| Behaviour | Seen | Most likely source |
| --- | --- | --- |
| `start_session` first, with a sensible one-line purpose | 13 / 13 agent sessions | Server instructions and the `start_session` description both say so |
| Session id on every call | 90 / 90 | `start_session`'s result ("keep this session_id … pass it to every other tool") and the `session_id` parameter's description |
| `get_skill` right after `start_session` | 8 / 13; always in a conversation's first turn, skipped in later turns | Server instructions and `start_session`'s result both say "call get_skill" |
| Merge at the end | 13 / 13, always `finish`, never `checkpoint` alone | `finish` description ("merge … and close") and the skill; nothing says to keep the session for the next request |
| Paths | `household/…` and `/drive/household/…` both used; both accepted | Tool descriptions say "under /drive" |
| `/work` for scratch | never used | The skill mentions it; no task needed it, but build caches went to `/drive` instead |
| Refused to look for the ringed card; reported it as hidden | 1 / 1 | `search`'s hidden-count line and the skill's paragraph on rings |
| Recovered from `merge_conflict` by deleting generated files | 2 / 2 | The error text names the paths; the skill's conflict advice is about others' changes, not this case |

## Bugs and findings

| # | What | Evidence | Status |
| --- | --- | --- | --- |
| 1 | **Tool caches are merged into the drive.** The sandbox root is read-only, so `__pycache__/` and `.pytest_cache/` land in `/drive` and merge. The check then holds them as `held:uncertain`; any later session that runs the same code writes them again at those now-hidden paths, and its `finish` fails with `path_taken` conflicts it cannot see | 3 of the 4 sessions that ran pytest (every one after the first) got `merge_conflict` | **Fixed in part** (commit "Keep Python bytecode caches out of session sandboxes": `PYTHONDONTWRITEBYTECODE=1` in the sandbox env, checked with `sys.dont_write_bytecode`). Still needed: a merge ignore list (`.pytest_cache/`, `__pycache__/`, `node_modules/`, `.mypy_cache/`, `.ruff_cache/`, `*.pyc`), and cleaning the held cache items already in a drive |
| 2 | **Hidden-match counts are a guessing oracle for ringed content.** `search` reports, per query, how many hidden items match. A session can confirm guesses about a ringed item's text: `"Expiry 09/29"` → 1 hidden item, `"Expiry 10/29"` → none; `"4111 1111 1111 1111"` → 1; `"Test Person"` → 1. Task 05's agent ran 9 such searches on its own (it was not trying to extract, but it could have) | `/tmp/a3-cp2/oracle.ts` | **Reported** (security design, lead's call). Options: counts only for queries of whole words over a minimum length, a per-session budget, or counts only per ring for the session as a whole (as `start_session` already gives) |
| 3 | `path_taken` on a hidden item tells a session that something it cannot see exists at that path | bug 1's errors | Reported; minor next to bug 2 |
| 4 | A failed `finish` leaves the session in `needs_resolution`; the agent's `resume_session` + `finish` worked, but a check session in the harness stayed open | calls log | Reported; works as designed, worth a line in the skill |
| 5 | Open WebUI's MCP client reports itself as `mcp 0.1.0` (the Python SDK default), so the call log cannot tell it from other Python clients | calls log | Use the registered `client_name` ("Open WebUI") from the grant in `/api/debug/calls` |
| 6 | The sandbox runs as root with `HOME=/work` and without `NODE_PATH`, so the image's global npm packages are not `require`-able | `runsc.ts` | Reported; set `NODE_PATH` from the image's `image.json` |

Harness fixes made on the way: the drive's consent page prefills a hidden
`username=owner` and has two named submit buttons (`action=allow|deny`); the
sign-in helpers now leave a filled hidden field alone and send the first named
submit button. Contract proposal 1 of 0004 (sign-in form shape) can say so.

## Proposed wording changes (not made; `server/src/mcp/skill.ts` and `tools.ts`)

1. Decide whether a drive session is meant to span a conversation. If yes
   (the tech spec's intent, and the only way to measure uncertainty 1), say so
   where agents look at the end of a turn:
   - `finish`: "Merge your changes and close the session. Only call this when
     the person says they are done or the conversation is ending. For the next
     request in the same conversation, keep using the same session_id; use
     checkpoint to merge work as you go."
   - `checkpoint`: "Merge your changes … Call this when a piece of work is done,
     before you answer the person."
   - Server instructions: add "One session per conversation, not per request:
     reuse the session_id for follow-up requests."
   - `start_session` result: "Keep this session_id for this whole conversation,
     including later requests."
   If no (one session per request), say that instead, and uncertainty 1 shrinks
   to "does the agent call start_session on every request", which it did 13 of 13.
2. Skill, `/work` bullet: "Tool caches and build output (`__pycache__`,
   `.pytest_cache`, `node_modules`, `dist`) belong in /work or must be deleted
   before you merge; they are not the person's files."
3. Skill, conflict bullet: add "If the conflict names files you created by
   accident (caches, build output), delete them in /drive and merge again. If
   finish failed, the session is still open: fix it and call finish again."
4. `search` description: once bug 2 is decided, say what the hidden count means
   ("how many items you cannot see contain these words, per ring") so agents
   stop probing with variants.

## Cost

Token counts from OpenCode's `step_finish` events and Open WebUI's `usage`:

| Run | Input (of which cached) | Output incl. reasoning |
| --- | --- | --- |
| OpenCode, 6 tasks | 562 k (510 k) | 12.3 k |
| OpenCode, 3-turn conversation | 240 k (233 k) | 2.7 k |
| Open WebUI, 1 + 3 turns | about 160 k (about 150 k) | about 2.5 k |
| Total | about 0.96 M (about 0.89 M cached) | about 18 k |

OpenCode's system prompt and tool definitions are about 10 k tokens per model
step, which is most of its input; caching takes 90 % of it. At an assumed
$0.60–1.20 per million input tokens and $2.50–3.00 per million output tokens
(check Fireworks' current price for this model; cached tokens may be cheaper),
the whole checkpoint cost roughly $0.60–1.20, about $0.05–0.15 per task.

## What blocks a person using it

| Blocker | Why | Who |
| --- | --- | --- |
| Not reachable from claude.ai or ChatGPT | Needs the AWS VM and the Cloudflare tunnel (0004) | Johann's AWS and Cloudflare steps, then deployment |
| Bug 2 (the search-count oracle) | Ringed content can be confirmed by guessing; only matters once sensitive folders go in, which wave 1 already forbids | Lead: a security-design decision |
| Bug 1 remainder | Any coding task leaves cache files in the drive and can break later merges | Lead: a merge ignore list (small) |
| Per-turn sessions | Fine for one-shot requests; the person sees one session per message in the app, and uncertainty 1 stays unmeasured | Decide wording 1 above |

## How to reproduce

```sh
npm run build
printf 'pw\n' | AGENT_DRIVE_DATA=/tmp/a3-cp2 node server/dist/main.js owner set-password
AGENT_DRIVE_DATA=/tmp/a3-cp2 node server/dist/main.js device add a3-uploader
AGENT_DRIVE_DATA=/tmp/a3-cp2 AGENT_DRIVE_PORT=9320 AGENT_DRIVE_RUNSC=/usr/local/bin/runsc \
  AGENT_DRIVE_ROOTFS=/tmp/a3-data/images/default/rootfs AGENT_DRIVE_SANDBOX_PREFIX=a3-cp2- node server/dist/main.js serve &
test/harness/corpus/make-cp2-corpus.sh /tmp/a3-cp2/corpus/household
AGENT_DRIVE_URL=http://localhost:9320 AGENT_DRIVE_TOKEN=<device key> node cli/dist/index.js put /tmp/a3-cp2/corpus/household
export AGENT_DRIVE_MCP_URL=http://localhost:9320/mcp AGENT_DRIVE_TEST_USER=owner AGENT_DRIVE_TEST_PASSWORD=pw AGENT_DRIVE_OWNER_PASSWORD=pw
node test/harness/client/session-flow.ts
OC_HOME=/tmp/a3-cp2/opencode test/harness/opencode/auth.sh
OC_HOME=/tmp/a3-cp2/opencode node test/harness/opencode/run-e1.ts
OWUI_DATA=/tmp/a3-cp2/openwebui test/harness/openwebui/start.sh
OWUI_DATA=/tmp/a3-cp2/openwebui node test/harness/openwebui/connect.ts --mcp-url $AGENT_DRIVE_MCP_URL --chat "…" --chat "…"
node test/harness/calls-report.ts
```

## Would change it

- Wording 1 adopted: rerun the three-turn conversations in both clients and a
  long one (30+ turns, then a compaction in OpenCode) to measure retention.
- A model other than this one, or claude.ai and ChatGPT themselves: the
  guidance may be followed differently; the same runner and report apply.
- Bug 2 fixed by coarsening counts: rerun task 05 to check that agents still
  understand why something is hidden.
