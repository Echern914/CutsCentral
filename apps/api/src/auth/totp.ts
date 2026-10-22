import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticator-app codes (TOTP, RFC 6238): HMAC-SHA1, 30-second steps, six
 * digits - what Google Authenticator, 1Password and every other app speak by
 * default. No dependency: the algorithm is a dozen lines, and an auth library
 * pulled in for it would be more code to trust than this.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A fresh secret: 20 random bytes (160 bits, the RFC's size), base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 30-second step an instant falls in. */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

/** The code for one step (HOTP over the step counter, RFC 4226 truncation). */
export function totpCode(secretB32: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Check a typed code: the current step, or one either side (a phone clock a
 * little out, or a code typed as it rolled over) - and never a step at or
 * before `lastStep`, so a code that worked once cannot be replayed by anyone
 * who saw it. Returns the step that matched, to be stored as the new lastStep.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  at: Date,
  lastStep: number | null,
): { ok: true; step: number } | { ok: false } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const now = totpStep(at);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secretB32, step));
    const given = Buffer.from(code);
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { ok: true, step };
  }
  return { ok: false };
}

/** The link an authenticator app reads from the setup QR code. */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
