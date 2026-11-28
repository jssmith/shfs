// Randomised invariant test: random interleavings of uploads, session
// writes, checkpoints, trash and undo across several sessions. After every
// step: merged work is never lost, undo never overwrites later work, a failed
// merge changes nothing, every state reconstructs from the package log, and
// ringed or unchecked content never reaches a session.
import { expect, test } from 'vitest';
import fc from 'fast-check';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempContext, upload, settle, sessionDrive } from '../testing.js';
import { mergeSession } from './merge.js';
import { trashItem, undoPackage } from './undo.js';
import { all } from '../store/db.js';
import type { ItemTriple } from '../store/drive.js';

const CARD = 'card 4539 1488 0343 6467';
const PATHS = ['p/one.txt', 'p/two.txt', 'q/three.txt', 'four.txt', 'p/five.txt'];
const CONTENTS = ['alpha', 'beta', 'gamma', 'delta', CARD];
const SESSIONS = 3;

type Action =
  | { a: 'upload'; files: [number, number][]; settle: boolean }
  | { a: 'settle' }
  | { a: 'write'; s: number; p: number; c: number }
  | { a: 'delete'; s: number; p: number }
  | { a: 'move'; s: number; from: number; to: number }
  | { a: 'checkpoint'; s: number }
  | { a: 'trash'; i: number }
  | { a: 'undo'; k: number; force: boolean };

const idx = (n: number) => fc.nat({ max: n - 1 });
const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ a: fc.constant('upload' as const), files: fc.array(fc.tuple(idx(PATHS.length), idx(CONTENTS.length)), { minLength: 1, maxLength: 3 }), settle: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('settle' as const) }) },
  { weight: 4, arbitrary: fc.record({ a: fc.constant('write' as const), s: idx(SESSIONS), p: idx(PATHS.length), c: idx(CONTENTS.length) }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('delete' as const), s: idx(SESSIONS), p: idx(PATHS.length) }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('move' as const), s: idx(SESSIONS), from: idx(PATHS.length), to: idx(PATHS.length) }) },
  { weight: 3, arbitrary: fc.record({ a: fc.constant('checkpoint' as const), s: idx(SESSIONS) }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('trash' as const), i: fc.nat({ max: 20 }) }) },
  { weight: 2, arbitrary: fc.record({ a: fc.constant('undo' as const), k: fc.nat({ max: 30 }), force: fc.boolean() }) },
);

const stats = { runs: 0, steps: 0, merges: 0, failedMerges: 0, undos: 0, undoConflicts: 0, trashes: 0 };

function fingerprint(ctx: ReturnType<typeof tempContext>): string {
  return JSON.stringify([
    [...ctx.drive.snapshot().entries()].sort(),
    all(ctx.drive.db, 'SELECT item_id, version, blob_hash, ring_check, rings FROM item_versions ORDER BY item_id, version'),
    ctx.drive.packages().length,
    ctx.drive.currentState(),
  ]);
}

async function content(ctx: ReturnType<typeof tempContext>, item_id: string, version: number): Promise<string> {
  const v = ctx.drive.version(item_id, version)!;
  return (await ctx.drive.blobs.get(v.blob_hash)).toString();
}

async function checkInvariants(ctx: ReturnType<typeof tempContext>, dirs: string[], merged: { item_id: string; version: number }[]) {
  // Every state reconstructs exactly from the packages.
  expect(ctx.drive.reconstruct()).toEqual(ctx.drive.snapshot());
  // Merged work is never lost: every merged version and its blob still exist.
  for (const m of merged) {
    const v = ctx.drive.version(m.item_id, m.version);
    expect(v).toBeDefined();
    expect(ctx.drive.blobs.has(v!.blob_hash)).toBe(true);
  }
  // Nothing ringed or unchecked is reachable or in any session's view.
  const view = ctx.drive.reachableView();
  for (const e of view) {
    const v = ctx.drive.version(e.item_id, e.version)!;
    expect(v.ring_check).toBe('done');
    expect(JSON.parse(v.rings)).toEqual([]);
    expect(await content(ctx, e.item_id, e.version)).not.toContain('4539 1488 0343 6467');
  }
  for (const dir of dirs) {
    for (const r of all<{ item_id: string; path: string; version: number }>(ctx.drive.db, 'SELECT item_id, path, version FROM session_view WHERE dir_id = ?', dir)) {
      // A session may still see an item another session archived (until its
      // next rebase), but never a trashed, ringed or unchecked one.
      expect(ctx.drive.item(r.item_id)!.state).not.toBe('trashed');
      const v = ctx.drive.version(r.item_id, r.version)!;
      expect(v.ring_check).toBe('done');
      expect(JSON.parse(v.rings)).toEqual([]);
      if (ctx.drive.item(r.item_id)!.state === 'live') expect(ctx.drive.hidingRings(r.item_id)).toEqual([]);
    }
  }
}

