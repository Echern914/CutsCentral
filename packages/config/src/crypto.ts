import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (Acuity OAuth tokens).
 * Ciphertext format: "<ivB64>:<tagB64>:<ctB64>". The key is a base64-encoded
 * 32-byte value from TOKEN_ENCRYPTION_KEY.
 *
 * Keep this simple: one algorithm, one format. Tokens are never logged.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce, standard for GCM

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function encrypt(plaintext: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(payload: string, keyB64: string): string {
  const key = loadKey(keyB64);
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed ciphertext: expected 'iv:tag:ct'");
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Generate an unguessable URL-safe token (used for per-shop webhook secrets). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
