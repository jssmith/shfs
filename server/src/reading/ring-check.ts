// The ring check (docs/contracts.md §3, security design §2): rules first, then
// the model, both only adding rings. Below the confidence threshold the item
// is `uncertain` and goes to the person; unreadable items always are.

import { defaultModel, type ModelOpinion, type RingModel } from './model.js';
import { RINGS, ruleSignals, type Ring, type Signal } from './rules.js';

export interface RingResult {
  rings: string[];
  uncertain: boolean;
  reasons: { ring: string; source: 'rule' | 'model'; detail: string }[];
}

export interface RingCheckInput {
  text: string;
  name: string;
  mime: string;
  source: string;
  batchLabels: string[];
  /** Optional, beyond the contract: how the text was read. Low OCR confidence makes an unplaced item uncertain. */
  extraction?: { method: 'plain' | 'text-layer' | 'ocr' | 'none'; confidence: number };
}

export interface RingCheckOptions {
  /** undefined: use the configured model (AGENT_DRIVE_RING_MODEL); null: rules only. */
  model?: RingModel | null;
  ruleAssign?: number; // rule score at or above which a ring is assigned
  ruleUncertain?: number; // rule score at or above which an unassigned ring makes the item uncertain
  modelAssign?: number;
  modelUncertain?: number;
  minOcrConfidence?: number;
  /** Receives the model's raw opinion (for measurement). */
  onModel?: (opinion: ModelOpinion | null) => void;
}

export const DEFAULTS = { ruleAssign: 0.7, ruleUncertain: 0.5, modelAssign: 0.8, modelUncertain: 0.6, minOcrConfidence: 0.45 };

/** Noisy-OR of the signals for each ring. */
export function ruleScores(signals: Signal[]): Record<Ring, number> {
  const out = Object.fromEntries(RINGS.map((r) => [r, 0])) as Record<Ring, number>;
  for (const r of RINGS) {
    let miss = 1;
    for (const s of signals) if (s.ring === r) miss *= 1 - s.score;
    out[r] = 1 - miss;
  }
  return out;
}

/** Combine rule signals and a model opinion into a result. Pure; used by ringCheck and by the measurement script. */
export function decide(input: RingCheckInput, signals: Signal[], opinion: ModelOpinion | null, o: Partial<typeof DEFAULTS> = {}): RingResult {
  const t = { ...DEFAULTS, ...o };
  const reasons: RingResult['reasons'] = [];
  const rings = new Set<Ring>();
  const unsure = new Set<Ring>();
  const scores = ruleScores(signals);
  for (const r of RINGS) {
    const mine = signals.filter((s) => s.ring === r).sort((a, b) => b.score - a.score);
    if (r === 'ring:credentials' ? mine.some((s) => s.score >= t.ruleAssign) : scores[r] >= t.ruleAssign) rings.add(r);
    else if (scores[r] >= t.ruleUncertain) unsure.add(r);
    for (const s of mine.slice(0, 3)) {
      if (s.score >= t.ruleUncertain || rings.has(r)) reasons.push({ ring: r, source: 'rule', detail: `${s.rule} (${s.score.toFixed(2)}): ${s.detail}` });
    }
  }
  if (opinion) {
    for (const r of RINGS) {
      const m = opinion.scores[r] ?? 0;
      if (m >= t.modelAssign) {
        if (!rings.has(r)) reasons.push({ ring: r, source: 'model', detail: `score ${m.toFixed(2)}` });
        rings.add(r);
        unsure.delete(r);
      } else if (m >= t.modelUncertain && !rings.has(r)) {
        unsure.add(r);
        reasons.push({ ring: r, source: 'model', detail: `uncertain, score ${m.toFixed(2)}` });
      }
    }
  }
  const readable = input.text.replace(/\s/g, '').length >= 15 && input.extraction?.method !== 'none';
  const lowOcr = input.extraction?.method === 'ocr' && input.extraction.confidence < t.minOcrConfidence;
  let uncertain = false;
  if (!readable) {
    uncertain = true;
    reasons.push({ ring: 'unknown', source: 'rule', detail: 'no readable text' });
  } else if (rings.size === 0 && unsure.size > 0) {
    uncertain = true;
  } else if (unsure.has('ring:credentials')) {
    uncertain = true; // credentials are never released, so a possible credential always goes to the person
  } else if (rings.size === 0 && lowOcr) {
    uncertain = true;
    reasons.push({ ring: 'unknown', source: 'rule', detail: `low OCR confidence ${input.extraction!.confidence.toFixed(2)}` });
  }
  return { rings: RINGS.filter((r) => rings.has(r)), uncertain, reasons };
}

export async function ringCheck(input: RingCheckInput, options: RingCheckOptions = {}): Promise<RingResult> {
  const signals = ruleSignals({ text: input.text, name: input.name });
  const model = options.model === undefined ? defaultModel() : options.model;
  let opinion: ModelOpinion | null = null;
  if (model && input.text.trim()) {
    try {
      opinion = await model.classify(input);
    } catch (e) {
      // A model failure never clears an item: treat it as uncertain unless rules placed it.
      const r = decide(input, signals, null, options);
      return { ...r, uncertain: r.uncertain || r.rings.length === 0, reasons: [...r.reasons, { ring: 'unknown', source: 'model', detail: `model failed: ${(e as Error).message.slice(0, 80)}` }] };
    }
  }
  options.onModel?.(opinion);
  return decide(input, signals, opinion, options);
}
