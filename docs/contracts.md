# Contracts between parts

The boundaries that let the server, the file system daemon, reading and deployment be built in parallel. Change one only with the lead session's review, and say so in the commit.

## 1. Data directory

Everything lives under `$AGENT_DRIVE_DATA` (default `./data`, never inside the checkout):

| Path | Owner | Contents |
| --- | --- | --- |
| `drive.db` | server | SQLite store, schema in `server/src/store/schema.sql` |
| `blobs/<h[0:2]>/<h>` | server | Content by SHA-256 (hex), immutable |
| `sessions/<dir_id>/upper/` | fs daemon writes, server reads | The session's writes under `/drive`, as a plain directory tree |
| `sessions/<dir_id>/whiteouts` | fs daemon writes, server reads | One path per line: items the session deleted or renamed away |
| `sessions/<dir_id>/work/` | sandbox | Mounted at `/work`; never merged |
| `sessions/<dir_id>/mnt/` | fs daemon | Where the daemon mounts the session's `/drive` on the host |
| `sessions/<dir_id>/sock/` | server | `drive.sock`, the Unix socket the session's `drive` command talks to (v2, v3). Mounted read-only at `/run/drive` into that session's sandbox only; never merged, never shown to another session |

## 2. The session file system (server ↔ `fs/`)

- The server writes `session_view` rows for a session: every path the session may see, as a file (item and version) or a symlink (relative target). Ringed, unchecked and trashed items are never in it. After any change it increments `session_view_epoch.epoch`.
- The daemon serves `sessions/<dir_id>/mnt/` as follows:
  - lookups and listings: the union of `session_view` and `upper/`, minus `whiteouts`;
  - reads: from `upper/` if the path is there, else the blob of the item version;
  - writes and creates: into `upper/` (copy-up on first write); deletes and renames add to `whiteouts` and move within `upper/`;
  - `_index.db` and `_text/`: synthesised read-only (later; not needed for the first version).
- **Freshness:** the daemon checks the epoch on every lookup and listing and drops any cache when it changes. A trashed item must disappear on the next operation.
- **Accounting:** every open appends `activity(actor='fs', op='open', dir_id, item_id, detail={path, mode})`.
- Into gVisor the mount is passed with `--file-access-mounts=shared`.
- The first thin drive does not use the daemon: the server materialises `upper/` from `session_view` itself and mounts that. The daemon replaces it behind the same paths once it passes A9.

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
