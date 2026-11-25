// Host-side file access inside directories that a sandbox can also write.
// The sandbox can plant symlinks, so nothing here follows a symlink: every
// path component is checked with lstat, and files are opened with O_NOFOLLOW.
import { constants, promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Normalise a drive path: no leading slash, no `.`/`..`, forward slashes. Throws on escape. */
export function cleanDrivePath(p: string): string {
  let s = p.replace(/\\/g, '/').trim();
  if (s.startsWith('/drive/')) s = s.slice('/drive/'.length);
  else if (s === '/drive') s = '';
  s = s.replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of s.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error('invalid_path: ".." is not allowed');
    if (part.includes('\0')) throw new Error('invalid_path');
    parts.push(part);
  }
  if (parts.length === 0) throw new Error('invalid_path: empty');
  return parts.join('/');
}

async function lstatOrNull(p: string) {
  try {
    return await fsp.lstat(p);
  } catch {
    return null;
  }
}

/** Make the parent directories of `rel` under `root`, replacing any symlink or file in the way. */
async function ensureDirs(root: string, rel: string): Promise<void> {
  const parts = rel.split('/').slice(0, -1);
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    const st = await lstatOrNull(cur);
    if (st && st.isDirectory()) continue;
    if (st) await fsp.rm(cur, { force: true, recursive: false });
    await fsp.mkdir(cur);
  }
}

/** True if every directory component of `rel` under `root` is a real directory (no symlinks). */
async function dirsAreReal(root: string, rel: string): Promise<boolean> {
  const parts = rel.split('/').slice(0, -1);
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    const st = await lstatOrNull(cur);
    if (!st || !st.isDirectory()) return false;
  }
  return true;
}

/** Write a file at `root/rel` without following symlinks; replaces whatever is there. */
export async function safeWrite(root: string, rel: string, data: Uint8Array | string): Promise<void> {
  await ensureDirs(root, rel);
  const full = path.join(root, rel);
  const st = await lstatOrNull(full);
  if (st && !st.isFile()) await fsp.rm(full, { recursive: true, force: true });
  const tmp = path.join(path.dirname(full), `.ad-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const fh = await fsp.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, full);
}

/** Read a regular file at `root/rel`, or null if it is missing, not a regular file, or behind a symlink. */
export async function safeRead(root: string, rel: string, maxBytes?: number): Promise<{ data: Buffer; size: number } | null> {
  if (!(await dirsAreReal(root, rel))) return null;
  const full = path.join(root, rel);
  let fh;
  try {
    fh = await fsp.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const n = maxBytes === undefined ? st.size : Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const { bytesRead } = await fh.read(buf, off, n - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return { data: buf.subarray(0, off), size: st.size };
  } finally {
    await fh.close();
  }
}

/** Remove a regular file at `root/rel` (never through a symlinked directory). */
export async function safeRemove(root: string, rel: string): Promise<void> {
  if (!(await dirsAreReal(root, rel))) return;
  const full = path.join(root, rel);
  const st = await lstatOrNull(full);
  if (st && (st.isFile() || st.isSymbolicLink())) await fsp.unlink(full);
}

/** SHA-256 of a regular file at `root/rel`, or null. */
export async function safeHash(root: string, rel: string): Promise<string | null> {
  const r = await safeRead(root, rel);
  if (!r) return null;
  return createHash('sha256').update(r.data).digest('hex');
}

export interface WalkedFile { path: string; size: number; hash: string }

/** Every regular file under `root`, hashed. Symlinks and special files are skipped, never followed. */
export async function walkFiles(root: string, opts: { hash?: boolean } = {}): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  async function walk(dir: string, rel: string) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith('.ad-tmp-')) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        if (opts.hash === false) {
          const st = await fsp.lstat(path.join(dir, e.name));
          out.push({ path: r, size: st.size, hash: '' });
        } else {
          const got = await safeRead(root, r);
          if (got) out.push({ path: r, size: got.size, hash: createHash('sha256').update(got.data).digest('hex') });
        }
      }
    }
  }
  await walk(root, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Remove empty directories under root (not root itself). */
export async function pruneEmptyDirs(root: string): Promise<void> {
  async function prune(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = path.join(dir, e.name);
        if (await prune(sub)) await fsp.rmdir(sub).catch(() => {});
        else empty = false;
      } else empty = false;
    }
    return empty;
  }
  await prune(root);
}
