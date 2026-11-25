# 0006 · Session continuity: one drive session per conversation

- **Question:** Checkpoint 2 (0005) found that agents open and finish a new
  drive session for every message of a conversation. What drives that, and
  which of the four MCP surfaces (`AGENT_DRIVE_SURFACE` v0–v3) gets agents to
  keep one session for a whole conversation, at what cost in task success,
  merge history and tokens?
- **Measured:** 32 multi-turn conversations (4 surfaces × 2 clients × 2
  conversations × 2 repeats) plus 6 OpenCode runs with a shrunken context
  window to force compaction, all on 2026-11-25 against `origin/main` at
  `7a66d00`, model `accounts/fireworks/models/kimi-k3`. Numbers and commands
  below. Every run is also an ATIF trajectory, and the tables are computed
  from those.
- **Decision:** below, in *Recommendation*. In short: any of v1, v2, v3
  fixes it (one session in 30 of 30 conversations, every later drive call on
  the first session's id); v3 does it with the fewest calls and tokens.
- **Would change it:** below.

## Method

`test/harness/sessions/run-matrix.ts` runs each (client × surface ×
conversation × repeat) against its own fresh drive: own data directory, port
and sandbox prefix, the synthetic corpus from
`test/harness/corpus/make-sessions-corpus.sh` uploaded and ring-checked, then
the conversation in one client conversation, then what the drive saw
(`/api/debug/calls`, packages, sessions, files) and what the client saw.

| Piece | How |
| --- | --- |
| Clients | OpenCode 1.19.6: one OpenCode session across turns (`opencode run --session <id>` after the first turn; `--continue` also exists). Open WebUI 0.13.4 (`ghcr.io/open-webui/open-webui:main`): one chat across turns, the drive as a native MCP tool server. Both reach the drive with a Bearer token from `agent-drive connection add`, not OAuth (0005 covered sign-in; OpenCode's OAuth callback has a fixed port that parallel runs would fight over) |
| Conversations | C3: three turns on the household expenses (total by category and save a summary; also by month; rename the file). C10: ten turns: overview, a spending question, a note edit, a kg→lb function with a test, a date question, a to-do list in the note, a rounding change with tests, a recall question answered from earlier turns, a changelog entry, "That's all for now, thanks!". Written the way a person talks: no sessions, ids, finishing, merging, /drive or tools (`conversations.ts`) |
| Checks per turn | Machine-checked against two views after the turn: the **shared drive** (what the person sees; "merged") and the agent's own working copy (`data/sessions/<dir>/upper`; "done"). File contents with the right numbers, file renamed and old name gone, `pytest` passing on a copy of the tree (run with `unshare -n`), functions called from Python, replies containing the right facts, read-only turns changing nothing. Tool caches (`.pytest_cache`, `__pycache__`…) are left out of both views, as the merge leaves them out. The runner waits 5 s after each turn before looking, so v2/v3's automatic merge (2 s after the last change) has landed |
| Leak check | The corpus has one item the ring check hides (an invented card number, `notes/card-for-online-orders.txt`). Every trajectory is searched for its digits, expiry and name |
| Baseline | v0 ran from the same build as v1–v3 (`7a66d00`), where search's hidden-match counts come from labels, kind and month only. A first v0 try on the older main (`9841fd7`, C3, both clients) showed the same pattern: 3 sessions in 3 turns, each finished |
| Corpus change | The ring check now skips documented test card numbers, so `4111 1111 1111 1111` from the checkpoint-2 corpus was no longer hidden. The sessions corpus overwrites that file with an invented Luhn-valid number on no test list (verified hidden: `rings = ["ring:finance"]`) and adds a September expenses CSV |

### Parallel runs

Measured first without a model (`bench-parallel.ts`: N drives at once, each
running pytest in its sandbox 6 times):

| Runs at once | Drive start, max | pytest call median / p90 | load1 after |
| --- | --- | --- | --- |
| 1 | 1.5 s | 754 / 778 ms | 0.62 |
| 2 | 2.1 s | 801 / 865 ms | 0.81 |
| 3 | 3.0 s | 856 / 905 ms (+14 %) | 1.15 |
| 4 | 4.3 s | 999 / 1,126 ms (+32 %) | 2.32 |

Chosen: **3 at once**. Most of a run is waiting for the model, so the real
matrix loaded the machine less than the benchmark: load1 mean 1.06 / 0.81,
max 1.99 / 1.89 over the two 16-run matrices (sampled every 5 s); drive-side
`run`/`bash` calls had median 141 ms, p90 920 ms over 195 calls. Each slot owns
a drive port (9610+slot) and an Open WebUI container (`a6-owui-<slot>`,
9660+slot), started before the runs and asynchronously (a synchronous start
stalled the other slots' clients on the first attempt; those runs were thrown
away). A 16-run matrix took 14–15 minutes.

```sh
npm ci && npm run build                       # in a checkout of origin/main at 7a66d00 (/tmp/a6-build/main)
node test/harness/sessions/bench-parallel.ts --max 4 --rounds 6
node test/harness/sessions/run-matrix.ts --clients opencode,openwebui --variants v0,v1,v2,v3 \
  --conversations C10,C3 --repeat 1 --parallel 3 --settle 5 --keep-owui --server-root /tmp/a6-build/main --out /tmp/a6-runs/m1
node test/harness/sessions/run-matrix.ts … --first-rep 2 --out /tmp/a6-runs/m2
node test/harness/sessions/run-matrix.ts --clients opencode --variants v1,v2,v3 --conversations C10 \
  --oc-context 26000 --label ctx26k --server-root /tmp/a6-build/main --out /tmp/a6-runs/compact26
node test/harness/sessions/report.ts /tmp/a6-runs/m1 /tmp/a6-runs/m2 --runs --turns
```

## Results

From `report.ts /tmp/a6-runs/m1 /tmp/a6-runs/m2`, two runs per row (values
per run where two are given). "Later drive turns reusing" counts, over turns
2…n that called the drive at all, those whose calls used a session opened in an
earlier turn (recall and closing turns are often answered without a call).

| Surface | Conv | Client | Drive sessions per conversation | Later drive turns reusing | Turns done / merged | Merge packages | Left open at end | Drive calls | Tokens in / out (k) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v0 | C3 | OpenCode | 3, 3 | 0/4 | 6/6, 6/6 | 3, 3 | 0, 0 | 16, 16 | 267 / 4.2, 276 / 4.3 |
| v0 | C3 | Open WebUI | 3, 3 | 0/4 | 6/6, 6/6 | 3, 3 | 0, 0 | 14, 16 | 145 / 3.3, 161 / 3.4 |
| v0 | C10 | OpenCode | **6, 8** | 0/12 | 20/20, 20/20 | 5, 5 | 0, 0 | 33, 40 | 674 / 8.3, 816 / 7.6 |
| v0 | C10 | Open WebUI | 1, 1 | 16/16 | 20/20, 20/20 | 5, 5 | 0, 0 | 25, 32 | 342 / 4.4, 423 / 5.7 |
| v1 | C3 | OpenCode | 1, 1 | 4/4 | 6/6, 6/6 | 3, 3 | 1, 1 | 12, 14 | 204 / 3.9, 224 / 4.1 |
| v1 | C3 | Open WebUI | 1, 1 | 4/4 | 6/6, 6/6 | 3, 3 | 1, 1 | 13, 14 | 132 / 3.2, 135 / 3.6 |
| v1 | C10 | OpenCode | 1, 1 | 16/16 | 20/20, 20/20 | 5, 5 | 0, 0 | 30, 28 | 594 / 7.3, 551 / 6.2 |
| v1 | C10 | Open WebUI | 1, 1 | 16/16 | 20/20, 20/20 | 5, 5 | 0, 0 | 29, 29 | 372 / 4.7, 380 / 4.8 |
| v2 | C3 | OpenCode | 1, 1 | 4/4 | 6/6, 6/6 | 3, 3 | 1, 1 | 10, 14 | 184 / 3.3, 234 / 4.2 |
| v2 | C3 | Open WebUI | 1, 1 | 4/4 | 6/6, 6/6 | 3, 3 | 1, 1 | 11, 12 | 122 / 3.7, 141 / 3.4 |
| v2 | C10 | OpenCode | 1, 1 | 14/14 | 20/20, 20/20 | 6, 6 | 1, 1 | 22, 24 | 445 / 5.6, 543 / 7.3 |
| v2 | C10 | Open WebUI | 1, 1 | 14/14 | 20/20, 20/20 | 6, 6 | 1, 1 | 19, 20 | 297 / 4.3, 294 / 3.9 |
| v3 | C3 | OpenCode | 1, 1 | 4/4 | 6/6, 6/6 | 3, 3 | 1, 1 | 7, 11 | 136 / 3.1, 183 / 4.2 |
| v3 | C3 | Open WebUI | 1, 1 | 4/4 | 6/6, 6/6 | 3, 3 | 1, 1 | 9, 7 | 96 / 2.6, 88 / 2.8 |
| v3 | C10 | OpenCode | 1, 1 | 14/14 | 20/20, 20/20 | 5, 5 | 1, 1 | 12, 17 | 343 / 5.4, 430 / 5.2 |
| v3 | C10 | Open WebUI | 1, 1 | 14/14 | 20/20, 20/20 | 5, 6 | 1, 1 | 11, 14 | 199 / 2.8, 243 / 3.8 |

Across all 32 runs: 156 of 156 turns done and merged; no conflicts; **no
leak** of the ringed item in any trajectory; 528 of 529 calls after
`start_session` carried a session id the drive matched (the other: Open WebUI
called `get_skill` in parallel with `start_session`, got `needs_session`, and
went on). Each turn that called the drive used a new MCP transport session (3
per C3 run, 8–10 per C10 run), so the drive's session id lives only in tool
arguments, as 0004 and 0005 found. One run (Open WebUI) had one recovered
error; no client errors.

The C10 turn-7 check (km_to_miles rounds to 3 places) compared against the
wrong string at run time and failed in every m1 run although the code was
right; `recheck.ts` re-evaluated it on the drive at the end of each run (no
later turn touches that function) and keeps the original result in
`run.json`. m2 and the compaction runs ran with the fixed check.

Mean per conversation, both repeats:

| Surface | C10 tokens in, OpenCode / Open WebUI (k) | C10 drive calls, OpenCode / Open WebUI | C3 tokens in, OpenCode / Open WebUI (k) |
| --- | --- | --- | --- |
| v0 | 745 / 383 | 36.5 / 28.5 | 272 / 153 |
| v1 | 573 (−23 %) / 376 (−2 %) | 29 / 29 | 214 / 134 |
| v2 | 494 (−34 %) / 296 (−23 %) | 23 / 19.5 | 209 / 132 |
| v3 | 387 (−48 %) / 221 (−42 %) | 14.5 / 12.5 | 160 / 92 |

## What drives the per-message sessions (v0)

Not the clients losing the id. **`finish` at the end of a turn** does it, and
the next request then needs a new session.

- **OpenCode on v0 calls `finish` at the end of every turn that touched the
  drive**, read-only turns included (C10 turn 1: `start_session, get_skill,
  run, read, run, finish`). Every later turn that used the drive opened a new
  session (12 of 12 in C10, 4 of 4 in C3). It answered the other 6 of the 18
  later C10 turns from earlier turns' tool results without any drive call
  (spending question, date, recall, closing).
- **Open WebUI on v0 does the same after an edit** (C3: three sessions, each
  finished), **but in C10 kept one session for all ten turns, twice**: turn 1
  was read-only and it did not call `finish`, so the session stayed open; from
  then on it passed the same id, merged each edit with `checkpoint`, and called
  `finish` only on "That's all for now, thanks!". The v0 wording already says
  "keep the session_id … for the whole conversation"; what it lacks is a
  reason not to finish.
- So: **both clients keep the session id across turns when nothing closes
  it.** OpenCode carries it in its session history (the earlier tool calls'
  arguments and results); Open WebUI in the history it resends (it expands each
  earlier turn's tool calls and results). The id was never lost, malformed or
  invented.

## Which variant fixes it

| | v1 (wording) | v2 (shell first, file tools, auto merge) | v3 (shell only, auto merge) |
| --- | --- | --- | --- |
| One drive session per conversation | 8 / 8 | 8 / 8 | 8 / 8 |
| New sessions after turn 1 | 0 | 0 | 0 |
| Turns merged | 52 / 52 | 52 / 52 | 52 / 52 |
| How work lands | `checkpoint` before answering (every edit turn), `finish` on the closing turn | automatically, 2 s after the last change | automatically |
| Session at the end of C3 (no closing turn) | open, nothing unmerged | open (never closed by design) | open |
| C10 drive calls, OpenCode / Open WebUI | 29 / 29 | 23 / 19.5 | 14.5 / 12.5 |

All three fix continuity equally in these runs. The differences are cost and
the history the person sees.

## Side effects

| Effect | Seen | Notes |
| --- | --- | --- |
| Merge noise in history | v0/v1: one package per edit turn (5 in C10). v2: 6 in C10 every time; v3: 5 (one run 6) | v2's extra package: the agent edited `unitconv.py`, then the test file 5 s later, so the automatic merge landed the function without its test first. The shared drive briefly held a half-done change. v3 did the same once. A burst within 2 s coalesces; a slower agent splits |
| Summaries in history | v0/v1: the agent's own summary ("Added kg_to_pounds (1 kg = 2.20462 lb) … and a matching test"). v2: "Saved automatically after: edit /drive/household/projects/unitconv/unitconv.py". v3: from `bash`'s description ("Add kg_to_pounds function and test, show both files") | v2's file tools give no description, so its history says least about why |
| The last save goes unreported | v2/v3: the `[drive]` outcome of an automatic merge appears at the head of the *next* tool result, so the last change of a turn is never confirmed to the agent before it answers (e.g. C3 turn 3's rename) | All merged here (one agent, no conflicts). With a conflict the agent would have said "done" and the person would find out later |
| Conflicts | none in 38 runs | One agent per drive; concurrent sessions were not tested |
| Task success | 156/156 turns in all surfaces | No surface made the agents worse at the work |
| Sessions left open | v1: open at the end of C3 with nothing unmerged; v2/v3 always open | Harmless here; the server must expire them (0004 proposal 6) |
| Tokens | v1 −2 to −23 %, v2 −23 to −34 %, v3 −42 to −48 % vs v0 in C10 | Fewer calls: no `get_skill` per turn, no start/finish per turn, shell does reading and writing |

### Compaction (OpenCode)

Kimi K3's C10 context peaked at 22–24 k tokens per model call, so OpenCode
never compacted at its real limit. With the model's context limit lowered in
OpenCode's config (`--oc-context`): at 40 k nothing compacted; at **26 k**
OpenCode compacted in all three runs (v1: 7 compactions from turn 4, six of
them during turn 7; v2: 2 from turn 7; v3: 1 in turn 10).

| | v1 | v2 | v3 |
| --- | --- | --- | --- |
| Session id after compaction | kept, same session to the end (0 new sessions) | kept | kept |
| Turns done / merged | 7/10: after the thrashing in turn 7 the agent lost the task (its reply was the compaction summary; km_to_miles not changed), then gave a wrong recall (23.40 instead of 82.40) and a changelog without the rounding change | 10/10 | 10/10 |
| Tokens in / out (k) | 861 / 19.6 | 468 / 8.2 | 441 / 6.6 |

So the drive's session id survives compaction (OpenCode's summary keeps it);
what compaction loses is the conversation's facts, which no surface can fix.
26 k is artificial; with this model and these conversations compaction does not
happen at real limits.

## Recommendation

1. **Keep one drive session per conversation, and make the default surface
   shell-first with automatic merge (v3's shape).** It fixes continuity as well
   as v1 and v2, with the fewest calls and tokens (about half of v0), and its
   history summaries come from the agent's own `bash` descriptions.
2. If clients that are weak at shell work matter (not tested here: both
   clients and this model handled `cat > file <<'EOF'` and `sed -i` without
   trouble), offer v2's `read`/`write`/`edit` too, but give `write` and `edit`
   a `description` argument like `bash`, so their merges say why.
3. Fix before adopting automatic merge (server; lead's call):
   - a change split across calls more than 2 s apart merges as several
     packages, landing half a change (function before test). Options: merge on
     the turn boundary (when no call has come for N seconds *and* the last
     result has been delivered), or let the agent group with `drive save`;
   - report the outcome of the last automatic merge where the agent will see
     it before answering, or tell the agent (skill, `bash` result) to run
     `drive status` at the end of a piece of work;
   - expire idle sessions server-side, since agents never close them.
4. If automatic merge is not adopted, **v1's wording alone is enough**: 16 of
   16 conversations kept one session, every edit turn ended with `checkpoint`,
   and `finish` came only when the person said they were done.

## ATIF trajectories

Every run is written as an **ATIF-v1.8** trajectory (Harbor RFC 0001, the
version the RFC defines at `harbor-framework/harbor` commit `90f2ee3`,
2026-11-24) to `<out>/trajectories/<run>.json`; two small examples are in
`test/harness/sessions/trajectories/`. The converter is
`test/harness/sessions/atif.ts`; `report.ts` reads only the trajectories.
Every file (32 + 6 + the examples) validates with **two implementations**:
Harbor's own Pydantic models and `TrajectoryValidator` (loaded from the pinned
checkout by `validate_atif.py`) and the `atif` package from PyPI (1.8.0,
Pydantic models for v1.8). Both catch non-sequential step ids and
`source_call_id`s with no matching tool call (checked with a broken sample).
The NVIDIA NeMo (`nat.atif`) and Go (`x/exp/eval/trajectory/atif`)
implementations were not used.

| Mapped cleanly | How |
| --- | --- |
| The conversation | Each scripted turn is a `user` step; the client's model calls follow as `agent` steps |
| OpenCode model calls | One `agent` step per `step_start … step_finish` (one LLM call): text as `message`, `tool_use` events as `tool_calls` (OpenCode's `callID` as `tool_call_id`) with their outputs as `observation.results`, `reasoning_content` from the reasoning parts in OpenCode's `opencode.db`, `metrics` from `step_finish` tokens (`prompt_tokens` = input + cache read, `cached_tokens` = cache read, `completion_tokens` = output + reasoning; reasoning and cache-write tokens in `metrics.extra`), `llm_call_count: 1` |
| Drive facts | `tool_calls[].extra.drive`: the matching row of `/api/debug/calls` (call id, tool, drive session `dir_id`, whether the session id matched, ok, error reason, duration). Root `extra`: surface, run, per-turn checks, the drive's sessions (with a hash prefix), merges landed with their operations, conflicts |
| Compaction | A `system` step with `extra.context_management = {type: "compaction", boundary: "replace"}` (RFC §VII) where OpenCode's compaction count rose |
| Run identity | `session_id` = the client's conversation id (OpenCode session, Open WebUI chat); `trajectory_id` = the run id |

| Did not map cleanly | What was done |
| --- | --- |
| Open WebUI reports token usage per turn, not per model call (`input_tokens`/`output_tokens` summed; `prompt_tokens` and `cached_tokens` are the last call's only) | No per-step `metrics`; the turn's usage in the last agent step's `extra.turn_usage`; `final_metrics` totals without `total_cached_tokens` |
| Open WebUI has no per-call boundaries or timestamps in its stored output | Steps split at a reasoning, message or function-call item that follows tool outputs; timestamps only on user steps and each turn's last agent step |
| Per-turn outcomes (the checks, "merged") belong to neither a step nor the run | Root `extra.turns[]` |
| Automatic merges (v2/v3) happen in the drive between calls, not as tool calls | Root `extra.drive.merges_landed`; the `[drive] Saved…` notice stays inside the next observation's text. A `system` step per merge would be more faithful but its timing relative to model calls is not known from the client side |
| Secrets in tool arguments: the drive session id is a secret | Replaced everywhere by `ds_<hash:…>` (the first 12 hex digits of the server's `session_id_hash`), which changes the arguments as sent. The converter refuses to write a trajectory that still holds a Bearer token or any secret shape the server issues; none was found, and no headers are logged |
| `agent.tool_definitions` | Not captured: neither client's events carry the tool list |

## Cost

Token counts from OpenCode's `step_finish` events and Open WebUI's `usage`,
over every model run in this work (the 38 runs above, the first try and the
aborted matrix): **about 14.4 M input tokens, of which at least 9.4 M cached
(OpenCode's; Open WebUI does not report caching per turn), and 0.22 M output**.
Fireworks' price for this model was not checked; at the 0005 assumption
($0.60–1.20 per million input, $2.50–3.00 per million output, no discount for
cached tokens) that is $9–18, about $0.25–0.45 per conversation; cached-token
discounts would lower it.

## Not tested, and why

| Needs | What |
| --- | --- |
| Two agents on one drive | Conflicts under automatic merge, and what the agent tells the person when the unreported last save fails |
| Other models, claude.ai, ChatGPT | One model (Kimi K3) and two clients here; the same runner applies |
| Long real conversations | 30+ turns and compaction at a real context limit |
| OAuth sign-in in parallel | Bearer tokens were used; 0005 covers sign-in |

## Would change it

- A client or model that loses the id across turns or after a real compaction:
  then the drive needs a way to find the conversation's session again (e.g.
  `resume` by purpose), whatever the surface.
- Weaker shell use by another model: then v2's file tools earn their place.
- Conflicts or half-merged changes turning up in multi-agent runs: then merge
  on turn boundaries or explicit `drive save`, not on a 2 s timer.
