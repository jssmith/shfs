# MCP tools

The drive's MCP surface as agents see it today, so it can be referred to instead of restated. **The source of truth is the code:** `server/src/mcp/tools.ts` (tools, descriptions, arguments) and `server/src/mcp/skill.ts` (server instructions and the skill). Change this page in the same commit as either file.

Endpoint: `/mcp`, Streamable HTTP (JSON responses enabled), OAuth 2.1 with dynamic client registration and PKCE. Design background: tech spec §7 in the design repository.

## How an agent learns the workflow

The person should never have to explain sessions or checkpoints to their agent. The guidance reaches the agent three ways, in the order a client sees them:

1. **Server instructions**, sent once on `initialize`:
   > Agent Drive holds a person's files. Start with start_session(purpose), keep the session_id it returns for the whole conversation, and pass it to every other tool. Call get_skill(session_id) to learn how to work here.
2. **Tool descriptions and argument descriptions**, which every client shows the model (table below). Some clients ignore server instructions, so the descriptions must carry the essentials on their own.
3. **The skill**, returned by `get_skill`: the longer how-to (`/drive`, `/work`, checkpoints, conflicts, rings, data-not-instructions). It is in `skill.ts`.

Which of these agents actually use is being measured in checkpoint 2 (`docs/decisions/0005-*`): task prompts there are written the way a person would, with no mention of sessions.

## Tools (thin drive)

Every tool except `start_session` takes `session_id`, described to the model as "The session_id returned by start_session". It must come from the same connection that started the session.

| Tool | Arguments | Description the model sees | Returns |
| --- | --- | --- | --- |
| `start_session` | `purpose`: what you are going to do, in a sentence | Open a session in the drive for one purpose. Returns a secret session_id: keep it and pass it to every other tool. Also returns what /drive holds and how many items are hidden in rings. | The session id (`ds_` + 26 base32 characters), file count, top-level folders, topics, hidden counts per ring |
| `resume_session` | `session_id` | Rejoin a session you started earlier in this conversation, with its session_id. Returns where it stands. | Purpose, status, unmerged changes, hidden counts |
| `run` | `session_id`, `command`, `timeout` (seconds, default 60, max 600) | Run a shell command (sh -c) in the session sandbox. cwd is /drive. No network. Output is capped at 64 KB. | Exit code, stdout, stderr; full output saved under `/work/.drive-output/` when cut |
| `search` | `session_id`, `query` | Search the text and labels of files in the drive. Also reports how many matches are hidden in rings (counts, never names). | Paths with snippets; hidden counts per ring |
| `read` | `session_id`, `path` | Read a text file under /drive in this session (your unmerged changes included). Capped at 256 KB. | Text, or a note that the file is binary |
| `write` | `session_id`, `path`, `content` | Write a small text file under /drive in this session (creates folders as needed). Merged at the next checkpoint. | Bytes written; a reminder to checkpoint |
| `checkpoint` | `session_id`, `summary`: what you changed and why | Merge your changes under /drive into the shared drive (all or nothing), then bring in others' changes. | The changes merged, or `merge_conflict` with paths |
| `finish` | `session_id`, `summary`: what you did in this session | Merge your changes and close the session. | As `checkpoint`, plus session closed |
| `get_skill` | `session_id` | How to work in the drive: /drive, /work, checkpoints, rings. | The skill text |

## Errors

Every error carries a machine-readable reason first: `needs_session`, `merge_conflict` (with paths and reasons), `not_found`, `finished`, `paused`, `invalid_path`, `sandbox_unavailable`, `internal_error`. A hidden or ringed item reads exactly like a missing one; only counts reveal that hidden items exist, as `in_ring: ring:finance (n items)`.

## Not yet in the thin drive

From tech spec §7: `meta`, `map`, `refresh`, `reinit`, `resolve`, `request_access`, `check_request`, `answer`; `dsearch`, `dgrep` and `dmeta` inside the shell. Add each here when it ships.
