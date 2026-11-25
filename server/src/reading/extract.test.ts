import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, describe, expect, test } from 'vitest';
import { extract, parseTsv } from './extract.js';

const dir = mkdtempSync(join(tmpdir(), 'agent-drive-extract-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function has(cmd: string, arg = '-v'): boolean {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const haveOcr = has('tesseract', '--version') && has('pdftoppm') && has('pdftotext') && has('pdfinfo');

/** Assemble a PDF from object bodies, computing the cross-reference table. */
function pdf(objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let len = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(len);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    len += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function textPdf(lines: string[]): Buffer {
  const ops = lines.map((l, i) => `BT /F1 20 Tf 60 ${760 - i * 34} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/** A PDF whose only page is a grey-scale image: what a scanner produces. */
function imagePdf(width: number, height: number, pixels: Buffer): Buffer {
  const data = deflateSync(pixels);
  const ops = `q 612 0 0 ${Math.round((612 * height) / width)} 0 0 cm /Im1 Do Q`;
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${Math.round((612 * height) / width)}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>`,
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`),
      data, Buffer.from('\nendstream'),
    ]),
  ]);
}

/** Parse a binary PGM (P5) as pdftoppm writes it. */
function readPgm(path: string): { width: number; height: number; pixels: Buffer } {
  const buf = readFileSync(path);
  const header = buf.subarray(0, 64).toString('latin1');
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(header)!;
  return { width: Number(m[1]), height: Number(m[2]), pixels: buf.subarray(m[0].length) };
}

const LINES = ['Laboratory report', 'Patient: Ana Example', 'Haemoglobin 13.2 g/dL', 'Reference range 12-17'];

describe('extract: plain text', () => {
  test('text files are read as they are', async () => {
    const p = join(dir, 'note.txt');
    writeFileSync(p, 'Repaint the fence\nCall the plumber\n');
    expect(await extract(p, 'text/plain', 'note.txt')).toEqual({ text: 'Repaint the fence\nCall the plumber\n', method: 'plain', confidence: 1 });
  });

  test('HTML loses its tags', async () => {
    const p = join(dir, 'a.html');
    writeFileSync(p, '<html><head><style>p{}</style></head><body><p>Hello</p><p>World &amp; more</p></body></html>');
    const r = await extract(p, 'text/html', 'a.html');
    expect(r.text).toContain('Hello');
    expect(r.text).toContain('World & more');
    expect(r.text).not.toContain('<p>');
  });

  test('files without an extension are sniffed; binary is unreadable', async () => {
    const key = join(dir, 'id_rsa');
    writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n');
    expect((await extract(key, 'application/octet-stream', 'id_rsa')).method).toBe('plain');
    const bin = join(dir, 'blob');
    writeFileSync(bin, Buffer.from([0, 1, 2, 3, 255, 0, 7]));
    expect(await extract(bin, 'application/octet-stream', 'blob')).toEqual({ text: '', method: 'none', confidence: 0 });
  });
});

describe('extract: tesseract output', () => {
  test('TSV words become lines, with mean confidence', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '4\t1\t1\t1\t1\t0\t0\t0\t10\t10\t-1\t',
      '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\tHello',
      '5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t80\tthere',
      '5\t1\t1\t1\t2\t1\t0\t0\t10\t10\t70\tAgain',
    ].join('\n');
    expect(parseTsv(tsv)).toEqual({ text: 'Hello there\nAgain', confidence: 0.8, words: 3 });
  });
});

describe.skipIf(!haveOcr)('extract: PDFs and OCR (needs tesseract and poppler-utils)', () => {
  test('a PDF with a text layer', async () => {
    const p = join(dir, 'text.pdf');
    writeFileSync(p, textPdf(LINES));
    const r = await extract(p, 'application/pdf', 'text.pdf');
    expect(r.method).toBe('text-layer');
    expect(r.text).toContain('Haemoglobin 13.2');
  });

  test('an image is read with OCR', async () => {
    const p = join(dir, 'source.pdf');
    writeFileSync(p, textPdf(LINES));
    execFileSync('pdftoppm', ['-r', '150', '-gray', '-png', '-singlefile', p, join(dir, 'photo')]);
    const r = await extract(join(dir, 'photo.png'), 'image/png', 'photo.png');
    expect(r.method).toBe('ocr');
    expect(r.confidence).toBeGreaterThan(0.7);
    expect(r.text).toMatch(/Laboratory report/);
    expect(r.text).toMatch(/Reference range/);
  }, 60_000);

  test('a scanned PDF (image only) is rasterised and read with OCR', async () => {
    const src = join(dir, 'src2.pdf');
    writeFileSync(src, textPdf(LINES));
    execFileSync('pdftoppm', ['-r', '150', '-gray', '-singlefile', src, join(dir, 'scan')]);
    const pgm = readdirSync(dir).find((f) => f.startsWith('scan') && f.endsWith('.pgm'))!;
    const { width, height, pixels } = readPgm(join(dir, pgm));
    const p = join(dir, 'scanned.pdf');
    writeFileSync(p, imagePdf(width, height, pixels));
    const r = await extract(p, 'application/pdf', 'scanned.pdf');
    expect(r.method).toBe('ocr');
    expect(r.text).toMatch(/Patient: Ana Example/);
  }, 60_000);

  test('a broken PDF is unreadable', async () => {
    const p = join(dir, 'broken.pdf');
    writeFileSync(p, '%PDF-1.4 not really');
    expect((await extract(p, 'application/pdf', 'broken.pdf')).method).toBe('none');
  });
});
