#!/usr/bin/env node
// drive put <folder> [--label topic:...]... [--to <dest>] [--url U] [--token T]
// Walks a folder and uploads it as one package, keeping relative paths.
// Credentials: --url/--token, or AGENT_DRIVE_URL/AGENT_DRIVE_TOKEN, or
// ~/.config/agent-drive/cli.json {"url", "token"}.
import { createHash } from 'node:crypto';
import { promises as fsp, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PutOptions { url: string; token: string; labels: string[]; to?: string; log?: (s: string) => void }

const SKIP = new Set(['.DS_Store', 'Thumbs.db', '.git', 'node_modules']);

export async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function go(dir: string, rel: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await go(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  }
  await go(root, '');
  return out.sort();
}

export async function put(folder: string, o: PutOptions): Promise<{ pkg_id: string | null; created: number; updated: number; unchanged: number }> {
  const log = o.log ?? (() => {});
  const root = path.resolve(folder);
  const dest = (o.to ?? path.basename(root)).replace(/^\/+|\/+$/g, '');
  const files = await walk(root);
  if (!files.length) throw new Error(`no files in ${folder}`);
  const auth = { authorization: `Bearer ${o.token}` };
  const base = o.url.replace(/\/+$/, '');
  const list: { path: string; hash: string; size: number }[] = [];
  for (const rel of files) {
    const data = await fsp.readFile(path.join(root, rel));
    const hash = createHash('sha256').update(data).digest('hex');
    const head = await fetch(`${base}/api/upload/blob/${hash}`, { method: 'HEAD', headers: auth });
    if (head.status === 401) throw new Error('the drive refused the device key');
    if (head.status !== 200) {
      const r = await fetch(`${base}/api/upload/blob`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: data });
      if (!r.ok) throw new Error(`upload of ${rel} failed: ${r.status} ${await r.text()}`);
    }
    list.push({ path: dest ? `${dest}/${rel}` : rel, hash, size: data.length });
    log(`  ${rel}`);
  }
  const r = await fetch(`${base}/api/upload`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ files: list, labels: o.labels }) });
  const body = (await r.json()) as { pkg_id: string | null; created: number; updated: number; unchanged: number; message?: string };
  if (!r.ok) throw new Error(`upload failed: ${body.message ?? r.status}`);
  return body;
}

function loadConfig(): { url?: string; token?: string } {
  try {
    return JSON.parse(readFileSync(path.join(os.homedir(), '.config', 'agent-drive', 'cli.json'), 'utf8')) as { url?: string; token?: string };
  } catch {
    return {};
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd !== 'put') {
    console.error('usage: drive put <folder> [--label topic:...]... [--to <dest>] [--url URL] [--token KEY]');
    return 2;
  }
  const labels: string[] = [];
  let folder: string | undefined;
  let to: string | undefined;
  const cfg = loadConfig();
  let url = process.env.AGENT_DRIVE_URL ?? cfg.url;
  let token = process.env.AGENT_DRIVE_TOKEN ?? cfg.token;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--label') labels.push(args[++i] ?? '');
    else if (a.startsWith('--label=')) labels.push(a.slice(8));
    else if (a === '--to') to = args[++i];
    else if (a === '--url') url = args[++i];
    else if (a === '--token') token = args[++i];
    else if (!folder) folder = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!folder) throw new Error('drive put needs a folder');
  if (!url || !token) throw new Error('set AGENT_DRIVE_URL and AGENT_DRIVE_TOKEN (a key from `agent-drive device add`)');
  console.log(`Uploading ${folder}…`);
  const r = await put(folder, { url, token, labels, to, log: (s) => console.log(s) });
  console.log(r.pkg_id ? `Uploaded as package ${r.pkg_id}: ${r.created} new, ${r.updated} updated, ${r.unchanged} unchanged. The drive checks new files before agents can see them.` : `Nothing new: ${r.unchanged} unchanged.`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${realpathSync(process.argv[1])}`).href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
