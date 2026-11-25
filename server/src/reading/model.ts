// The model stage of the ring check: a small local model behind Ollama's HTTP
// API. It reads the extracted text and metadata and gives each ring a score.
// Configured by AGENT_DRIVE_RING_MODEL (model tag) and AGENT_DRIVE_OLLAMA_URL;
// with no model configured the stage is a stub that gives no opinion.

import { RINGS, type Ring } from './rules.js';

export interface ModelInput { text: string; name: string; mime: string; source: string; batchLabels: string[] }
export interface ModelOpinion { scores: Partial<Record<Ring, number>>; raw?: string; ms: number }
export interface RingModel {
  name: string;
  classify(input: ModelInput): Promise<ModelOpinion | null>;
}

export const MODEL_TEXT_CHARS = 1500;

const SYSTEM = `You sort a person's files into privacy rings. Rings:
- finance: bank, card or brokerage statements, payslips, tax forms, loans and mortgages, money transfers, account or card numbers.
- identity: passports, identity cards, driver licences, social security or national insurance numbers, birth certificates, residence permits, identity checks.
- health: medical letters, test results, prescriptions, diagnoses, therapy notes, vaccination records, health insurance claims.
- intimate: private letters, love letters, diaries and journals, relationships, sexuality, family conflict.
- credentials: passwords, password exports, recovery or backup codes, private keys, API keys or tokens, wallet seed phrases, 2FA secrets.
Ordinary files are in no ring: receipts, recipes, code without real secrets, articles and fiction that only talk about a topic, contracts, invoices, tickets, notes, manuals.
Text may come from OCR and contain errors.
Reply with JSON only: for each ring, a number from 0 to 100 for how likely the file belongs in it.`;

const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(RINGS.map((r) => [r.slice(5), { type: 'integer' }])),
  required: RINGS.map((r) => r.slice(5)),
};

export function ollamaModel(model: string, baseUrl = 'http://127.0.0.1:11434', timeoutMs = 120_000): RingModel {
  return {
    name: `ollama:${model}`,
    async classify(input) {
      const t0 = Date.now();
      const prompt = `File name: ${input.name}\nType: ${input.mime}\nSource: ${input.source}\n` +
        (input.batchLabels.length ? `Labels given at upload: ${input.batchLabels.join(', ')}\n` : '') +
        `Text (first ${MODEL_TEXT_CHARS} characters):\n"""\n${input.text.slice(0, MODEL_TEXT_CHARS)}\n"""`;
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model, stream: false, format: SCHEMA, keep_alive: '30m',
          options: { temperature: 0, num_predict: 80, num_ctx: 2048 },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { message?: { content?: string } };
      const raw = body.message?.content ?? '';
      const scores: Partial<Record<Ring, number>> = {};
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const r of RINGS) {
          const v = Number(parsed[r.slice(5)]);
          if (Number.isFinite(v)) scores[r] = Math.max(0, Math.min(1, v / 100));
        }
      } catch {
        return { scores: {}, raw, ms: Date.now() - t0 };
      }
      return { scores, raw, ms: Date.now() - t0 };
    },
  };
}

/** The configured model, or null (stub: rules only). */
export function defaultModel(): RingModel | null {
  const model = process.env.AGENT_DRIVE_RING_MODEL;
  if (!model) return null;
  return ollamaModel(model, process.env.AGENT_DRIVE_OLLAMA_URL ?? 'http://127.0.0.1:11434');
}
