import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The affiliate ATTRIBUTION CLAIM: the signed, tamper-evident value that
 * carries "this browser arrived through affiliate code X" from the referral
 * link to the moment a shop is created.
 *
 * Format is the house one (session.ts, auth/google.ts, auth/appleWeb.ts):
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, secret))
 *
 * 🔴 WHAT IS DELIBERATELY NOT IN THE PAYLOAD: no affiliate account id, no shop
 * id, no user id, no email, name or phone - nothing internal and nothing
 * personal. The only identifier is the PUBLIC referral code, which is the
 * value the visitor already had in their own URL bar, so the claim tells that
 * browser nothing it did not already know. Everything else (which account the
 * code belongs to, whether it is still eligible) is resolved server-side at
 * lock time, so the browser can never assign itself an affiliate.
 *
 * 🔴 PURPOSE-TAGGED, both directions. The payload carries
 * `purpose: "affiliate-attribution"`, which makes it unusable as a session
 * token (verifySession rejects any payload carrying `purpose`), and this
 * verifier requires that exact purpose, so a stolen session cookie cannot be
 * replayed as an attribution claim. That mutual rejection is what makes
 * sharing one secret between token types safe.
 *
 * KEY ROTATION: the payload names the key VERSION it was signed with, and
 * verification looks the secret up in a keyring. Adding a key means minting
 * under the new version while the old one still verifies; retiring a key means
 * dropping it from the keyring, after which its claims fail closed.
 */

/** Cookie name for the attribution claim. HttpOnly - never read by scripts. */
export const AFFILIATE_CLAIM_COOKIE = "cb_aff";

/** Attribution window: 60 days from capture. */
export const AFFILIATE_CLAIM_TTL_SECONDS = 60 * 24 * 60 * 60;

/** Payload tag. Anything without exactly this is not an attribution claim. */
export const AFFILIATE_CLAIM_PURPOSE = "affiliate-attribution";

/** The key version new claims are minted under. */
export const AFFILIATE_CLAIM_KEY_VERSION = 1;

/** How the visitor's claim was captured. */
export type AffiliateClaimSource = "link" | "explicit_code";

export interface AffiliateClaimPayload {
  purpose: typeof AFFILIATE_CLAIM_PURPOSE;
  /** Key version this claim was signed with. */
  k: number;
  /** The PUBLIC referral code. Never an internal id. */
  code: string;
  /** Capture source: followed a link, or typed the code in. */
  src: AffiliateClaimSource;
  /** Issued at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
}

/** version -> secret. Verification fails closed on an unknown version. */
export type AffiliateClaimKeyring = Record<number, string>;

/**
 * Codes are public identifiers minted by randomToken(9) (12 base64url chars).
 * The bound is deliberately loose so a future code shape still verifies, and
 * deliberately bounded so a hostile query string cannot push a novel-length
 * string through signing, storage and logging.
 */
const CODE_SHAPE = /^[A-Za-z0-9_-]{6,64}$/;

/** Longest raw claim we will even attempt to verify. */
const MAX_CLAIM_LENGTH = 512;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payloadB64).digest());
}

/**
 * Normalize a referral code as typed by a human: trim, drop an accidental
 * surrounding URL, and case-preserve (base64url is case-SIGNIFICANT, so
 * lowercasing would break real codes). Returns null when the value is not a
 * plausible code - callers must treat null as "no code", never as an error to
 * echo back.
 */
export function normalizeAffiliateCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return CODE_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * Mint a signed claim. `nowSeconds` is passed in rather than read from the
 * clock so tests can pin it and so the caller decides the instant that lands
 * in `capturedAt`.
 */
export function createAffiliateClaim(params: {
  code: string;
  source: AffiliateClaimSource;
  secret: string;
  nowSeconds: number;
  ttlSeconds?: number;
  keyVersion?: number;
}): string {
  const payload: AffiliateClaimPayload = {
    purpose: AFFILIATE_CLAIM_PURPOSE,
    k: params.keyVersion ?? AFFILIATE_CLAIM_KEY_VERSION,
    code: params.code,
    src: params.source,
    iat: params.nowSeconds,
    exp: params.nowSeconds + (params.ttlSeconds ?? AFFILIATE_CLAIM_TTL_SECONDS),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sign(payloadB64, params.secret)}`;
}

/**
 * Verify a claim. Returns the payload only when the signature matches a key in
 * the keyring, the purpose is exactly ours, the shape is right and the claim
 * has not expired. Never throws, whatever the input - this parses a value an
 * attacker fully controls.
 */
export function verifyAffiliateClaim(
  token: string | undefined | null,
  keyring: AffiliateClaimKeyring,
  nowSeconds: number,
  options?: {
    /**
     * Accept a genuinely-signed claim that has expired, so the caller can tell
     * "this browser really did arrive through a link, but too long ago" apart
     * from "this value was forged". The two get different durable outcomes: an
     * expired claim is recorded as a rejected attribution, a forged one is not
     * recorded at all. Callers MUST re-check `exp` themselves when they pass
     * this - it does not make an expired claim valid.
     */
    allowExpired?: boolean;
  },
): AffiliateClaimPayload | null {
  if (!token || token.length > MAX_CLAIM_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  // Decode BEFORE verifying only to learn which key version to check against;
  // nothing from this payload is trusted until the signature matches.
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const version = raw.k;
  if (typeof version !== "number" || !Number.isInteger(version)) return null;
  const secret = keyring[version];
  // Unknown (or retired) key version fails closed.
  if (typeof secret !== "string" || secret.length === 0) return null;

  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Signature is good; now the payload has to actually BE a claim.
  if (raw.purpose !== AFFILIATE_CLAIM_PURPOSE) return null;
  const code = normalizeAffiliateCode(raw.code);
  if (!code || code !== raw.code) return null;
  if (raw.src !== "link" && raw.src !== "explicit_code") return null;
  if (typeof raw.iat !== "number" || typeof raw.exp !== "number") return null;
  if (raw.exp <= nowSeconds && !options?.allowExpired) return null;
  // A claim that outlives the maximum window is not one of ours, whoever
  // signed it: the window is policy, not a suggestion.
  if (raw.exp - raw.iat > AFFILIATE_CLAIM_TTL_SECONDS) return null;

  return {
    purpose: AFFILIATE_CLAIM_PURPOSE,
    k: version,
    code,
    src: raw.src,
    iat: raw.iat,
    exp: raw.exp,
  };
}
