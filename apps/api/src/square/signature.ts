import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Square webhook signature.
 *
 * DIFFERS from Acuity (which HMACs the raw body alone): Square HMAC-SHA256s the
 * concatenation of the EXACT notification URL configured for the subscription +
 * the raw request body, keyed by the subscription's Signature Key, base64. The
 * header is `x-square-hmacsha256-signature`. Constant-time compare.
 *
 * The notification URL must byte-match what's configured in the Square Developer
 * Console (scheme, host, path, trailing slash) or every verification fails —
 * build it once from API_BASE_URL and pass it in.
 */
export function verifySquareSignature(
  rawBody: Buffer,
  header: string | undefined,
  signatureKey: string,
  notificationUrl: string,
): boolean {
  if (!header) return false;
  const mac = createHmac("sha256", signatureKey)
    .update(notificationUrl)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(mac);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
