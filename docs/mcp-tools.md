# MCP tools

The drive's MCP surface as agents see it, so it can be referred to instead of restated. **The source of truth is the code:** `server/src/mcp/` — `classic.ts` (v0, v1), `shell.ts` (v2, v3), `common.ts` (typed results, the call log), `skill.ts` (server instructions and the skill), and `sandbox/bin/drive` (the shell's `drive` command). Change this page in the same commit as any of them.

Endpoint: `/mcp`, Streamable HTTP (JSON responses enabled), OAuth 2.1 with dynamic client registration and PKCE. Design background: tech spec §7 in the design repository.

## Four surfaces behind one switch

The server offers one of four surfaces, chosen at start with `AGENT_DRIVE_SURFACE` (default `v0`), so experiments can compare them with the same drive and clients.

| Surface | Idea | Tools |
| --- | --- | --- |
| `v0` | The thin drive as measured at checkpoint 2 | `start_session`, `resume_session`, `run`, `search`, `read`, `write`, `checkpoint`, `finish`, `get_skill` |
| `v1` | v0 reworded: one session per conversation; typed results | as v0 |
| `v2` | Shell first, automatic merge, Claude Code–style file tools | `start_session`, `bash`, `read`, `write`, `edit` |
| `v3` | Shell first, minimal | `start_session`, `bash` |

In every surface, a session's search never matches the content of items it cannot read (see *Hidden matches*).

## How an agent learns the workflow

The person should never have to explain sessions to their agent. The guidance reaches the agent three ways, in the order a client sees them:

1. **Server instructions**, sent once on `initialize` (per surface, below).
2. **Tool descriptions and argument descriptions**, which every client shows the model. Some clients ignore server instructions, so the descriptions carry the essentials on their own.
3. **The skill**: `get_skill` in v0 and v1; in v2 and v3, `drive help` in the shell and the MCP resource `skill://agent-drive/SKILL.md`.

Which of these agents actually use was measured in checkpoint 2 (`docs/decisions/0005-*`).

## v0: the thin drive

Server instructions:

> Agent Drive holds a person's files. Start with start_session(purpose), keep the session_id it returns for the whole conversation, and pass it to every other tool. Call get_skill(session_id) to learn how to work here.

Every tool except `start_session` takes `session_id`, described to the model as "The session_id returned by start_session". It must come from the same connection that started the session. No tool declares an output schema; errors read `reason: message`.

| Tool | Arguments | Description the model sees | Returns |
| --- | --- | --- | --- |
| `start_session` | `purpose`: "What you are going to do, in a sentence" | Open a session in the drive for one purpose. Returns a secret session_id: keep it and pass it to every other tool. Also returns what /drive holds and how many items are hidden in rings. | The session id (`ds_` + 26 base32 characters), "Keep this session_id for this conversation and pass it to every other tool. It is a secret; nothing shows it again.", file count, top-level folders, topics, hidden counts per ring |
| `resume_session` | `session_id` | Rejoin a session you started earlier in this conversation, with its session_id. Returns where it stands. | Purpose, status, unmerged changes, hidden counts |
| `run` | `session_id`, `command`, `timeout` (seconds, default 60, max 600) | Run a shell command (sh -c) in the session sandbox. cwd is /drive. No network. Output is capped at 64 KB. | Exit code, stdout, stderr; full output saved under `/work/.drive-output/` when cut |
| `search` | `session_id`, `query` | Search the text and labels of files in the drive. Also reports how many matches are hidden in rings (counts, never names). | Up to 50 paths with snippets; `Hidden matches: in_ring: ring:finance (1 item)` from metadata only |
| `read` | `session_id`, `path` | Read a text file under /drive in this session (your unmerged changes included). Capped at 256 KB. | Text, or a note that the file is binary |
| `write` | `session_id`, `path`, `content` | Write a small text file under /drive in this session (creates folders as needed). Merged at the next checkpoint. | Bytes written; a reminder to checkpoint |
| `checkpoint` | `session_id`, `summary`: "What you changed and why" | Merge your changes under /drive into the shared drive (all or nothing), then bring in others' changes. | The changes merged, and tool caches left unmerged ("Not merged (tool cache)", see `server/src/merge/ignore.ts`); or `merge_conflict` with paths. Each conflicting file in /drive then holds the drive's current version and the session's own is saved under `/work/conflicts/`, so the next merge can succeed |
| `finish` | `session_id`, `summary`: "What you did in this session" | Merge your changes and close the session. | As `checkpoint`, plus session closed. On `merge_conflict` the session stays open (status `needs_resolution`) and the text says so; call `finish` again after fixing |
| `get_skill` | `session_id` | How to work in the drive: /drive, /work, checkpoints, rings. | The skill text (`SKILL` in `skill.ts`) |

