// Content-addressed blobs: $AGENT_DRIVE_DATA/blobs/<h[0:2]>/<h>, SHA-256 hex, immutable.
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

export class Blobs {
  constructor(readonly dir: string) {}

  pathOf(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad blob hash');
    return path.join(this.dir, hash.slice(0, 2), hash);
  }

  has(hash: string): boolean {
    return existsSync(this.pathOf(hash));
  }

  async put(data: Uint8Array): Promise<string> {
    const hash = createHash('sha256').update(data).digest('hex');
    const p = this.pathOf(hash);
    if (existsSync(p)) return hash;
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fsp.writeFile(tmp, data, { mode: 0o444 });
    await fsp.rename(tmp, p);
    return hash;
  }

  async get(hash: string): Promise<Buffer> {
    return fsp.readFile(this.pathOf(hash));
  }
}
