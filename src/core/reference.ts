/**
 * Booking references and secret tokens.
 * Uses Web Crypto (`globalThis.crypto`, built into Node 20+ and browsers), so this
 * module is safe to import from client code through the `@/core` barrel.
 * The random source is injectable for tests.
 */

/** No 0/O, 1/I: easy to read out over the phone. 32 symbols, so byte % 32 is unbiased. */
export const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const REFERENCE_PREFIX = "BP-";
export const REFERENCE_LENGTH = 5;

export type RandomSource = { getRandomValues<T extends Uint8Array>(array: T): T };

function defaultRandom(): RandomSource {
  const c = (globalThis as { crypto?: RandomSource }).crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new Error("No secure random source available");
  return c;
}

export function generateReference(random: RandomSource = defaultRandom()): string {
  const bytes = random.getRandomValues(new Uint8Array(REFERENCE_LENGTH));
  let out = REFERENCE_PREFIX;
  for (const b of bytes) out += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length];
  return out;
}

export function isReference(s: string): boolean {
  return new RegExp(`^${REFERENCE_PREFIX}[${REFERENCE_ALPHABET}]{${REFERENCE_LENGTH}}$`).test(s);
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/** 32 random bytes as base64url (43 characters). */
export function generateToken(random: RandomSource = defaultRandom()): string {
  return base64url(random.getRandomValues(new Uint8Array(32)));
}
