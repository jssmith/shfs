// Checksums used by the rule stage. Each takes the candidate as found in the
// text (spaces and dashes allowed) and says whether it is well formed.

export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Lengths per country (ISO 13616). Only countries listed are accepted.
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24,
  FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27, LI: 21, LT: 20,
  LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24,
  SM: 27, TR: 26,
};

export function ibanValid(candidate: string): boolean {
  const iban = candidate.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const len = IBAN_LENGTHS[iban.slice(0, 2)];
  if (len === undefined || iban.length !== len) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

export function abaRoutingValid(candidate: string): boolean {
  if (!/^\d{9}$/.test(candidate)) return false;
  const d = [...candidate].map(Number) as number[];
  const s = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return s % 10 === 0 && candidate !== '000000000';
}

/** US social security number: format plus the ranges the SSA never issues. */
export function ssnPlausible(candidate: string): boolean {
  const m = /^(\d{3})[- ]?(\d{2})[- ]?(\d{4})$/.exec(candidate);
  if (!m) return false;
  const [area, group, serial] = [m[1]!, m[2]!, m[3]!];
  if (area === '000' || area === '666' || area >= '900') return false;
  return group !== '00' && serial !== '0000';
}

/** ICAO 9303 check digit (weights 7, 3, 1; '<' counts 0). */
export function mrzCheckDigit(field: string): string {
  const weights = [7, 3, 1];
  let total = 0;
  for (let i = 0; i < field.length; i++) {
    const ch = field[i]!;
    let v = 0;
    if (ch >= '0' && ch <= '9') v = ch.charCodeAt(0) - 48;
    else if (ch >= 'A' && ch <= 'Z') v = ch.charCodeAt(0) - 55;
    total += v * weights[i % 3]!;
  }
  return String(total % 10);
}

/** NHS number (England): 10 digits, mod-11 check. */
export function nhsNumberValid(candidate: string): boolean {
  const digits = candidate.replace(/\s/g, '');
  if (!/^\d{10}$/.test(digits)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += (digits.charCodeAt(i) - 48) * (10 - i);
  let c = 11 - (s % 11);
  if (c === 11) c = 0;
  return c !== 10 && c === digits.charCodeAt(9) - 48;
}
