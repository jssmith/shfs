// A stand-in for server/src/reading/ (docs/contracts.md §3), with the same
// signatures. Plain text and Markdown only; four rules. The real module
// replaces it through ./reading.ts.
import { readFile } from 'node:fs/promises';

export interface Extraction {
  text: string;
  method: 'plain' | 'text-layer' | 'ocr' | 'none';
  confidence: number;
  description?: string;
}

export interface RingResult {
  rings: string[];
  uncertain: boolean;
  reasons: { ring: string; source: 'rule' | 'model'; detail: string }[];
}

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
const TEXT_EXT = /\.(txt|md|markdown|csv|json|log|ya?ml|toml|ini|py|ts|js|sh|html?|css|rs|go|c|h)$/i;

function isTexty(mime: string, name: string): boolean {
  return mime.startsWith('text/') || TEXT_MIMES.has(mime) || TEXT_EXT.test(name);
}

export async function extract(blobPath: string, mime: string, name: string): Promise<Extraction> {
  if (!isTexty(mime, name)) return { text: '', method: 'none', confidence: 0 };
  const buf = await readFile(blobPath);
  // A NUL byte in the first 8 KB means it is not text after all.
  if (buf.subarray(0, 8192).includes(0)) return { text: '', method: 'none', confidence: 0 };
  return { text: buf.toString('utf8'), method: 'plain', confidence: 1 };
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): string | null {
  const re = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
  for (const m of text.matchAll(re)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) return `Luhn-valid number of ${digits.length} digits`;
  }
  return null;
}

function hasIban(text: string): string | null {
  const re = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
  for (const m of text.matchAll(re)) {
    const compact = m[0].replace(/ /g, '');
    if (compact.length >= 15 && compact.length <= 34) return 'IBAN-shaped string';
  }
  return null;
}

export async function ringCheck(input: { text: string; name: string; mime: string; source: string; batchLabels: string[] }): Promise<RingResult> {
  const reasons: RingResult['reasons'] = [];
  const t = input.text;
  const card = hasCardNumber(t);
  if (card) reasons.push({ ring: 'ring:finance', source: 'rule', detail: card });
  const iban = hasIban(t);
  if (iban) reasons.push({ ring: 'ring:finance', source: 'rule', detail: iban });
  if (/recovery code/i.test(t)) reasons.push({ ring: 'ring:credentials', source: 'rule', detail: '"recovery code"' });
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(t)) reasons.push({ ring: 'ring:credentials', source: 'rule', detail: 'private key block' });
  for (const l of input.batchLabels) if (l.startsWith('ring:')) reasons.push({ ring: l, source: 'rule', detail: 'batch label' });
  const rings = [...new Set(reasons.map((r) => r.ring))].sort();
  // Callers also treat extraction method 'none' as uncertain (see ingest/check.ts).
  const uncertain = !t && !isTexty(input.mime, input.name);
  return { rings, uncertain, reasons };
}
