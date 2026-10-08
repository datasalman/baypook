import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  base64url,
  generateReference,
  generateToken,
  isReference,
  REFERENCE_ALPHABET,
  type RandomSource,
} from "@/core/reference";

/** A predictable random source: fills with 0, 1, 2, ... */
function counting(start = 0): RandomSource {
  let n = start;
  return {
    getRandomValues<T extends Uint8Array>(arr: T): T {
      for (let i = 0; i < arr.length; i++) arr[i] = n++ & 255;
      return arr;
    },
  };
}

describe("booking references", () => {
  it("uses an unambiguous 32-symbol alphabet", () => {
    expect(REFERENCE_ALPHABET).toHaveLength(32);
    expect(new Set(REFERENCE_ALPHABET).size).toBe(32);
    for (const ch of "01IO") expect(REFERENCE_ALPHABET).not.toContain(ch);
  });

  it("is BP- plus five characters from the alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const ref = generateReference();
      expect(ref).toMatch(/^BP-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
      expect(isReference(ref)).toBe(true);
    }
  });

  it("is deterministic with an injected random source", () => {
    expect(generateReference(counting(0))).toBe("BP-23456");
    expect(generateReference(counting(32))).toBe("BP-23456"); // byte % 32
    expect(generateReference(counting(28))).toBe("BP-WXYZ2");
  });

  it("recognises bad references", () => {
    expect(isReference("BP-7K3M2")).toBe(true);
    expect(isReference("BP-7K3M")).toBe(false);
    expect(isReference("BP-7K3M0")).toBe(false);
    expect(isReference("bp-7k3m2")).toBe(false);
  });
});

describe("tokens", () => {
  it("are 32 random bytes in base64url (43 characters)", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it("encode exactly like Node's base64url", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = randomBytes(len);
      expect(base64url(new Uint8Array(bytes))).toBe(bytes.toString("base64url"));
    }
    expect(generateToken(counting(0))).toBe(Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url"));
  });
});
