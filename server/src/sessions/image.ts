// The sandbox image's settings: `image.json` next to the rootfs, as written
// by sandbox/build.sh (env, user). The session's cwd stays /drive.
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import path from 'node:path';

export interface ImageSettings {
  env: string[];
  user: { uid: number; gid: number };
}

export const DEFAULT_ENV = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TERM=xterm', 'HOME=/work', 'LANG=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1'];

function setVar(env: string[], name: string, value: string, override: boolean): string[] {
  const i = env.findIndex((e) => e.startsWith(`${name}=`));
  if (i < 0) return [...env, `${name}=${value}`];
  if (!override) return env;
  const out = [...env];
  out[i] = `${name}=${value}`;
  return out;
}

/** Settings for a rootfs: from `<rootfs>/../image.json` when present, else root with DEFAULT_ENV. */
export function loadImageSettings(rootfs: string): ImageSettings {
  const file = path.join(path.dirname(rootfs), 'image.json');
  if (!rootfs || !existsSync(file)) return { env: DEFAULT_ENV, user: { uid: 0, gid: 0 } };
  const j = JSON.parse(readFileSync(file, 'utf8')) as { env?: unknown; user?: { uid?: unknown; gid?: unknown } };
  let env = Array.isArray(j.env) ? j.env.filter((e): e is string => typeof e === 'string' && e.includes('=')) : [...DEFAULT_ENV];
  if (!env.some((e) => e.startsWith('PATH='))) env = [DEFAULT_ENV[0]!, ...env];
  env = setVar(env, 'TERM', 'xterm', false);
  env = setVar(env, 'PYTHONDONTWRITEBYTECODE', '1', false);
  // The root file system is read-only, so HOME must be somewhere writable.
  env = setVar(env, 'HOME', '/work', true);
  const uid = Number(j.user?.uid ?? 0);
  const gid = Number(j.user?.gid ?? uid);
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) throw new Error(`bad user in ${file}`);
  return { env, user: { uid, gid } };
}

/** Give a non-root sandbox user every file and directory under `root` (symlinks themselves, never their targets). */
export async function chownTree(root: string, uid: number, gid: number): Promise<void> {
  async function go(p: string): Promise<void> {
    const st = await fsp.lstat(p).catch(() => null);
    if (!st) return;
    if (st.uid !== uid || st.gid !== gid) await fsp.lchown(p, uid, gid).catch(() => undefined);
    if (st.isDirectory()) for (const e of await fsp.readdir(p).catch(() => [] as string[])) await go(path.join(p, e));
  }
  await go(root);
}