test('merge and undo invariants hold under random interleavings', async () => {
  const runs = Number(process.env.INVARIANT_RUNS ?? 150);
  await fc.assert(
    fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 40 }), async (actions) => {
      const ctx = tempContext();
      stats.runs++;
      try {
        const dirs: string[] = [];
        for (let i = 0; i < SESSIONS; i++) dirs.push((await ctx.sessions.start('conn', `session ${i}`, {})).row.dir_id);
        const merged: { item_id: string; version: number }[] = [];
        const drives = await Promise.all(dirs.map((d) => sessionDrive(ctx, d)));
        const upper = (s: number) => drives[s]!;
        const touchAll = async (ids: string[]) => {
          for (const id of ids) await ctx.sessions.applyVisibility(id);
        };
        for (const act of actions) {
          stats.steps++;
          switch (act.a) {
            case 'upload': {
              const files: Record<string, string> = {};
              for (const [p, c] of act.files) files[PATHS[p]!] = `${CONTENTS[c]!} up${stats.steps}`;
              await upload(ctx, files);
              if (act.settle) await settle(ctx);
              break;
            }
            case 'settle':
              await settle(ctx);
              break;
            case 'write': {
              const f = path.join(upper(act.s), PATHS[act.p]!);
              mkdirSync(path.dirname(f), { recursive: true });
              writeFileSync(f, `${CONTENTS[act.c]!} s${act.s} ${stats.steps}`);
              break;
            }
            case 'delete': {
              const f = path.join(upper(act.s), PATHS[act.p]!);
              if (existsSync(f)) unlinkSync(f);
              break;
            }
            case 'move': {
              const f = path.join(upper(act.s), PATHS[act.from]!);
              const t = path.join(upper(act.s), PATHS[act.to]!);
              if (existsSync(f) && !existsSync(t)) {
                mkdirSync(path.dirname(t), { recursive: true });
                renameSync(f, t);
              }
              break;
            }
            case 'checkpoint': {
              const dir = dirs[act.s]!;
              const files = new Map<string, string>();
              for (const p of PATHS) {
                const f = path.join(upper(act.s), p);
                if (existsSync(f)) files.set(p, readFileSync(f, 'utf8'));
              }
              const before = fingerprint(ctx);
              const r = await ctx.sessions.lock.run(dir, () => mergeSession(ctx.sessions, dir, 'checkpoint', 'random'));
              if (!r.ok) {
                stats.failedMerges++;
                // A failed merge changes nothing.
                expect(fingerprint(ctx)).toBe(before);
              } else if (r.pkg_id) {
                stats.merges++;
                // The merged work is in the drive exactly as the session had it.
                const pkg = ctx.drive.pkg(r.pkg_id)!;
                for (const op of JSON.parse(pkg.operations) as { op: string; item_id: string; to_version?: number; path?: string }[]) {
                  const t = ctx.drive.triple(op.item_id)!;
                  if (op.op === 'create' || op.op === 'update') {
                    merged.push({ item_id: op.item_id, version: op.to_version! });
                    expect(t.version).toBe(op.to_version);
                    expect(await content(ctx, op.item_id, op.to_version!)).toBe(files.get(t.path));
                  }
                  if (op.op === 'archive') expect(t.state).toBe('archived');
                }
              }
              break;
            }
            case 'trash': {
              const live = ctx.drive.reachableView();
              if (!live.length) break;
              const it = live[act.i % live.length]!;
              trashItem(ctx.drive, it.item_id);
              await touchAll([it.item_id]);
              stats.trashes++;
              break;
            }
            case 'undo': {
              const pkgs = ctx.drive.packages();
              if (!pkgs.length) break;
              const pkg = pkgs[act.k % pkgs.length]!;
              const pre = ctx.drive.snapshot();
              const { before: pkgBefore, after: pkgAfter } = ctx.drive.snapshotsAround(pkg.pkg_id);
              const touched = [...new Set((JSON.parse(pkg.operations) as { item_id: string }[]).map((o) => o.item_id))];
              const changedSince = touched.filter((id) => JSON.stringify(pre.get(id)) !== JSON.stringify(pkgAfter.get(id)));
              const force = act.force && changedSince.length ? [changedSince[0]!] : [];
              const u = undoPackage(ctx.drive, pkg.pkg_id, { force });
              stats.undos++;
              stats.undoConflicts += u.conflicts.length;
              const post = ctx.drive.snapshot();
              // Undo never overwrites later work: items changed since, and not forced, are untouched.
              for (const id of changedSince) if (!force.includes(id)) expect(post.get(id)).toEqual(pre.get(id));
              // Conflicting items are untouched; items outside the package are untouched.
              for (const c of u.conflicts) expect(post.get(c.item_id)).toEqual(pre.get(c.item_id));
              for (const [id, t] of pre) if (!touched.includes(id)) expect(post.get(id)).toEqual(t);
              // Reverted items are back to how they were before the package (content, path, state).
              for (const r of u.reverted) {
                const want: ItemTriple | undefined = pkgBefore.get(r.item_id);
                const got = post.get(r.item_id)!;
                if (!want) expect(got.state).not.toBe('live');
                else {
                  expect(got.state).toBe(want.state);
                  if (want.state === 'live') {
                    expect(got.path).toBe(want.path);
                    expect(await content(ctx, r.item_id, got.version)).toBe(await content(ctx, r.item_id, want.version));
                  }
                }
              }
              await touchAll(touched);
              break;
            }
          }
          await checkInvariants(ctx, dirs, merged);
        }
      } finally {
        await ctx.dispose();
      }
    }),
    { numRuns: runs },
  );
  console.log('invariant stats', stats);
  expect(stats.merges).toBeGreaterThan(0);
  expect(stats.failedMerges).toBeGreaterThan(0);
  expect(stats.undoConflicts).toBeGreaterThan(0);
}, 600_000);
