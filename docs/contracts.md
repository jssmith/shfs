# Contracts between parts

The boundaries that let the server, the file system daemon, reading and deployment be built in parallel. Change one only with the lead session's review, and say so in the commit.

## 1. Data directory

Everything lives under `$AGENT_DRIVE_DATA` (default `./data`, never inside the checkout):

| Path | Owner | Contents |
| --- | --- | --- |
| `drive.db` | server | SQLite store, schema in `server/src/store/schema.sql` |
| `blobs/<h[0:2]>/<h>` | server | Content by SHA-256 (hex), immutable |
| `sessions/<dir_id>/upper/` | fs daemon writes, server reads | The session's writes under `/drive`, as a plain directory tree |
| `sessions/<dir_id>/whiteouts` | fs daemon writes, server reads | One path per line: items the session deleted or renamed away. A path in both `whiteouts` and `upper/` is a replacement. Rewritten only by `rebase` (§2) |
| `sessions/<dir_id>/control.sock` | fs daemon listens, server connects | The daemon's control socket: `refresh`, `rebase`, `stats` (§2) |
| `sessions/<dir_id>/work/` | sandbox | Mounted at `/work`; never merged |
| `sessions/<dir_id>/mnt/` | fs daemon | Where the daemon mounts the session's `/drive` on the host |
| `sessions/<dir_id>/sock/` | server | `drive.sock`, the Unix socket the session's `drive` command talks to (v2, v3). Mounted read-only at `/run/drive` into that session's sandbox only; never merged, never shown to another session |

## 2. The session file system (server ↔ `fs/`)

- The server writes `session_view` rows for a session: every path the session may see, as a file (item and version), a symlink (relative target) or a directory (`kind = 'dir'`, no item: a directory that must exist even when nothing in it is visible, such as an empty `.git/refs/tags`; directories above other rows need no row of their own). Ringed, unchecked and trashed items are never in it. After any change it increments `session_view_epoch.epoch`.
- `mode` on a row gives its permission bits (at least the executable bit must survive a round trip); NULL means 0644 for a file and 0755 for a directory. `writable = 0` clears a file's write bits. The daemon serves the mode and keeps it on copy-up; the server reads the mode of files in `upper/` when it merges them.
- The daemon serves `sessions/<dir_id>/mnt/` as follows:
  - lookups and listings: the union of `session_view` and `upper/`, minus `whiteouts`;
  - reads: from `upper/` if the path is there, else the blob of the item version;
  - writes and creates: into `upper/` (copy-up on first write); deletes and renames add to `whiteouts` and move within `upper/`;
  - `_index.db` and `_text/`: synthesised read-only (later; not needed for the first version).
- **Freshness:** the daemon applies an epoch change before it acknowledges `refresh`, and checks the epoch on every request that reaches it (and every 50 ms). A trashed item must disappear on the next operation.
- **Refresh:** after every increment of the epoch, once its transaction has committed, the server writes `refresh\n` to `sessions/<dir_id>/control.sock` and waits for `ok <epoch>` (5 s timeout). No socket or no listener means no daemon runs for the session: nothing to do. With kernel caching only this synchronous call keeps "gone on the next operation".
- **Rebase:** the server changes `upper/` and `whiteouts` only through `rebase {json}` on the control socket (answered `ok <epoch> {json}`), or with `agent-drive-fs rebase` when no daemon runs. The request: `remove: [{path, sha256}]` (drop the session's copy if it still has exactly that content), `drop_whiteouts: [path]` (exact lines), `unwhite: [path]` (show a path again; whatever else a whiteout above it hid stays hidden). The server uses it after a merge (merged copies and whiteouts go), a hide (an unchanged copy of a hidden item goes) and a conflict.
- **Ownership:** `agent-drive-fs mount --uid U --gid G` reports store items as owned by U:G and gives everything it creates in `upper/` (and `upper/` itself) to U:G; the server passes the sandbox's user, since gVisor checks permissions itself.
- **The server's reads of `upper/`** go through `agent-drive-fs export` (a copy of every regular file into a directory only the server can reach, with a manifest of path, size, mode and sha256) and `agent-drive-fs read`; its writes to `/drive` go through the mount (`agent-drive-fs write`). These use `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`, so nothing the session put in `upper/` is followed on the host.
- **Accounting:** opens are recorded as `activity(actor='fs', op='open', dir_id, item_id, detail={path, mode, count})`, at most one row per (path, mode, item) per minute: the first open of a minute adds the row (its `ts`), later opens in that minute raise `count`. One row per open was 4.8 million rows in a 25-minute soak (decision 0003).
- Into gVisor the mount is passed with `--file-access-mounts=shared`.
- `AGENT_DRIVE_FS` picks the session file system. `copy` (the default): the server materialises `upper/` from `session_view` itself and mounts that, as the first thin drive did. `daemon`: one `agent-drive-fs mount` per session while its sandbox runs (binary from `AGENT_DRIVE_FS_BIN`, else `agent-drive-fs` on `PATH`), with 60 s kernel timeouts; the sandbox gets `sessions/<dir_id>/mnt/` at `/drive`, and `upper/` holds only what the session wrote.

## 3. Reading (server ↔ `server/src/reading/`)

```ts
export interface Extraction {
  text: string;
  method: 'plain' | 'text-layer' | 'ocr' | 'none';
  confidence: number;          // 0..1; OCR mean word confidence, 1 for plain text
  description?: string;        // short image description, when available
}
export function extract(blobPath: string, mime: string, name: string): Promise<Extraction>;

export interface RingResult {
  rings: string[];             // e.g. ['ring:finance']
  uncertain: boolean;          // true → the item stays unreachable and goes to the person
  reasons: { ring: string; source: 'rule' | 'model'; detail: string }[];
}
export function ringCheck(input: {
  text: string; name: string; mime: string; source: string; batchLabels: string[];
}): Promise<RingResult>;
```

Unreadable input returns `method: 'none'` and the ring check returns `uncertain: true`.

## 4. Running the server (server ↔ deployment)

- `agent-drive serve` with `AGENT_DRIVE_DATA`, `AGENT_DRIVE_PORT` (default 8787), `AGENT_DRIVE_PUBLIC_URL` (the tunnel's HTTPS address, used in OAuth metadata).
- Needs on `PATH`: `runsc`, `tesseract`, `pdftotext`. The sandbox root file system image at `$AGENT_DRIVE_DATA/images/default/rootfs`.
- MCP at `/mcp` (Streamable HTTP), OAuth metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`, the app at `/`, health at `/healthz`.

## 5. Test corpus (`test/fixtures` ↔ everyone)

`test/fixtures/generate` writes a corpus to a given directory plus `manifest.json`: for each file, its path, MIME type, and ground truth (`rings`, `kind`, `topics`). Deterministic from a seed. Synthetic only.
