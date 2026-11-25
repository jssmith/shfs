# MCP tools

The drive's MCP surface as agents see it, so it can be referred to instead of restated. **The source of truth is the code:** `server/src/mcp/` — `classic.ts` (v0, v1), `shell.ts` (v2, v3), `common.ts` (typed results, the call log), `skill.ts` (server instructions and the skill), and `sandbox/bin/drive` (the shell's `drive` command). Change this page in the same commit as any of them.

Endpoint: `/mcp`, Streamable HTTP (JSON responses enabled), OAuth 2.1 with dynamic client registration and PKCE. Design background: tech spec §7 in the design repository.

## Four surfaces behind one switch

The server offers one of four surfaces, chosen at start with `AGENT_DRIVE_SURFACE`. **The default is `v3`** (decided after `docs/decisions/0006-*`); v0–v2 stay selectable so experiments can compare them with the same drive and clients.

| Surface | Idea | Tools |
| --- | --- | --- |
| `v0` | The thin drive as measured at checkpoint 2 | `start_session`, `resume_session`, `run`, `search`, `read`, `write`, `checkpoint`, `finish`, `get_skill` |
| `v1` | v0 reworded: one session per conversation; typed results | as v0 |
| `v2` | Shell first, automatic merge, Claude Code–style file tools | `start_session`, `bash`, `read`, `write`, `edit` |
| `v3` (default) | Shell first, minimal | `start_session`, `bash` |

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

## v2: shell first

The shell is the centre; file tools follow Claude Code's conventions (`Bash(command, timeout, description)`, `Read(file_path, offset, limit)` with `cat -n` lines, `Write(file_path, content)`, `Edit(file_path, old_string, new_string, replace_all)`). There is no `search`, `checkpoint`, `finish`, `resume_session` or `get_skill`: changes are saved at the end of the call that makes them, and the rest is the `drive` command in the shell. Sessions are never closed by the agent; the server lets them go idle and expire (*Sessions over time*).

Server instructions:

> Agent Drive holds a person's files, with a Linux shell attached. Start with start_session(purpose) once per conversation, keep the session_id it returns, and pass it to bash, read, write and edit; reuse it for follow-up requests. /drive is the person's files; changes you make there are saved to the drive automatically. Run "drive help" in the shell for how to work here. This session's view may not include everything the person has: some files are hidden from sessions, and a search reports hidden matches only as approximate counts by label, kind or month.

`session_id` is described as "The session_id returned by start_session; the same one for the whole conversation". Results are typed (below).

