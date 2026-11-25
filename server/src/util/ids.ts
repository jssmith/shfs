import { createHash, randomBytes } from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 (lowercase, no padding). */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** A random id with a prefix, e.g. `it_k3...`. Not secret. */
export function newId(prefix: string, bytes = 10): string {
  return `${prefix}_${base32(randomBytes(bytes))}`;
}

/** A secret token: prefix plus 26 base32 characters from 128 random bits. */
export function newSecret(prefix: string): string {
  const s = base32(randomBytes(16));
  return `${prefix}_${s}`;
}

/** The secret session id: `ds_` plus 26 base32 characters (128 random bits). */
export function newSessionId(): string {
  return newSecret('ds');
}

export const SESSION_ID_RE = /^ds_[a-z2-7]{26}$/;

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash for stored secrets (session ids, tokens). */
export function secretHash(secret: string): string {
  return sha256(`agent-drive:${secret}`);
}

export function now(): string {
  return new Date().toISOString();
}
