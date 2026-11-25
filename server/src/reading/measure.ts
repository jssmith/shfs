// Measures extraction and the ring check over a generated corpus
// (test/fixtures/generate.py) against the pass marks in security design §2.
//
//   npm run build
//   node server/dist/reading/measure.js --corpus /tmp/a1-corpus --cache /tmp/a1-measure [--jobs 3]
//        [--model <ollama tag> --ollama http://127.0.0.1:11434] [--sample N]
//
// Extraction results and model opinions are cached in --cache, so a rerun
// with other thresholds costs nothing.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { extract, type Extraction } from './extract.js';
import { ollamaModel, type ModelOpinion } from './model.js';
import { decide, DEFAULTS, type RingResult } from './ring-check.js';
import { RINGS, ruleSignals, type Ring } from './rules.js';

interface Item { path: string; mime: string; rings: string[]; kind: string; rendering: string; hard_negative: boolean; set: string; degradation?: Record<string, unknown> }

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function readJsonl<T>(path: string): Map<string, T> {
  const m = new Map<string, T>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { path: string } & T;
    m.set(row.path, row);
  }
  return m;
}

async function pool<T>(items: T[], jobs: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

interface Row { path: string; ex: Extraction & { ms: number }; opinion?: ModelOpinion | null }

function evaluate(items: Item[], rows: Map<string, Row>, label: string, withModel: boolean, outDir: string, policy: { modelClears?: boolean } = {}) {
  const results = new Map<string, RingResult>();
  for (const it of items) {
    const row = rows.get(it.path)!;
    const input = { text: row.ex.text, name: it.path, mime: it.mime, source: 'upload', batchLabels: [], extraction: row.ex };
    results.set(it.path, decide(input, ruleSignals({ text: input.text, name: input.name }), withModel ? row.opinion ?? null : null, policy));
  }
  const lines: string[] = [];
  lines.push(`\n### ${label}\n`);
  lines.push('| Ring | Items | Recall (ring assigned) | Held (ring or uncertain) | Leaked (no ring, not uncertain) | Precision | Mark |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const marks: Record<Ring, number> = { 'ring:credentials': 1, 'ring:finance': 0.98, 'ring:identity': 0.98, 'ring:health': 0.97, 'ring:intimate': 0.97 };
  const summary: Record<string, unknown> = {};
  const misses: unknown[] = [];
  for (const r of RINGS) {
    const truth = items.filter((i) => i.rings.includes(r));
    const hit = truth.filter((i) => results.get(i.path)!.rings.includes(r));
    const held = truth.filter((i) => { const x = results.get(i.path)!; return x.rings.length > 0 || x.uncertain; });
    const leaked = truth.length - held.length;
    const pred = items.filter((i) => results.get(i.path)!.rings.includes(r));
    const tp = pred.filter((i) => i.rings.includes(r));
    const recall = truth.length ? hit.length / truth.length : 0;
    const mark = r === 'ring:credentials' ? (hit.length === truth.length ? 'met' : `not met (${truth.length - hit.length} misses)`) : (recall >= marks[r] ? 'met' : 'not met');
    lines.push(`| ${r.slice(5)} | ${truth.length} | ${pct(hit.length, truth.length)} (${hit.length}) | ${pct(held.length, truth.length)} | ${leaked} | ${pct(tp.length, pred.length)} (${tp.length}/${pred.length}) | ${mark} |`);
    summary[r] = { items: truth.length, recall, held: held.length / (truth.length || 1), leaked, precision: pred.length ? tp.length / pred.length : null };
    for (const i of truth) {
      const x = results.get(i.path)!;
      if (!x.rings.includes(r)) {
        const row = rows.get(i.path)!;
        misses.push({ ring: r, path: i.path, kind: i.kind, rendering: i.rendering, degradation: i.degradation, predicted: x.rings, uncertain: x.uncertain,
          method: row.ex.method, ocrConfidence: Number(row.ex.confidence.toFixed(2)), reasons: x.reasons, model: row.opinion?.scores, text: row.ex.text.slice(0, 300) });
      }
    }
  }
  const anyPred = items.filter((i) => results.get(i.path)!.rings.length > 0);
  const anyTp = anyPred.filter((i) => i.rings.length > 0);
  const uncertain = items.filter((i) => results.get(i.path)!.uncertain);
  const negatives = items.filter((i) => i.rings.length === 0);
  const fp = negatives.filter((i) => results.get(i.path)!.rings.length > 0);
  const hardNeg = negatives.filter((i) => i.hard_negative);
  const hardFp = hardNeg.filter((i) => results.get(i.path)!.rings.length > 0);
  const mainItems = items.filter((i) => i.set === 'main');
  const mainUnc = mainItems.filter((i) => results.get(i.path)!.uncertain);
  lines.push('');
  lines.push(`- Precision, any ring (flagged items that are truly in some ring): ${pct(anyTp.length, anyPred.length)} (${anyTp.length}/${anyPred.length}) — mark 60%: ${anyPred.length && anyTp.length / anyPred.length >= 0.6 ? 'met' : 'not met'}`);
  lines.push(`- Left uncertain: ${pct(uncertain.length, items.length)} of all items (${uncertain.length}); ${pct(mainUnc.length, mainItems.length)} of the main set without the dedicated credentials set — mark ≤5%: ${uncertain.length / items.length <= 0.05 ? 'met' : 'not met'}`);
  lines.push(`- Ordinary items wrongly ringed: ${fp.length}/${negatives.length}; of the hard negatives: ${hardFp.length}/${hardNeg.length}`);
  const byRender = new Map<string, { n: number; miss: number; unc: number }>();
  for (const i of items.filter((x) => x.rings.length)) {
    const x = results.get(i.path)!;
    const b = byRender.get(i.rendering) ?? { n: 0, miss: 0, unc: 0 };
    b.n++;
    if (!i.rings.every((r) => x.rings.includes(r))) b.miss++;
    if (x.uncertain) b.unc++;
    byRender.set(i.rendering, b);
  }
  lines.push('\n| Rendering (sensitive items) | Items | Missed a true ring | Uncertain |');
  lines.push('| --- | --- | --- | --- |');
  for (const [k, b] of [...byRender].sort()) lines.push(`| ${k} | ${b.n} | ${b.miss} (${pct(b.miss, b.n)}) | ${b.unc} |`);
  const fpDetail = fp.map((i) => ({ path: i.path, kind: i.kind, hard: i.hard_negative, predicted: results.get(i.path)!.rings, reasons: results.get(i.path)!.reasons }));
  const slug = label.replace(/\W+/g, '-').toLowerCase();
  writeFileSync(join(outDir, `misses-${slug}.json`), JSON.stringify(misses, null, 1));
  writeFileSync(join(outDir, `false-positives-${slug}.json`), JSON.stringify(fpDetail, null, 1));
  writeFileSync(join(outDir, `uncertain-${slug}.json`), JSON.stringify(uncertain.map((i) => ({ path: i.path, truth: i.rings, kind: i.kind, rendering: i.rendering, reasons: results.get(i.path)!.reasons })), null, 1));
  summary.anyPrecision = anyPred.length ? anyTp.length / anyPred.length : null;
  summary.uncertain = uncertain.length / items.length;
  summary.falsePositives = fp.length;
  return { text: lines.join('\n'), summary };
}

async function main() {
  const corpus = arg('corpus');
  const cache = arg('cache', '/tmp/a1-measure')!;
  if (!corpus) throw new Error('--corpus is required');
  mkdirSync(cache, { recursive: true });
  const jobs = Number(arg('jobs', '3'));
  const manifest = JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8')) as { items: Item[] };
  let items = manifest.items;
  const sample = Number(arg('sample', '0'));
  if (sample) items = items.filter((_, i) => i % Math.ceil(manifest.items.length / sample) === 0);

  // 1. extraction (cached)
  const exPath = join(cache, 'extract.jsonl');
  const cached = readJsonl<{ ex: Extraction & { ms: number } }>(exPath);
  const todo = items.filter((i) => !cached.has(i.path));
  const timing: Record<string, { files: number; wallMs: number; perFileMs: number[] }> = {};
  for (const group of ['other', 'ocr']) {
    const part = todo.filter((i) => (group === 'ocr') === !['native', 'pdf-text'].includes(i.rendering));
    if (!part.length) continue;
    const t0 = Date.now();
    const per: number[] = [];
    let done = 0;
    await pool(part, jobs, async (it) => {
      const s = Date.now();
      const ex = await extract(join(corpus, it.path), it.mime, it.path);
      const ms = Date.now() - s;
      per.push(ms);
      cached.set(it.path, { ex: { ...ex, ms } });
      appendFileSync(exPath, JSON.stringify({ path: it.path, ex: { ...ex, ms } }) + '\n');
      if (++done % 50 === 0) process.stderr.write(`extract ${group}: ${done}/${part.length}\n`);
    });
    timing[group] = { files: part.length, wallMs: Date.now() - t0, perFileMs: per.sort((a, b) => a - b) };
  }
  if (Object.keys(timing).length) writeFileSync(join(cache, `timing-${Date.now()}.json`), JSON.stringify({ jobs, cpus: cpus().length, timing }, null, 1));

  const rows = new Map<string, Row>();
  for (const it of items) rows.set(it.path, { path: it.path, ex: cached.get(it.path)!.ex });

  // 2. model (cached per model)
  const model = arg('model');
  if (model) {
    const mPath = join(cache, `model-${model.replace(/\W+/g, '_')}.jsonl`);
    const mc = readJsonl<{ opinion: ModelOpinion | null }>(mPath);
    const m = ollamaModel(model, arg('ollama', 'http://127.0.0.1:11434'));
    let done = 0;
    const mTodo = items.filter((i) => !mc.has(i.path));
    const t0 = Date.now();
    for (const it of mTodo) {
      const row = rows.get(it.path)!;
      let opinion: ModelOpinion | null = null;
      if (row.ex.text.trim()) {
        try {
          opinion = await m.classify({ text: row.ex.text, name: it.path, mime: it.mime, source: 'upload', batchLabels: [] });
        } catch (e) {
          opinion = { scores: {}, raw: `error: ${(e as Error).message}`, ms: 0 };
        }
      }
      mc.set(it.path, { opinion });
      appendFileSync(mPath, JSON.stringify({ path: it.path, opinion }) + '\n');
      if (++done % 25 === 0) process.stderr.write(`model: ${done}/${mTodo.length} (${((Date.now() - t0) / done / 1000).toFixed(1)} s/item)\n`);
    }
    for (const it of items) rows.get(it.path)!.opinion = mc.get(it.path)?.opinion ?? null;
  }

  // 3. report
  const out: string[] = [];
  out.push(`# Ring check measurement\n\nCorpus: ${corpus} (${items.length} items; ${items.filter((i) => i.set === 'credentials-dedicated').length} in the dedicated credentials set). Thresholds: ${JSON.stringify(DEFAULTS)}.`);
  const exRows = [...rows.values()];
  const byMethod = new Map<string, number>();
  for (const r of exRows) byMethod.set(r.ex.method, (byMethod.get(r.ex.method) ?? 0) + 1);
  out.push(`\nExtraction methods: ${[...byMethod].map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  const ocr = items.filter((i) => !['native', 'pdf-text'].includes(i.rendering)).map((i) => rows.get(i.path)!.ex);
  const ms = ocr.map((e) => e.ms).sort((a, b) => a - b);
  const conf = ocr.filter((e) => e.method === 'ocr').map((e) => e.confidence).sort((a, b) => a - b);
  if (ms.length) {
    out.push(`OCR items: ${ms.length}; per-file time median ${(ms[Math.floor(ms.length / 2)]! / 1000).toFixed(1)} s, p90 ${(ms[Math.floor(ms.length * 0.9)]! / 1000).toFixed(1)} s, max ${(ms[ms.length - 1]! / 1000).toFixed(1)} s; mean OCR word confidence median ${conf[Math.floor(conf.length / 2)]?.toFixed(2)}.`);
  }
  for (const [g, t] of Object.entries(timing)) out.push(`Throughput (${g}, ${jobs} jobs, this run): ${t.files} files in ${(t.wallMs / 1000).toFixed(0)} s = ${((t.files * 60000) / t.wallMs).toFixed(1)} files/min.`);
  const summaries: Record<string, unknown> = {};
  const a = evaluate(items, rows, 'Rules only', false, cache);
  out.push(a.text);
  summaries.rules = a.summary;
  if (model) {
    const b = evaluate(items, rows, `Rules and model ${model}`, true, cache);
    out.push(b.text);
    summaries.model = b.summary;
    const c = evaluate(items, rows, `Rules and model ${model}, model may settle weak rule uncertainty`, true, cache, { modelClears: true });
    out.push(c.text);
    summaries.modelClears = c.summary;
    const mms = items.map((i) => rows.get(i.path)!.opinion?.ms ?? 0).filter((x) => x > 0).sort((x, y) => x - y);
    if (mms.length) out.push(`\nModel time per item: median ${(mms[Math.floor(mms.length / 2)]! / 1000).toFixed(1)} s, p90 ${(mms[Math.floor(mms.length * 0.9)]! / 1000).toFixed(1)} s (${mms.length} items, one at a time).`);
  }
  const report = out.join('\n');
  writeFileSync(join(cache, `report${model ? '-' + model.replace(/\W+/g, '_') : ''}.md`), report + '\n');
  writeFileSync(join(cache, `summary${model ? '-' + model.replace(/\W+/g, '_') : ''}.json`), JSON.stringify(summaries, null, 1));
  console.log(report);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