## v1: v0 reworded

The same nine tools, arguments and behaviour as v0. What differs:

| Where | v1 text |
| --- | --- |
| Server instructions | v0's, plus: "One session per conversation, not per request: reuse the session_id for follow-up requests." |
| `start_session` description | "Open a session in the drive for one purpose. Returns a secret session_id: keep it for this whole conversation and pass it to every other tool. Also returns what /drive holds and how many items are hidden in rings. Examples of a purpose: "Pull together my 2025 tax documents", "Add a kg to pounds function to the unitconv project and test it", "Find what I spent at Oak Street Grocer in October"." |
| `purpose` | "What you are going to do, in a sentence, e.g. "Pull together my 2025 tax documents" or "Add a kg to pounds function to the unitconv project and test it" or "Find what I spent at Oak Street Grocer in October"" |
| `start_session` result | "Keep this session_id for this whole conversation, including later requests. Pass it to every other tool; it is a secret and nothing shows it again." |
| `command` (run) | "The shell command, run with sh -c in /drive, e.g. "ls -R household" or "python3 /work/totals.py"" |
| `query` (search) | "Words to look for in the files' text, names and labels, e.g. "Oak Street Grocer"" |
| `path` (read, write) | "A path under /drive, with or without the /drive/ prefix, e.g. "household/notes/plan.md"" |
| `content` (write) | "The complete new content of the file (it replaces what is there)" |
| `checkpoint` description | v0's, plus: "Call this when a piece of work is done, before you answer the person." |
| `finish` description | "Merge your changes and close the session. Only call this when the person says they are done or the conversation is ending. For the next request in the same conversation, keep using the same session_id; use checkpoint to merge work as you go." |
| Results | Typed (below) |

## Typed results (v1, v2, v3)

Every tool declares an output schema (`outputSchema`) and returns `structuredContent` with at least:

| Field | Meaning |
| --- | --- |
| `ok` | `true` if the call did what was asked |
| `reason` | On failure: the reason code |
| `next_step` | On failure: one sentence telling the agent what to do next |

Other fields vary by tool (`session_id`, `exit_code`, `changes`, …). An error's text leads with the reason code and ends with the next step, e.g. `not_found: /drive/notes/x.md does not exist in this session. Check the path with ls in the shell, then try again.`

Default next steps (`NEXT_STEP` in `common.ts`; some calls give a more specific one):

| Reason | Next step |
| --- | --- |
| `needs_session` | Call start_session(purpose) and pass the session_id it returns to every other tool. |
| `finished`, `stopped` | Start a new session with start_session(purpose). |
| `paused` | Tell the person the session is paused and try again later. |
| `not_found` | Check the path with ls in the shell, then try again. |
| `invalid_path` | Use a path under /drive or /work without "..", such as /drive/notes/plan.md. |
| `too_large` | Use the shell for large files. |
| `sandbox_unavailable` | Try again in a moment; if it keeps failing, tell the person. |
| `internal_error` | Try the call once more; if it fails again, tell the person. |
| `merge_conflict` | Redo your change on top of the file now in /drive; the next merge then succeeds. |

## Hidden matches (every surface)

An item is, for a session, (a) not in view at all, (b) visible as existing with its content withheld, or (c) visible with content. Today every ringed, held or unchecked item is (a), and the session gets counts only. No surface shows names of (b) items yet.

Search matches visible items on their text, labels and path. Items the session cannot read match **on metadata only**: their labels (including the ring), their kind (from the MIME type: `pdf`, `image`, `text`, `spreadsheet`…) and the month they were added (`2026-10`, `october`, `oct`, `2026`). Their text and names never take part, so guessing a ringed file's content (a card number, an expiry date) gives the same answer as a wrong guess (`test/e2e/src/leak.test.ts`, every surface). The code is `server/src/sessions/search.ts`.

- v0, v1: `Hidden matches: in_ring: ring:finance (1 item)` as before, from metadata.
- v2, v3 (`drive search`): `Hidden from this session: Finance: about 12 items match by label`. Counts are exact up to 10, then "about" with two significant figures.

## Not yet built

From tech spec §7: `meta`, `map`, `refresh`, `reinit`, `resolve`, `request_access`, `check_request`, `answer`; `dsearch`, `dgrep` and `dmeta` inside the shell. Add each here when it ships.
