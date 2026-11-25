// Reading and the ring check for one item version, and the background job
// loop that checks uploaded versions. Until a version is checked it is
// unreachable to agents (store/drive.ts reachableView).
import path from 'node:path';
import { extract, ringCheck } from './reading.js';
import { all, get, run, tx } from '../store/db.js';
import type { Drive } from '../store/drive.js';
import { now } from '../util/ids.js';

/** Marker stored in a version's rings when the check could not decide: held for the person. */
export const HELD = 'held:uncertain';

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.py': 'text/x-python', '.ts': 'text/x-typescript', '.js': 'text/javascript',
  '.sh': 'text/x-shellscript', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain', '.log': 'text/plain', '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

export function mimeFor(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export interface CheckResult {
  rings: string[];
  extracted: { text: string; method: string; confidence: number };
  reasons: { ring: string; source: string; detail: string }[];
}

export async function checkContent(drive: Drive, a: { blob_hash: string; mime: string; name: string; source: string; batchLabels: string[] }): Promise<CheckResult> {
  const ex = await extract(drive.blobs.pathOf(a.blob_hash), a.mime, a.name);
  const rr = await ringCheck({ text: ex.text, name: a.name, mime: a.mime, source: a.source, batchLabels: a.batchLabels, extraction: { method: ex.method, confidence: ex.confidence } });
  const rings = new Set(rr.rings);
  const reasons = [...rr.reasons];
  // Unreadable input is never released unchecked, whatever the module says.
  if (rr.uncertain || ex.method === 'none') rings.add(HELD);
  // Text read by OCR (photos, screenshots, scans) is only as good as the OCR; decision 0002 measured misses there.
  // Until a vision model and a real sample pass the marks, an OCR item nothing placed in a ring waits for the person.
  if (ex.method === 'ocr' && rr.rings.length === 0 && !rings.has(HELD)) {
    rings.add(HELD);
    reasons.push({ ring: 'unknown', source: 'rule', detail: 'read by OCR and placed in no ring: held until the person clears it (decision 0002)' });
  }
  return { rings: [...rings].sort(), extracted: { text: ex.text, method: ex.method, confidence: ex.confidence }, reasons };
}

export function enqueueCheck(drive: Drive, item_id: string, version: number): void {
  run(drive.db, "INSERT INTO jobs (kind, item_id, version, status, created_at) VALUES ('check', ?, ?, 'pending', ?)", item_id, version, now());
}

/** Background loop: checks pending versions one by one. */
export class JobRunner {
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private idleWaiters: (() => void)[] = [];

  constructor(private drive: Drive, private onChecked: (item_id: string) => void | Promise<void>) {}

  start(intervalMs = 2000): void {
    // Any pending version without a job (e.g. after a crash) gets one.
    const db = this.drive.db;
    for (const v of all<{ item_id: string; version: number }>(
      db,
      "SELECT item_id, version FROM item_versions v WHERE ring_check = 'pending' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.item_id = v.item_id AND j.version = v.version AND j.status = 'pending')",
    )) enqueueCheck(this.drive, v.item_id, v.version);
    this.timer = setInterval(() => this.kick(), intervalMs);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.loop().finally(() => {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.kick();
      } else {
        for (const w of this.idleWaiters.splice(0)) w();
      }
    });
  }

  /** Resolves once no jobs are pending. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = get<{ n: number }>(this.drive.db, "SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'")?.n ?? 0;
      if (!pending && !this.running) return;
      await new Promise<void>((r) => {
        this.idleWaiters.push(r);
        this.kick();
      });
    }
  }

  private async loop(): Promise<void> {
    const db = this.drive.db;
    for (;;) {
      const job = get<{ job_id: number; item_id: string; version: number; attempts: number }>(db, "SELECT job_id, item_id, version, attempts FROM jobs WHERE status = 'pending' AND attempts < 3 ORDER BY job_id LIMIT 1");
      if (!job) return;
      try {
        await this.checkOne(job.item_id, job.version);
        run(db, "UPDATE jobs SET status = 'done', done_at = ? WHERE job_id = ?", now(), job.job_id);
        await this.onChecked(job.item_id);
      } catch (e) {
        const attempts = job.attempts + 1;
        run(db, 'UPDATE jobs SET attempts = ?, last_error = ?, status = ? WHERE job_id = ?', attempts, String(e).slice(0, 500), attempts >= 3 ? 'failed' : 'pending', job.job_id);
      }
    }
  }

  private async checkOne(item_id: string, version: number): Promise<void> {
    const drive = this.drive;
    const v = drive.version(item_id, version);
    const it = drive.item(item_id);
    if (!v || !it || v.ring_check === 'done') return;
    const labels = drive.itemLabels(item_id);
    const res = await checkContent(drive, { blob_hash: v.blob_hash, mime: v.mime, name: path.basename(it.path), source: 'upload', batchLabels: labels });
    tx(drive.db, () => {
      run(drive.db, "UPDATE item_versions SET ring_check = 'done', rings = ? WHERE item_id = ? AND version = ?", JSON.stringify(res.rings), item_id, version);
      run(drive.db, 'INSERT OR REPLACE INTO extracted_text (item_id, version, method, confidence, text) VALUES (?, ?, ?, ?, ?)', item_id, version, res.extracted.method, res.extracted.confidence, res.extracted.text);
      drive.reindex(item_id);
      // The reasons' details (masked by the rules) are for the person's held-items review (ingest/held.ts); activity is owner-only.
      drive.activity({ actor: 'drive', op: 'ring_check', item_id, detail: { version, rings: res.rings, reasons: res.reasons.map((r) => ({ ring: r.ring, source: r.source, detail: r.detail.slice(0, 200) })), method: res.extracted.method, confidence: res.extracted.confidence } });
    });
  }
}
