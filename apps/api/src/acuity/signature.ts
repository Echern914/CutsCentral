import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an Acuity webhook signature: base64(HMAC-SHA256(rawBody, key)) compared
 * against the X-Acuity-Signature header, constant-time.
 *
 * [VERIFY LIVE] For OAuth dynamic webhooks the signing key is under-documented
 * (docs say "the account's API key", which OAuth apps don't hold). When no key
 * is available the per-shop unguessable URL path token is the primary
 * authenticator and this check is skipped (see the receiver).
 */
export function verifyAcuitySignature(
  rawBody: Buffer,
  header: string | undefined,
  key: string,
): boolean {
  if (!header) return false;
  const mac = createHmac("sha256", key).update(rawBody).digest("base64");
  const a = Buffer.from(mac);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
