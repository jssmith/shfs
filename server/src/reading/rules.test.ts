import { describe, expect, test } from 'vitest';
import { decide, ringCheck } from './ring-check.js';
import { normaliseDigits, ruleSignals } from './rules.js';

// Everything here is invented. Numbers pass their checksums but belong to no one.

async function rings(text: string, name = 'file.txt') {
  return ringCheck({ text, name, mime: 'text/plain', source: 'upload', batchLabels: [] }, { model: null });
}

describe('credentials', () => {
  test('PEM private key', async () => {
    const r = await rings('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----');
    expect(r.rings).toEqual(['ring:credentials']);
  });

  test('API keys by prefix, also with OCR spacing', async () => {
    expect((await rings('GITHUB_TOKEN=ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')).rings).toContain('ring:credentials');
    expect((await rings('key: sk- proj -Abcdefghijklmnopqrstuvwxyz0123456789ABCD')).rings).toContain('ring:credentials');
    expect((await rings('MAPS_API_KEY=Alza' + 'SyD3abcdefghijklmnopqrstuvwxyz012345')).rings).toContain('ring:credentials');
  });

  test('recovery codes and password exports', async () => {
    const codes = ['Backup codes for Example', '', ...Array.from({ length: 8 }, (_, i) => `${i + 1}. k3x${i}a-9fq${i}z`)].join('\n');
    expect((await rings(codes)).rings).toEqual(['ring:credentials']);
    const csv = 'name,url,username,password,note\nmail.example.com,https://mail.example.com/,ana@example.com,Tq8!vLp2-xx,';
    expect((await rings(csv, 'export.csv')).rings).toEqual(['ring:credentials']);
  });

  test('a seed phrase of BIP39 words', async () => {
    const r = await rings('abandon ability able about above absent\nabsorb abstract absurd abuse access accident');
    expect(r.rings).toEqual(['ring:credentials']);
  });

  test('reasons never carry the secret itself', async () => {
    const secret = 'sk_live_' + 'Zx9Qw8Er7Ty6Ui5Op4As3Df2';
    const r = await rings(`STRIPE_SECRET_KEY=${secret}`);
    expect(r.rings).toContain('ring:credentials');
    expect(JSON.stringify(r.reasons)).not.toContain(secret.slice(8));
  });

  test('documented examples and placeholders are not credentials', async () => {
    expect((await rings('const aws = { accessKeyId: "AKIAIOSFODNN7EXAMPLE" } // AWS docs example')).rings).toEqual([]);
    expect((await rings('# export API_KEY=your-api-key-here\nAPI_KEY = os.environ.get("API_KEY", "<YOUR_API_KEY>")')).rings).toEqual([]);
    expect((await rings('Never type your recovery phrase into a website. Write it on paper and store it safely.')).rings).toEqual([]);
  });
});

describe('finance', () => {
  test('a Luhn-valid card number next to card words', async () => {
    expect((await rings('KESTREL BANK\n4539 1488 0343 6467\nVALID THRU 09/29\nANA EXAMPLE')).rings).toEqual(['ring:finance']);
  });

  test('a valid IBAN', async () => {
    const r = await rings('Beneficiary: Ana Example\nBeneficiary IBAN: GB82 WEST 1234 5698 7654 32\nAmount: EUR 120.00');
    expect(r.rings).toEqual(['ring:finance']);
  });

  test('statement keywords without numbers', async () => {
    const r = await rings('Monthly statement\nCredit limit: 5,000.00\nMinimum payment due: 25.00\nNew balance: 812.10\nTransactions');
    expect(r.rings).toEqual(['ring:finance']);
  });

  test('hard negatives: a recipe that mentions account and balance, a test card, an invoice number', async () => {
    const recipe = 'Banana bread\nTake into account that every oven differs.\nBalance the salt at the end.';
    expect((await rings(recipe)).rings).toEqual([]);
    expect((await rings('// Stripe test card\nconst TEST_CARD = "4242 4242 4242 4242";')).rings).toEqual([]);
    const r = await rings('INVOICE\nInvoice number: 4539 1488 0343 6467\nTotal due: 120.00');
    expect(r.rings).toEqual([]);
  });

  test('OCR digit confusions inside number groups are undone, words are left alone', () => {
    expect(normaliseDigits('4539 l488 O343 6467')).toBe('4539 1488 0343 6467');
    expect(normaliseDigits('ES64 BOOK SOLO')).toBe('ES64 BOOK SOLO');
  });
});

describe('identity', () => {
  test('a passport MRZ with valid check digits', async () => {
    const text = 'P<UTOEXAMPLE<<ANA<<<<<<<<<<<<<<<<<<<<<<<<<<<\nL898902C36UTO7408122F1204159<<<<<<<<<<<<<<02';
    const r = await rings(text);
    expect(r.rings).toEqual(['ring:identity']);
    expect(r.reasons.some((x) => x.detail.startsWith('mrz-checked'))).toBe(true);
  });

  test('an SSN with its label', async () => {
    expect((await rings("Employee's social security number: 123-45-6789")).rings).toContain('ring:identity');
  });

  test('an article about passports is at most uncertain', async () => {
    const r = await rings('How to renew your passport\nYour date of birth and place of birth must match your birth certificate.\nNationality questions go to the consulate.');
    expect(r.rings).toEqual([]);
  });
});

describe('health and intimate', () => {
  test('a referral letter', async () => {
    const r = await rings('Dear Dr Example,\nRe: Ana Example, DOB 01/02/1980, MRN 12345678\nThank you for seeing this patient with asthma.\nCurrent medication: salbutamol.');
    expect(r.rings).toEqual(['ring:health']);
  });

  test('a private letter', async () => {
    const r = await rings('My dearest Sam,\nI think I am falling for you completely.\nPlease keep this just between us.\nAll my love,\nAlex');
    expect(r.rings).toEqual(['ring:intimate']);
  });
});

describe('decide', () => {
  const base = { name: 'x', mime: 'text/plain', source: 'upload', batchLabels: [] };

  test('no readable text is uncertain', () => {
    expect(decide({ ...base, text: '  ' }, [], null).uncertain).toBe(true);
  });

  test('low OCR confidence with no ring is uncertain', () => {
    const text = 'some words that say nothing much at all';
    expect(decide({ ...base, text, extraction: { method: 'ocr', confidence: 0.2 } }, ruleSignals({ text, name: 'x' }), null).uncertain).toBe(true);
    expect(decide({ ...base, text, extraction: { method: 'ocr', confidence: 0.9 } }, ruleSignals({ text, name: 'x' }), null).uncertain).toBe(false);
  });

  test('the model only adds rings, and a middling score makes the item uncertain', () => {
    const text = 'a perfectly ordinary note about the garden';
    const add = decide({ ...base, text }, [], { scores: { 'ring:intimate': 0.9 }, ms: 1 });
    expect(add.rings).toEqual(['ring:intimate']);
    const unsure = decide({ ...base, text }, [], { scores: { 'ring:health': 0.7 }, ms: 1 });
    expect(unsure).toMatchObject({ rings: [], uncertain: true });
  });

  test('a model failure never clears an item', async () => {
    const failing = { name: 'broken', classify: async () => { throw new Error('down'); } };
    const r = await ringCheck({ ...base, text: 'a perfectly ordinary note about the garden' }, { model: failing });
    expect(r.uncertain).toBe(true);
  });
});
