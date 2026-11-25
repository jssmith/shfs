import { afterEach, beforeEach, expect, test } from 'vitest';
import { tempContext, upload, settle } from '../testing.js';
import { approx, hiddenSummary, kindWords, monthWords, queryTerms, ringName } from './search.js';

let ctx: ReturnType<typeof tempContext>;
beforeEach(() => {
  ctx = tempContext();
});
afterEach(async () => {
  await ctx.dispose();
});

test('approximate counts and names', () => {
  expect(approx(3)).toBe('3');
  expect(approx(10)).toBe('10');
  expect(approx(12)).toBe('about 12');
  expect(approx(1234)).toBe('about 1,200');
  expect(approx(98765)).toBe('about 99,000');
  expect(ringName('ring:finance')).toBe('Finance');
  expect(ringName('held:uncertain')).toBe('Held for the person to check');
  expect(hiddenSummary([{ ring: 'ring:finance', count: 12, by: ['label'] }])).toBe('Finance: about 12 items match by label');
  expect(queryTerms('Expiry 09/29')).toEqual(['expiry', '09', '29']);
  expect(kindWords('application/pdf')).toContain('pdf');
  expect(monthWords('2026-10-03T10:00:00Z')).toEqual(['2026', '2026-10', 'october', 'oct']);
});

test('hidden items match on labels, kind and month, never on text or name', async () => {
  await upload(ctx, {
    'money/card-zebra.txt': 'Card 4539 1488 0343 6467, Expiry 09/29.\n',
    'notes/plan.md': 'Expiry of the lease is in 2029.\n',
  }, ['topic:household']);
  await settle(ctx);
  const { row } = await ctx.sessions.start('c', 'p', {});
  const s = (q: string) => ctx.sessions.search(row.dir_id, q);
  expect(s('Expiry').results.map((r) => r.path)).toEqual(['/drive/notes/plan.md']);
  expect(s('Expiry').hidden).toEqual([]);
  expect(s('09/29').hidden).toEqual([]);
  expect(s('4539').hidden).toEqual([]);
  expect(s('zebra').hidden).toEqual([]);
  expect(s('finance').hidden).toEqual([{ ring: 'ring:finance', count: 1, by: ['label'] }]);
  expect(s('household').hidden).toEqual([{ ring: 'ring:finance', count: 1, by: ['label'] }]);
  expect(s('text').hidden).toEqual([{ ring: 'ring:finance', count: 1, by: ['kind'] }]);
  const month = monthWords(new Date().toISOString())[2]!;
  expect(s(month).hidden).toEqual([{ ring: 'ring:finance', count: 1, by: ['month'] }]);
});
