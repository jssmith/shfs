// Text extraction (docs/contracts.md §3): plain text, PDF text layers, and OCR
// for images and scanned PDFs. Needs `pdftotext`, `pdftoppm`, `pdfinfo` and
// `tesseract` on PATH; uses ImageMagick (`convert`) when present for a second
// OCR pass on hard images (orientation, contrast, upscaling).

import { execFile } from 'node:child_process';
import { mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Extraction {
  text: string;
  method: 'plain' | 'text-layer' | 'ocr' | 'none';
  confidence: number; // 0..1; OCR mean word confidence, 1 for plain text
  description?: string;
}

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PDF_PAGES = 10;
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.html', '.htm', '.xml',
  '.py', '.ts', '.js', '.go', '.rs', '.java', '.c', '.h', '.sh', '.sql', '.pem', '.key', '.log', '.conf', '.cfg']);
const IMAGE_MIME = /^image\/(png|jpeg|jpg|tiff|bmp|gif|webp|pnm|x-portable)/;

const env = { ...process.env, OMP_THREAD_LIMIT: '1' };
const opts = { env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 };

let convertAvailable: Promise<boolean> | undefined;
function hasConvert(): Promise<boolean> {
  convertAvailable ??= run('convert', ['-version'], opts).then(() => true, () => false);
  return convertAvailable;
}

async function sniffText(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.includes(0)) return false;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, bytesRead - 4)));
      return true;
    } catch {
      return false;
    }
  } finally {
    await fh.close();
  }
}

function isTextLike(mime: string, name: string): boolean {
  return mime.startsWith('text/') || /json|yaml|xml|javascript|x-sh|x-pem|toml|x-python/.test(mime) || TEXT_EXT.has(extname(name).toLowerCase())
    || /(^|\/)\.env/.test(name);
}

function stripHtml(s: string): string {
  return s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ');
}

interface OcrResult { text: string; confidence: number; words: number }

/** Parse tesseract TSV output into text (one line per OCR line) and mean word confidence. */
export function parseTsv(tsv: string): OcrResult {
  const lines = new Map<string, string[]>();
  let confSum = 0;
  let words = 0;
  for (const row of tsv.split('\n').slice(1)) {
    const cols = row.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const word = cols.slice(11).join('\t').trim();
    const conf = Number(cols[10]);
    if (!word || conf < 0) continue;
    const key = `${cols[1]}.${cols[2]}.${cols[3]}.${cols[4]}`;
    const line = lines.get(key) ?? [];
    line.push(word);
    lines.set(key, line);
    confSum += conf;
    words++;
  }
  const text = [...lines.values()].map((ws) => ws.join(' ')).join('\n');
  return { text, confidence: words ? confSum / words / 100 : 0, words };
}

async function tesseract(imagePath: string, psm = 3): Promise<OcrResult> {
  try {
    const { stdout } = await run('tesseract', [imagePath, 'stdout', '--psm', String(psm), '-l', 'eng', 'tsv'], opts);
    return parseTsv(stdout);
  } catch {
    return { text: '', confidence: 0, words: 0 };
  }
}

async function osdRotation(imagePath: string): Promise<number> {
  try {
    const { stdout } = await run('tesseract', [imagePath, 'stdout', '--psm', '0'], opts);
    const m = /Rotate:\s*(\d+)/.exec(stdout);
    const c = /Orientation confidence:\s*([\d.]+)/.exec(stdout);
    if (m && c && Number(c[1]) >= 1.5) return Number(m[1]);
  } catch {
    // OSD fails on images with little text; no rotation then.
  }
  return 0;
}

function better(a: OcrResult, b: OcrResult): OcrResult {
  const score = (r: OcrResult) => r.confidence * Math.min(1, r.words / 40) + r.words / 4000;
  return score(b) > score(a) ? b : a;
}

/** OCR one image: a plain pass, then, if that looks weak, a pass on a cleaned-up copy. */
export async function ocrImage(imagePath: string, workDir: string): Promise<OcrResult> {
  let best = await tesseract(imagePath);
  if (best.confidence >= 0.8 && best.words >= 5) return best;
  if (!(await hasConvert())) return best;
  const rot = await osdRotation(imagePath);
  const cleaned = join(workDir, `clean-${Math.random().toString(36).slice(2)}.png`);
  try {
    await run('convert', [imagePath, '-auto-orient', '-colorspace', 'Gray', ...(rot ? ['-rotate', String(rot)] : []),
      '-resize', '1600x1600<', '-normalize', '-unsharp', '0x1', cleaned], opts);
    best = better(best, await tesseract(cleaned));
    if (best.confidence < 0.6) best = better(best, await tesseract(cleaned, 6)); // single text block
  } catch {
    // keep the first pass
  }
  return best;
}

async function pdfPages(path: string): Promise<number> {
  try {
    const { stdout } = await run('pdfinfo', [path], opts);
    const m = /Pages:\s*(\d+)/.exec(stdout);
    return m ? Number(m[1]) : 1;
  } catch {
    return 0;
  }
}

async function extractPdf(path: string, workDir: string): Promise<Extraction> {
  const pages = await pdfPages(path);
  if (pages === 0) return { text: '', method: 'none', confidence: 0 };
  let layer = '';
  try {
    layer = (await run('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], opts)).stdout;
  } catch {
    layer = '';
  }
  const chars = layer.replace(/\s/g, '').length;
  if (chars >= 40 * Math.min(pages, MAX_PDF_PAGES)) return { text: layer, method: 'text-layer', confidence: 1 };
  // scanned: rasterise and OCR each page
  try {
    await run('pdftoppm', ['-r', '200', '-gray', '-png', '-l', String(MAX_PDF_PAGES), path, join(workDir, 'page')], opts);
  } catch {
    return { text: layer, method: layer.trim() ? 'text-layer' : 'none', confidence: layer.trim() ? 0.5 : 0 };
  }
  const files = (await readdir(workDir)).filter((f) => f.startsWith('page')).sort();
  const parts: string[] = [];
  let confSum = 0;
  let words = 0;
  for (const f of files) {
    const r = await ocrImage(join(workDir, f), workDir);
    parts.push(r.text);
    confSum += r.confidence * r.words;
    words += r.words;
  }
  const text = [layer.trim(), ...parts].filter(Boolean).join('\n\f\n');
  if (!text.trim()) return { text: '', method: 'none', confidence: 0 };
  return { text, method: 'ocr', confidence: words ? confSum / words : 0 };
}

export async function extract(blobPath: string, mime: string, name: string): Promise<Extraction> {
  const workDir = await mkdtemp(join(tmpdir(), 'agent-drive-read-'));
  try {
    if (mime === 'application/pdf' || extname(name).toLowerCase() === '.pdf') return await extractPdf(blobPath, workDir);
    if (IMAGE_MIME.test(mime) || /\.(png|jpe?g|tiff?|bmp|gif|webp)$/i.test(name)) {
      const r = await ocrImage(blobPath, workDir);
      if (!r.text.trim()) return { text: '', method: 'none', confidence: 0 };
      return { text: r.text, method: 'ocr', confidence: r.confidence };
    }
    if (isTextLike(mime, name) || (await sniffText(blobPath))) {
      const buf = await readFile(blobPath);
      let text = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8');
      if (/html/.test(mime) || /\.html?$/i.test(name)) text = stripHtml(text);
      return { text, method: 'plain', confidence: 1 };
    }
    return { text: '', method: 'none', confidence: 0 };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
