import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const generator = new URL('../fixtures/generate.py', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'agent-drive-corpus-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function canGenerate(): boolean {
  try {
    execFileSync('python3', ['-I', '-c', 'import PIL, numpy, reportlab'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface Manifest { seed: string; synthetic: boolean; items: { path: string; mime: string; rings: string[]; kind: string; topics: string[] }[] }

function generate(out: string, seed: string): Manifest {
  execFileSync('python3', ['-I', generator, '--out', out, '--seed', seed, '--limit', '40'], { stdio: 'ignore' });
  return JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Manifest;
}

function digest(root: string, m: Manifest): string {
  const h = createHash('sha256');
  for (const it of m.items) h.update(it.path).update(readFileSync(join(root, it.path)));
  return h.digest('hex');
}

describe.skipIf(!canGenerate())('synthetic corpus generator (needs python3 with PIL, numpy, reportlab)', () => {
  test('writes files and a manifest with ground truth, deterministically', () => {
    const a = generate(join(dir, 'a'), '7');
    const b = generate(join(dir, 'b'), '7');
    expect(a.synthetic).toBe(true);
    expect(a.items).toHaveLength(40);
    for (const it of a.items) {
      expect(existsSync(join(dir, 'a', it.path))).toBe(true);
      expect(it.mime).toMatch(/\//);
      expect(Array.isArray(it.rings)).toBe(true);
      for (const r of it.rings) expect(r).toMatch(/^ring:(finance|identity|health|intimate|credentials)$/);
      expect(it.kind).toBeTruthy();
    }
    expect(digest(join(dir, 'b'), b)).toBe(digest(join(dir, 'a'), a));
    const c = generate(join(dir, 'c'), '8');
    expect(digest(join(dir, 'c'), c)).not.toBe(digest(join(dir, 'a'), a));
  }, 120_000);

  test('refuses to write inside the repository', () => {
    const inside = new URL('../fixtures/should-not-exist', import.meta.url).pathname;
    expect(() => execFileSync('python3', ['-I', generator, '--out', inside, '--limit', '1'], { stdio: 'ignore' })).toThrow();
    expect(existsSync(inside)).toBe(false);
  });
});