| Tool | Arguments (description the model sees) | Description the model sees |
| --- | --- | --- |
| `start_session` | `purpose`: "What you are going to do, in a sentence, e.g. "Pull together my 2025 tax documents" or "Add a kg to pounds function to the unitconv project and test it" or "Find what I spent at Oak Street Grocer in October"" | Open a session in the person's drive: a Linux shell with their files at /drive. Call it once per conversation and keep the session_id it returns for every later call, including later requests in the same conversation. Changes under /drive are saved to the drive automatically. Examples of a purpose: "Pull together my 2025 tax documents", "Add a kg to pounds function to the unitconv project and test it", "Find what I spent at Oak Street Grocer in October". |
| `bash` | `session_id`; `command`: "The command to run, e.g. "ls -R", "grep -ril invoice ." or "drive search tax 2025""; `timeout`: "Optional timeout in milliseconds (default 120000, max 600000)"; `description`: "Clear, concise description of what this command does in 5-10 words, e.g. "List the files in household". The person sees it in the drive's history." | Run a bash command in the session's Linux sandbox (no network). Each command starts in /drive, the person's files; /work is scratch space that is never saved. Changes under /drive are saved to the drive when the call that makes them ends, and the result says whether the save worked. The drive command does the rest: drive search <words>, drive status, drive save "message", drive help. Output is capped at 64 KB (the full output is saved under /work/.drive-output/). |
| `read` | `session_id`; `file_path`: "The file to read, e.g. /drive/household/notes/plan.md"; `offset`: "The line number to start reading from (1 is the first line). Only for files too long to read at once"; `limit`: "The number of lines to read (default 2000)" | Read a file in the session. file_path is under /drive (the person's files; relative paths are taken from /drive) or /work. Returns the lines numbered like cat -n, starting at 1: by default up to 2000 lines from the start; for longer files pass offset and limit. Lines longer than 2000 characters are cut. Your unsaved changes are included. |
| `write` | `session_id`; `file_path`: "The file to write, e.g. /drive/household/notes/summary.md"; `content`: "The complete content of the file" | Write a file in the session, replacing it if it exists; folders are created as needed. Under /drive the file is saved to the drive before this call returns; under /work it stays scratch. Prefer edit for changing part of an existing file. |
| `edit` | `session_id`; `file_path`: "The file to edit, e.g. /drive/household/notes/plan.md"; `old_string`: "The exact text to replace"; `new_string`: "The text to replace it with (must differ from old_string)"; `replace_all`: "Replace every occurrence of old_string (default false)" | Replace exact text in a file in the session. old_string must appear in the file exactly once (include enough surrounding text to make it unique), unless replace_all is true. Keep the file's indentation exactly. Under /drive the change is saved to the drive before this call returns. Read the file first. |

What they return:

| Tool | Returns |
| --- | --- |
| `start_session` | The session id; "Keep this session_id for this whole conversation, including later requests. Pass it to every other tool; it is a secret and nothing shows it again."; file count and top-level folders; topics; "Changes you make under /drive are saved to the drive when the call that makes them ends; each result says whether the save worked. /work is scratch and is never saved."; the partial-view note and hidden counts ("Hidden from sessions: Finance (1 item)"); "In the shell: drive help (how to work here), drive search <words>, drive status, drive save "message"." |
| `bash` | Exit code, stdout, stderr (run with bash if the image has it, else sh; cwd /drive). If the command changed files under /drive, the save's outcome at the end: "Saved to the drive: update notes/plan.md (package pk_…)." or "merge_conflict: nothing was saved to the drive. …" (`save` in structured content: `{ok, pkg_id, changes}` or `{ok: false, reason: 'merge_conflict', next_step, conflicts}`; `null` when nothing under /drive changed). The call itself stays `ok: true`: the command ran |
| `read` | Numbered lines (`%6d\t` + line), and "(lines 1–2000 of 2500; read more with offset=2001)" when there is more. Paths outside /drive and /work: `invalid_path`. A hidden file reads exactly like a missing one (`not_found`). Binary files: a note to use bash |
| `write` | "Wrote N bytes to /drive/x. Saved to the drive: create x (package pk_…)." (or that /work is scratch). On a conflict the call fails with `merge_conflict`: "Wrote N bytes to /drive/x in this session, but nothing was saved to the drive. …", and /drive holds the drive's version again |
| `edit` | "Edited /drive/x: replaced 1 occurrence. Saved to the drive: …" (conflicts as for `write`) and a few numbered lines around the change. `edit_no_match` (old_string absent), `edit_not_unique` ("old_string appears 2 times in …"; next step: add surrounding lines or set replace_all), `edit_no_change`, `binary_file` |


The skill is the MCP resource `skill://agent-drive/SKILL.md` (`text/markdown`, with `name`/`description` front matter, the MCP Skills extension convention) and `drive help`; the text is `SHELL_SKILL` in `skill.ts`.

## v3: shell first, minimal

Like v2, with only `start_session` and `bash`; reading, writing and editing happen in the shell. Same `start_session`, automatic merge, `drive` command, partial-view note and skill resource. What differs:

| Where | v3 text |
| --- | --- |
| Server instructions | v2's, with "pass it to bash" in place of "pass it to bash, read, write and edit" |
| `bash` description | v2's, plus, before "The drive command does the rest": "Read files with cat -n or sed -n '10,40p' file, write them with cat > file <<'EOF', and edit them with sed -i or python3." |

## Automatic merge (v2, v3): option A

Decision 0006, option A: **when a call changes files under /drive (`bash`; `write` and `edit` in v2), the session's changes merge before that call's result returns, and the result says how it went.** There is no timer and no report on a later call (`server/src/merge/auto.ts`).

- **One package per changing call**, all or nothing, through the same merge as `checkpoint`. Its summary, which the person sees, is the call's `description` (bash), else its command (cut at 200 characters), else `write /drive/x` / `edit /drive/x`.
- **What counts as a change:** `write` and `edit` under /drive; for `bash`, a fingerprint of /drive (paths, sizes, modification times) before and after, then a diff. Changes only in /work or in tool caches (the merge ignore list, `server/src/merge/ignore.ts`) save nothing.
- **Conflicts:** nothing merges. The same result names each path and reason, says the session's version is saved under `/work/conflicts/` and that /drive now holds the drive's current version, and ends with the next step: "Redo your change on top of the file in /drive (your version in /work/conflicts/ shows what you had); it is saved when the call that makes it ends." The session stays open.
- **`drive save "message"`** merges at once with the message as the summary; it is now mostly for a message of the agent's own. A command that ends in `drive save` has nothing left to save at its end.
- Packages are grouped into **turns** for the person (below), so one package per call does not clutter history.

## Turns

Packages one session merges close together belong to one **turn** of the conversation (`server/src/sessions/turns.ts`). A new turn starts when a session call comes **`TURN_GAP_MS` = 20 s** or more after the session's previous call ended. The turn is recorded per package in the server-private table `package_turns` (`server-schema.sql`), with every merge on every surface (checkpoints and `finish` in v0/v1 too).

- `GET /api/app/sessions`: each session has `turns`, newest first, each `{turn_id, packages, undone}`; `merges` stays as before.
- `POST /api/app/undo-turn {turn_id}`: undoes the turn's packages newest first, each with the usual per-item rules of undo (an item changed since is left as it is and reported in `conflicts`); packages already undone are skipped.
- `GET /api/app/sessions/<dir_id>`: one session; each turn also lists `files` (`{path, ops}`, oldest change first).
- The app's session page (`/session/<dir_id>`) shows one card per turn: the agent's descriptions, the files the turn changed, and one *Undo turn* button.

## Sessions over time

Agents on v2/v3 never close a session, so the server does (`Sessions.sweep`, run every minute; `Sessions.lifecycle`):

| After no calls for | State | What happens |
| --- | --- | --- |
| `IDLE_AFTER_MS` = **1 hour** (`AGENT_DRIVE_IDLE_AFTER_S`) | `idle` | The sandbox is destroyed; /drive, /work and the session's base stay in its folders. The next call with its id starts a new sandbox and carries on in the same session; the agent notices nothing |
| `EXPIRE_AFTER_MS` = **30 days** (`AGENT_DRIVE_EXPIRE_AFTER_S`; the security design's re-approval period) | `expired` | Every call is refused: `expired: this session expired after 30 days without calls. Start a new session with start_session(purpose); this one cannot be used again.` |

The state is kept in `session_meta.lifecycle` (server-private); the app shows it in place of `open`. Expiry is also checked at each call, so it holds even before a sweep has run.

## The `drive` command (v2, v3)

`/opt/drive/bin/drive` (on PATH), a small Python script from `sandbox/bin/drive`, mounted read-only into each sandbox (not built into the image):

| Command | Output |
| --- | --- |
| `drive search <words>` | Matches this session can see: "3 matches you can see:" or "about 1,200 matches you can see; the first 20:", each path with a snippet; then "Hidden from this session: …" (metadata only, below) |
| `drive search --all <words>` | The same, and the full list written to `/work/search-<n>.txt` |
| `drive status` | Purpose, start time, file count, unsaved changes, the last save (time, package, automatic or `drive save`) or "FAILED", conflicts, the partial-view note, hidden counts |
| `drive save "message"` | Merges now with the message as the summary the person sees (otherwise each changing call is saved at its end with its description or command); exit 1 on `merge_conflict` |
| `drive help` | The skill text |

**How it reaches the drive, and why that is safe.** Each session gets its own Unix socket on the host, `sessions/<dir_id>/sock/drive.sock`, started with its sandbox. The socket's directory is bind-mounted read-only at `/run/drive` into that session's sandbox only, and runsc runs with `--host-uds=open`, so the sandbox may connect to (not create) host sockets inside its own mounts. Which socket a request arrives on identifies the session: there is no token and nothing secret in the sandbox, and a request never names a session (fields other than `argv` are ignored). The host treats every request as untrusted: one JSON line `{"argv": [...]}` of at most 64 KB and 64 string arguments, at most 4 connections at a time, only the four commands above, every answer scoped to that session. Another session's socket is not in the sandbox's file system at all (`test/e2e/src/shell.test.ts` tries to connect to it by its host path). The socket belongs to the sandbox's user, mode 0600.

While a `bash` command holds the session, work the command asks for through `drive` (a save, a status diff) runs under the command's hold, one at a time, and the command does not release the session before that work is done (`Sessions.underLock`).

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
| `expired` | Start a new session with start_session(purpose); this one cannot be used again. |
| `paused` | Tell the person the session is paused and try again later. |
| `not_found` | Check the path with ls in the shell, then try again. (v2: "…with ls in bash…") |
| `invalid_path` | Use a path under /drive or /work without "..", such as /drive/notes/plan.md. |
| `too_large` | Use the shell for large files. |
| `sandbox_unavailable` | Try again in a moment; if it keeps failing, tell the person. |
| `internal_error` | Try the call once more; if it fails again, tell the person. |
| `merge_conflict` | Redo your change on top of the file now in /drive; the next merge then succeeds. |
| `edit_no_match` (v2) | Read the file to see its current text, then call edit again with an exact copy of the text to replace. |
| `edit_not_unique` (v2) | Add surrounding lines to old_string so it matches once, or set replace_all to true. |
| `edit_no_change` (v2) | Pass the new text as new_string. |
| `binary_file` (v2) | Use bash for binary files (e.g. file, pdftotext, python3). |

## Hidden matches (every surface)

An item is, for a session, (a) not in view at all, (b) visible as existing with its content withheld, or (c) visible with content. Today every ringed, held or unchecked item is (a), and the session gets counts only. No surface shows names of (b) items yet.

Search matches visible items on their text, labels and path. Items the session cannot read match **on metadata only**: their labels (including the ring), their kind (from the MIME type: `pdf`, `image`, `text`, `spreadsheet`…) and the month they were added (`2026-10`, `october`, `oct`, `2026`). Their text and names never take part, so guessing a ringed file's content (a card number, an expiry date) gives the same answer as a wrong guess (`test/e2e/src/leak.test.ts`, every surface). The code is `server/src/sessions/search.ts`.

- v0, v1: `Hidden matches: in_ring: ring:finance (1 item)` as before, from metadata.
- v2, v3 (`drive search`): `Hidden from this session: Finance: about 12 items match by label`. Counts are exact up to 10, then "about" with two significant figures.

## Not yet built

From tech spec §7: `meta`, `map`, `refresh`, `reinit`, `resolve`, `request_access`, `check_request`, `answer`; `dsearch`, `dgrep` and `dmeta` inside the shell. Add each here when it ships.
