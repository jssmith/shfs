// The rule stage of the ring check (security design §2): high-precision
// patterns, with checksums where they exist. Each rule emits signals with a
// score in 0..1; ringCheck combines them. Rules only ever add rings.

import { readFileSync } from 'node:fs';
import { abaRoutingValid, ibanValid, luhnValid, mrzCheckDigit, nhsNumberValid, ssnPlausible } from './checksums.js';

export type Ring = 'ring:credentials' | 'ring:finance' | 'ring:identity' | 'ring:health' | 'ring:intimate';
export const RINGS: Ring[] = ['ring:credentials', 'ring:finance', 'ring:identity', 'ring:health', 'ring:intimate'];

export interface Signal {
  ring: Ring;
  score: number;
  rule: string;
  detail: string;
}

// BIP39 English word list (from the BIP39 specification), for seed phrases.
const BIP39 = new Set(
  // Resolves to server/src/reading/data from both src/ and dist/.
  readFileSync(new URL('../../src/reading/data/bip39-english.txt', import.meta.url), 'utf8')
    .split('\n').map((w) => w.trim()).filter(Boolean),
);

// Documented test values that are not anyone's secrets.
const TEST_CARDS = new Set(['4242424242424242', '4111111111111111', '5555555555554444', '378282246310005',
  '4000056655665556', '5105105105105100', '6011111111111117', '4012888888881881']);
