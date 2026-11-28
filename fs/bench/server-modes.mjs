// The server's two session file systems side by side (AGENT_DRIVE_FS=copy and =daemon): one
// server context each, the same synthetic tree, the same commands inside gVisor through
// Sessions.run, interleaved and timed inside the sandbox; then the host-side diff before a
// checkpoint. Prints medians in ms. Needs root, runsc, /dev/fuse, `npm run build`, and
// `cargo build --release` in fs/.
// Usage: AGENT_DRIVE_ROOTFS=<rootfs> [FS_PREFIX=fsd] node fs/bench/server-modes.mjs [runs]
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = Number(process.argv[2] ?? 7);
const P = process.env.FS_PREFIX ?? 'fsd';
const ROOTFS = process.env.AGENT_DRIVE_ROOTFS;
if (!ROOTFS) throw new Error('set AGENT_DRIVE_ROOTFS');
const BIN = path.join(repo, 'fs/target/release/agent-drive-fs');
const { createContext } = await import(path.join(repo, 'server/dist/context.js'));
const { ingestUpload } = await import(path.join(repo, 'server/dist/ingest/upload.js'));
const { diffSession } = await import(path.join(repo, 'server/dist/merge/merge.js'));

/** 2,000 Python-like files in 40 packages, deterministic. */
function tree() {
  const files = {};
  for (let p = 0; p < 40; p++)
    for (let m = 0; m < 50; m++) {
      const lines = [];
      for (let f = 0; f < 30; f++) {
        const h = createHash('sha256').update(`${p}-${m}-${f}`).digest('hex').slice(0, 12);
        lines.push(`def fn_${f}_${h}(x):\n    return x * ${f} + ${p}  # ${h}\n`);
      }
      files[`tree/pkg${p}/mod${m}.py`] = lines.join('\n');
    }
  return files;
}

async function setup(mode) {
  const dataDir = mkdtempSync(`/tmp/${P}-bench-${mode}-`);
  const ctx = createContext({
    dataDir, port: 0, publicUrl: 'http://127.0.0.1', runsc: '/usr/local/bin/runsc', runscRoot: `/run/${P}-bench-${mode}`,
    rootfs: ROOTFS, sandboxPrefix: `${P}-b${mode[0]}-`, surface: 'v0', fs: mode, fsBin: BIN,
  });
  const list = [];
  for (const [p, c] of Object.entries(tree())) {
    const data = Buffer.from(c);
    list.push({ path: p, hash: await ctx.drive.blobs.put(data), size: data.length });
  }
  ingestUpload(ctx.drive, list, [], 'bench');
  ctx.jobs.kick();
  await ctx.jobs.idle();
  const { row } = await ctx.sessions.start('c', 'bench', {});
  // A Git repository the session makes itself (in upper/ in both modes).
  const git = 'git -c user.email=b@example.invalid -c user.name=b';
  const r = await ctx.sessions.run(row.dir_id, `cp -r /drive/tree /drive/repo && cd /drive/repo && git init -q && ${git} add -A && ${git} commit -qm init && git status --porcelain | wc -l`, 300);
  if (r.exitCode !== 0) throw new Error(`${mode} setup: ${r.stderr}`);
  return { mode, ctx, dir: row.dir_id, dataDir };
}

const BENCH = {
  'git status (session repo, 2,000 files)': 'cd /drive/repo && git status --porcelain',
  "rg -c 'def ' (store tree, 2,000 files)": "rg -c 'def ' /drive/tree",
  'find -type f (store tree)': 'find /drive/tree -type f',
  'cat every file (store tree)': 'find /drive/tree -type f -exec cat {} +',
  '1,000 files x 1 KiB, create and write': 'rm -rf /drive/small; mkdir /drive/small && head -c 1024 /dev/zero > /tmp/k && for i in $(seq 1000); do cp /tmp/k /drive/small/f$i; done',
};

async function time(s, cmd) {
  const r = await s.ctx.sessions.run(s.dir, `s=$(date +%s%N); { ${cmd} ; } >/dev/null 2>&1; e=$(date +%s%N); echo $(( (e - s) / 1000000 ))`, 300);
  return Number(r.stdout.trim());
}

const envs = [await setup('copy'), await setup('daemon')];
const res = {};
try {
  for (const [name, cmd] of Object.entries(BENCH)) {
    res[name] = { copy: [], daemon: [] };
    for (const s of envs) await time(s, cmd); // warm-up
    for (let i = 0; i < RUNS; i++) for (const s of envs) res[name][s.mode].push(await time(s, cmd));
  }
  const diff = 'diff before a checkpoint (host)';
  res[diff] = { copy: [], daemon: [] };
  for (let i = 0; i < RUNS; i++)
    for (const s of envs) {
      const t0 = Date.now();
      await s.ctx.sessions.lock.run(s.dir, () => diffSession(s.ctx.sessions, s.dir));
      res[diff][s.mode].push(Date.now() - t0);
    }
  const opens = envs[1].ctx.drive.db.prepare("SELECT count(*) AS rows, coalesce(sum(json_extract(detail, '$.count')), 0) AS opens FROM activity WHERE op = 'open'").get();
  console.log(`daemon: ${opens.opens} opens in ${opens.rows} activity rows`);
} finally {
  for (const s of envs) {
    await s.ctx.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  }
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('| Benchmark | copy | daemon | daemon / copy |\n| --- | ---: | ---: | ---: |');
for (const [name, r] of Object.entries(res)) console.log(`| ${name} | ${med(r.copy)} | ${med(r.daemon)} | ${(med(r.daemon) / med(r.copy)).toFixed(2)}x |`);
console.log(JSON.stringify(res));
