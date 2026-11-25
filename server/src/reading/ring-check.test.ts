import { expect, test } from 'vitest';
import { ringCheck } from './ring-check.js';

const plain = (text: string) => ({ text, name: 'n.txt', mime: 'text/plain', source: 'upload', batchLabels: [], extraction: { method: 'plain' as const, confidence: 1 } });

test('short plain text is readable, not held as unreadable', async () => {
  for (const t of ['# hello', 'my own notes', '']) {
    const r = await ringCheck(plain(t), { model: null });
    expect(r.uncertain).toBe(false);
    expect(r.rings).toEqual([]);
  }
});

test('a little OCR text still counts as a failed read', async () => {
  const r = await ringCheck({ ...plain('ab c'), mime: 'image/png', extraction: { method: 'ocr', confidence: 0.9 } }, { model: null });
  expect(r.uncertain).toBe(true);
});