const PLACEHOLDER = /example|your[-_ ]?|xxxx|<[^>]*>|\*{3,}|changeme|placeholder|redacted|dummy|sample|getpass|os\.environ|process\.env|\$\{|^\$|^(null|none|true|false|undefined)$|_hash$/i;

/** Mask a found value so reasons never carry the secret itself. */
export function mask(v: string): string {
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${'*'.repeat(Math.min(6, s.length - 6))}${s.slice(-2)}`;
}

/** Undo common OCR confusions inside runs that are mostly digits. */
export function normaliseDigits(text: string): string {
  return text.replace(/[0-9OoIlSB|][0-9OoIlSB| -]{10,}[0-9OoIlSB|]/g, (run) => {
    const digits = (run.match(/\d/g) ?? []).length;
    const letters = (run.match(/[OoIlSB|]/g) ?? []).length;
    if (digits < 10 || letters > 3) return run;
    return run.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  });
}

function near(text: string, index: number, re: RegExp, radius = 120): boolean {
  return re.test(text.slice(Math.max(0, index - radius), index + radius));
}

/** Map a weighted count of distinct keywords to a score. */
function bagScore(n: number): number {
  if (n >= 4) return 0.92;
  if (n >= 3) return 0.85;
  if (n >= 2.5) return 0.72;
  if (n >= 2) return 0.6;
  if (n >= 1.5) return 0.45;
  if (n >= 1) return 0.3;
  return 0;
}

function keywordBag(text: string, ring: Ring, rule: string, strong: RegExp[], weak: RegExp[]): Signal | null {
  const hits: string[] = [];
  let n = 0;
  for (const re of strong) {
    const m = re.exec(text);
    if (m) { n += 1; hits.push(m[0].toLowerCase()); }
  }
  for (const re of weak) {
    const m = re.exec(text);
    if (m) { n += 0.5; hits.push(m[0].toLowerCase()); }
  }
  const score = bagScore(n);
  return score > 0 ? { ring, score, rule, detail: `keywords: ${hits.slice(0, 6).join(', ')}` } : null;
}

// ------------------------------------------------------------ credentials

const KEY_PATTERNS: [string, RegExp][] = [
  ['pem-private-key', /BEGIN\s+[A-Z0-9 ]{0,24}PR[I1l]VATE\s+KEY/i],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['aws-secret-key', /aws.?secret.?access.?key\W{1,4}[A-Za-z0-9/+]{40}/i],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['stripe-live-key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['sk-api-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['google-api-key', /\bA[Il1]za[0-9A-Za-z_-]{30,}/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['sendgrid-key', /\bSG\.[\w-]{16,}\.[\w-]{16,}/],
  ['twilio-sid', /\bAC[0-9a-f]{32}\b/],
  ['jwt', /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/],
  ['otpauth-uri', /otpauth:\/\/[th]otp\//i],
  ['kubeconfig-secret', /client-key-data:\s*\S{20,}|\btoken:\s*[A-Za-z0-9._-]{30,}/],
];

const ASSIGNMENT = /(?<![A-Za-z])(pass(?:word|wd|phrase)?|pw|pwd|secret|token|api[_ -]?key|auth[_ -]?token|access[_ -]?key|client[_ -]?secret|private[_ -]?key|pin)(?![A-Za-z])["']?\s*[:=]\s*["']?([^\s"',;]{6,})/gi;

function credentialSignals(text: string, name: string): Signal[] {
  const out: Signal[] = [];
  for (const [rule, re] of KEY_PATTERNS) {
    const m = re.exec(text);
    if (m && !/EXAMPLE/.test(m[0])) out.push({ ring: 'ring:credentials', score: 0.97, rule, detail: mask(m[0]) });
  }
  // key = value assignments with a real-looking value
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[2]!;
    if (PLACEHOLDER.test(value) || /^[a-z_]+\(/.test(value) || /^[a-z]+$/.test(value)) continue;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
    if (classes >= 2 || value.length >= 16) {
      out.push({ ring: 'ring:credentials', score: 0.9, rule: 'secret-assignment', detail: `${m[1]}=${mask(value)}` });
      break;
    }
  }
  // password-manager export: a CSV header naming password and user columns
  const header = text.split('\n', 3).find((l) => /password/i.test(l) && /user|login/i.test(l) && /,/.test(l));
  if (header) out.push({ ring: 'ring:credentials', score: 0.97, rule: 'password-export', detail: header.slice(0, 60) });
  // recovery or backup codes
  const codeLines = text.split('\n').filter((l) => /^\s*(?:\d{1,2}[.)]\s*)?(?:[A-Za-z0-9]{4,5}[- ][A-Za-z0-9]{4,5}|\d{8}|\d{4} \d{4})\s*$/.test(l)).length;
  const codeWords = /(recovery|backup|emergency|2fa|two[- ]factor|one[- ]time)\s+(codes?|keys?)|save these codes|each code can be used once/i.exec(text);
  if (codeWords && codeLines >= 4) out.push({ ring: 'ring:credentials', score: 0.97, rule: 'recovery-codes', detail: `${codeWords[0]}; ${codeLines} codes` });
  else if (codeWords && /\b[A-Za-z0-9]{4,5}-[A-Za-z0-9]{4,5}\b|\b\d{8}\b/.test(text)) out.push({ ring: 'ring:credentials', score: 0.8, rule: 'recovery-codes', detail: codeWords[0] });
  else if (codeLines >= 6) out.push({ ring: 'ring:credentials', score: 0.75, rule: 'code-list', detail: `${codeLines} code-like lines` });
  // seed phrases: 12+ BIP39 words in a row, tolerating OCR damage
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  let best = 0;
  for (let i = 0; i + 12 <= words.length; i++) {
    let hits = 0;
    for (let j = i; j < i + 12; j++) if (BIP39.has(words[j]!)) hits++;
    best = Math.max(best, hits);
    if (best === 12) break;
  }
  const seedWords = /seed|recovery phrase|mnemonic|wallet|secret phrase|backup/i.test(text + ' ' + name);
  if (best >= 11 || (best >= 9 && seedWords)) out.push({ ring: 'ring:credentials', score: 0.95, rule: 'seed-phrase', detail: `${best}/12 BIP39 words in a row` });
  else if (best >= 9) out.push({ ring: 'ring:credentials', score: 0.6, rule: 'seed-phrase-weak', detail: `${best}/12 BIP39 words in a row` });
  const b64Lines = text.split('\n').filter((l) => /^[A-Za-z0-9+\/=]{40,}$/.test(l.replace(/\s/g, '')) && /[a-z]/.test(l) && /[A-Z]/.test(l) && /\d/.test(l)).length;
  if (b64Lines >= 4) out.push({ ring: 'ring:credentials', score: 0.75, rule: 'key-material', detail: `${b64Lines} lines of base64` });
  // TOTP setup key: base32, 16+ characters, near a keyword
  const totp = /(setup|secret|authenticator|2fa|totp)\s+key\W{0,3}((?:[A-Z2-7]{4}\s?){4,})/i.exec(text);
  if (totp) out.push({ ring: 'ring:credentials', score: 0.95, rule: 'totp-secret', detail: mask(totp[2]!) });
  // a list of "site: password" lines under a passwords heading
  const listLines = text.split('\n').filter((l) => {
    if (!/^[\w .@-]{2,40}(?:[:\-]\s+|\s+pw:\s*)\S{6,}\s*$/.test(l.trim())) return false;
    const v = l.trim().split(/:\s+|pw:\s*|\s-\s/).pop() ?? '';
    return /[A-Za-z]/.test(v) && /\d|[^\w\s]/.test(v) && !/^[\d,.$€£%-]+$/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v);
  }).length;
  const listHeading = /^\s*(passwords?|logins?|accounts|credentials)\b/im.test(text) || /\bpw:/i.test(text);
  if (listLines >= 3 && listHeading) out.push({ ring: 'ring:credentials', score: 0.92, rule: 'password-list', detail: `${listLines} entries` });
  else if (listLines >= 4) out.push({ ring: 'ring:credentials', score: 0.55, rule: 'password-list-weak', detail: `${listLines} entries` });
  // file names
  const nm = /(^|[\/_.-])(id_rsa|id_ed25519|id_ecdsa|\.env|kubeconfig|credentials|secrets?|passwords?|recovery|backup[-_ ]codes|seed|wallet|2fa|totp|vault)([\/_.-]|$)|\.(pem|key|p12|pfx|kdbx)$/i.exec(name);
  if (nm) out.push({ ring: 'ring:credentials', score: 0.45, rule: 'file-name', detail: nm[0] });
  return out;
}

// ------------------------------------------------------------ finance

const CARD_CONTEXT = /card|visa|master|amex|american express|discover|valid\s*thru|valid\s*from|expir|exp\b|cvv|credit|debit/i;

function financeSignals(text: string, norm: string): Signal[] {
  const out: Signal[] = [];
  // card numbers (Luhn), with context
  for (const m of norm.matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![ -]?\d)/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (!/^[3-6]/.test(digits) || TEST_CARDS.has(digits) || !luhnValid(digits)) continue;
    const ctx = near(norm, m.index!, CARD_CONTEXT);
    out.push({ ring: 'ring:finance', score: ctx ? 0.96 : 0.45, rule: ctx ? 'card-number' : 'card-number-no-context', detail: mask(digits) });
    if (ctx) break;
  }
  // IBAN (mod-97)
  for (const m of norm.toUpperCase().matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}/g)) {
    const parts = m[0].split(' ');
    for (let k = parts.length; k >= 3; k--) {
      const cand = parts.slice(0, k).join('');
      if (ibanValid(cand)) {
        out.push({ ring: 'ring:finance', score: 0.97, rule: 'iban', detail: mask(cand) });
        break;
      }
    }
  }
  // US routing number next to the word
  for (const m of norm.matchAll(/\b\d{9}\b/g)) {
    if (abaRoutingValid(m[0]) && near(norm, m.index!, /routing|ABA|RTN/i, 60)) {
      out.push({ ring: 'ring:finance', score: 0.95, rule: 'aba-routing', detail: mask(m[0]) });
      break;
    }
  }
  // account numbers after the words
  const acct = /\b(account|acct|a\/c|portfolio|mortgage account)\s*(?:number|no\.?|#)?\s*[:.]?\s*([A-Z]{0,3}-?\d[\d -]{5,16}\d)\b/i.exec(norm);
  if (acct) out.push({ ring: 'ring:finance', score: 0.85, rule: 'account-number', detail: `${acct[1]} ${mask(acct[2]!)}` });
  // cheque MICR line: transit and account fields
  if (/[CA⑆⑈]\d{9}[A⑆]\s*\d{6,}/.test(norm)) out.push({ ring: 'ring:finance', score: 0.85, rule: 'micr', detail: 'cheque MICR line' });
  const bag = keywordBag(text, 'ring:finance', 'finance-keywords', [
    /statement period/i, /opening balance/i, /closing balance|new balance|available balance|outstanding balance/i,
    /minimum payment/i, /credit limit/i, /portfolio (value|statement)|market value/i, /dividends?/i, /realised gains|capital gains/i,
    /wages,? tips/i, /federal income tax|income tax withheld|income tax\b/i, /employer identification|\bEIN\b/, /social security wages|medicare (tax|wages)/i, /\bnet pay\b/i, /\bgross pay\b/i, /payslip|pay slip|pay date/i, /pension contribution|national insurance\b|\bFICA\b/i, /mortgage|repayment/i,
    /beneficiary/i, /\bIBAN\b/, /\bBIC\b|SWIFT/, /sort code/i, /routing number/i, /account (number|no)/i, /pay(\s+to the order of)?\s.{0,40}the sum of|the sum of/i,
    /tax year|form 1099|W-2\b/i, /brokerage|securities/i, /transactions?/i,
  ], [/\bAPR\b|interest rate/i, /\bbalance\b/i, /bank\b/i, /statement/i]);
  if (bag) out.push(bag);
  return out;
}

// ------------------------------------------------------------ identity

function identitySignals(text: string, norm: string): Signal[] {
  const out: Signal[] = [];
  // machine-readable zone
  const mrzLines = text.split('\n').map((l) => l.replace(/\s/g, '').replace(/[«‹]/g, '<')).filter((l) => /^[A-Z0-9<]{28,46}$/.test(l) && (l.match(/</g) ?? []).length >= 3);
  if (mrzLines.length >= 1) {
    let checked = false;
    for (const l of mrzLines) {
      // TD3 line 2: document number (9) + check digit
      if (/^[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}\d/.test(l) && mrzCheckDigit(l.slice(0, 9)) === l[9] && mrzCheckDigit(l.slice(13, 19)) === l[19]) checked = true;
      // TD1 line 1: I/A/C, country, document number + check digit
      if (/^[IAC][A-Z<][A-Z<]{3}[A-Z0-9<]{9}\d/.test(l) && mrzCheckDigit(l.slice(5, 14)) === l[14]) checked = true;
    }
    const passportLine = mrzLines.some((l) => /^P[A-Z<][A-Z<]{3}[A-Z]/.test(l));
    out.push({ ring: 'ring:identity', score: checked ? 0.98 : passportLine || mrzLines.length >= 2 ? 0.92 : 0.6, rule: checked ? 'mrz-checked' : 'mrz', detail: `${mrzLines.length} MRZ line(s)` });
  }
  // SSN
  for (const m of norm.matchAll(/(?<![\d-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\d-])/g)) {
    if (!ssnPlausible(m[0])) continue;
    const ctx = near(norm, m.index!, /social security|\bSSN\b|\bSS\s?(No|#)|taxpayer/i, 150);
    if (ctx || m[2] === '-') {
      out.push({ ring: 'ring:identity', score: ctx ? 0.96 : 0.72, rule: ctx ? 'ssn' : 'ssn-format', detail: mask(m[0]) });
      break;
    }
  }
  // UK National Insurance number
  const ni = /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/.exec(norm);
  if (ni) {
    const ctx = near(norm, ni.index, /national insurance|\bNI\b|\bNINO\b/i, 80);
    out.push({ ring: 'ring:identity', score: ctx ? 0.95 : 0.55, rule: 'ni-number', detail: mask(ni[0]) });
  }
  // a document number next to an identity document word
  const idNum = /\b(passport\s*(no\.?|number|#)|document\s*(no\.?|number)|permit\s*(no\.?|number)|licen[cs]e\s*(no\.?|number)|\bDL\b|certificate\s*no\.?)\s*[:#]?\s*([A-Z]{0,3}\s?[A-Z0-9]?\d{5,9}[A-Z0-9]?)\b/i.exec(norm);
  if (idNum) {
    const doc = /passport|identity card|driver|licen[cs]e|residence permit|birth|national id|visa/i.test(text);
    out.push({ ring: 'ring:identity', score: doc ? 0.93 : 0.6, rule: 'id-document-number', detail: `${idNum[1]} ${mask(idNum[6] ?? '')}` });
  }
  const bag = keywordBag(text, 'ring:identity', 'identity-keywords', [
    /\bpassport\b/i, /identity card|national id/i, /driver'?s? licen[cs]e/i, /social security/i, /residence permit/i,
    /birth certificate|entry of birth/i, /nationality/i, /place of birth/i, /date of expiry|\bEXP\b/i, /given names?/i,
    /\bsurname\b|\bLN\b/, /verification|identity check|document checked/i,
  ], [/date of birth|\bDOB\b/i, /\bsex\b|\bheight\b|\bHGT\b|\beyes\b/i]);
  // Words alone (an article about passports) are not an identity document: at most uncertain.
  if (bag) out.push({ ...bag, score: Math.min(bag.score, 0.65) });
  // Field structure: "Surname: X", "Nationality: Y", "Date of birth: 01.02.1980" as labelled lines.
  const fields = [
    /\b(surname|last name|LN)\b\s*:?\s+[A-Z][A-Za-z'-]+/, /\b(given names?|first name|FN)\b\s*:?\s+[A-Z][A-Za-z'-]+/,
    /\bnationality\s*:?\s+[A-Z][A-Za-z ]+/i, /\bsex\s*:?\s+[MFX]\b/i, /\bplace of birth\s*:?\s+[A-Z]/i,
    /\b(date of birth|DOB)\s*:?\s+\d{1,2}[./ -]\d{1,2}[./ -]\d{2,4}/i, /\b(date of expiry|expiry|EXP|valid until)\s*:?\s+\d{1,2}[./ -]\d{1,2}[./ -]\d{2,4}/i,
    /\b(HGT|height|eyes)\s*:?\s+\S+/i, /\b(mother|father)\s*:\s+[A-Z]/i,
  ].filter((re) => re.test(text)).length;
  if (fields >= 3) out.push({ ring: 'ring:identity', score: fields >= 4 ? 0.88 : 0.75, rule: 'identity-fields', detail: `${fields} labelled identity fields` });
  return out;
}

// ------------------------------------------------------------ health

function healthSignals(text: string, norm: string): Signal[] {
  const out: Signal[] = [];
  for (const m of norm.matchAll(/\b\d{3}\s?\d{3}\s?\d{4}\b/g)) {
    if (nhsNumberValid(m[0]) && near(norm, m.index!, /\bNHS\b/, 40)) {
      out.push({ ring: 'ring:health', score: 0.96, rule: 'nhs-number', detail: mask(m[0]) });
      break;
    }
  }
  const mrn = /\b(MRN|medical record (number|no))\s*[:#]?\s*\d{6,10}\b/i.exec(norm);
  if (mrn) out.push({ ring: 'ring:health', score: 0.93, rule: 'mrn', detail: mrn[1]! });
  const icd = /\b[A-TV-Z]\d{2}\.\d{1,3}\b/.exec(norm);
  if (icd && /diagnos|icd/i.test(text)) out.push({ ring: 'ring:health', score: 0.9, rule: 'icd10', detail: icd[0] });
  const bag = keywordBag(text, 'ring:health', 'health-keywords', [
    /\bpatient\b/i, /diagnos[ie]s/i, /prescri(ption|bed|ber)|\bRx\b/i, /discharge(d)?\b/i, /referr(al|ing)/i,
    /laboratory|reference range|haemoglobin|hemoglobin|HbA1c|ferritin|cholesterol/i, /PHQ-9/i, /GAD-7/i, /\bCBT\b|cognitive|behavioural activation|behavioral activation/i, /suicidal|self-harm/i, /session notes|presenting:|low mood/i,
    /explanation of benefits|member id/i, /fit for work|fitness for work/i, /immuni[sz]ation|vaccination record/i,
    /\bmedication\b/i, /blood pressure/i, /dear dr\b/i, /\bsymptoms?\b/i,
  ], [/\b\d+\s?(mg|mcg|ml)\b/i, /\bdoctor\b|\bdr\.? /i, /hospital|clinic|practice|centre/i, /vaccin/i, /therapy|counsel/i, /treatment/i]);
  if (bag) out.push(bag);
  return out;
}

// ------------------------------------------------------------ intimate

function intimateSignals(text: string): Signal[] {
  const bag = keywordBag(text, 'ring:intimate', 'intimate-keywords', [
    /\bmy (love|dearest|darling)\b|\bdarling\b/i, /all my love|forever yours|yours,? always/i, /falling for you|in love with|i love you/i,
    /\baffair\b|sex life|attractive/i, /couples? counsell?ing|our counsellor|separation|moved out/i, /\bi am gay\b|came out/i,
    /nobody else knows|just between us|not telling anyone/i, /dear diary|private\.?$/im, /\bmiss (you|the weight|being close)/i,
  ], [/\blove\b/i, /cried|tears|shaking/i, /lonely|guilty|relieved|scared/i, /\bforgive\b/i, /\bdate with\b/i, /hand in mine|held me/i]);
  return bag ? [bag] : [];
}

export function ruleSignals(input: { text: string; name: string }): Signal[] {
  const text = input.text;
  const norm = normaliseDigits(text);
  return [
    ...credentialSignals(text, input.name),
    ...financeSignals(text, norm),
    ...identitySignals(text, norm),
    ...healthSignals(text, norm),
    ...intimateSignals(text),
  ];
}
