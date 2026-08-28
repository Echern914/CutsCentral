import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/**
 * THE six-digit-OTP policy: one implementation of the rules every phone
 * verification in the product lives by, wherever its rows happen to live.
 *
 * Two stores use it today - the walk-in kiosk's shop-scoped challenge table
 * (WalkInPhoneCode, engines/walkInVerify.ts) and the platform-scoped rewards
 * recovery store (PhoneRecoveryCode, services/rewardsRecovery.ts). They are the
 * SAME credential with different scope keys, and this module is what makes
 * that true rather than aspirational: the TTLs, the attempt cap, the cooldown,
 * the digest construction, the comparison discipline and the code alphabet are
 * defined once, so the two flows cannot drift apart one constant at a time.
 *
 * The persistence deliberately stays separate. The kiosk table's
 * @@unique([shopId, phone]) with a NON-NULL shopId is what makes "one active
 * challenge per shop+phone" a database fact; recovery has no shop at challenge
 * time, and a nullable shopId would quietly break that invariant (Postgres
 * treats NULLs as distinct, so the unique index stops collapsing rows and the
 * cooldown and attempt cap stop holding). Two tables, one policy.
 *
 * 🔴 THE PURPOSE IS PART OF THE DIGEST. hashOtp folds `purpose` between the
 * scope key and the code, so a code minted for one flow verifies NOWHERE else -
 * a kiosk check-in code cannot redeem as rewards recovery and vice versa, even
 * for the same phone at the same instant, even if a future bug ever pointed
 * both flows at one table. Cross-purpose refusal is arithmetic, not a lookup.
 */

/** How long a minted code stays redeemable. */
export const CODE_TTL_MS = 5 * 60 * 1000;
/** Wrong guesses before the challenge locks (until re-issued). */
export const MAX_ATTEMPTS = 5;
/** Minimum gap between sends to one phone. */
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** Sends allowed per phone per rolling window (tracked on the row). */
export const MAX_SENDS_PER_WINDOW = 5;
export const SEND_WINDOW_MS = 60 * 60 * 1000;
/** How long a successful verification's proof stays spendable. */
export const PROOF_TTL_MS = 10 * 60 * 1000;
/** Rows whose challenge expired this long ago are swept on the next
 * challenge - the explicit inline cleanup that replaces a cron. */
export const CLEANUP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Every OTP purpose in the product. Adding one here is the whole registry. */
export type OtpPurpose = "walk_in_check_in" | "rewards_recovery";

export function sha256Hex(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/**
 * The scope-bound digest: scopeKey + phone + purpose folded in with the code.
 *
 * `scopeKey` is whatever pins the challenge to its context - the shopId for a
 * kiosk, the purpose-wide store key for recovery. Argument order is load-
 * bearing for the kiosk: `${shopId}:${phone}:walk_in_check_in:${code}` is the
 * digest already at rest in production rows, and this function reproduces it
 * byte-for-byte.
 */
export function hashOtp(
  scopeKey: string,
  phone: string,
  purpose: OtpPurpose,
  code: string,
): string {
  return sha256Hex(`${scopeKey}:${phone}:${purpose}:${code}`);
}

/** Uniform six digits from the CSPRNG (never Math.random). */
export function mintCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Shape gate: a non-six-digit string costs a regex, not a query. */
export function codeShapeOk(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Shape gate for opaque proofs, before any lookup. */
export function proofShapeOk(proof: string): boolean {
  return proof.length >= 20 && proof.length <= 512;
}

/**
 * Constant-time comparison of two hex digests. (The hash-lookup pattern makes
 * timing moot for the DB read; this covers the comparison itself.)
 */
export function digestsMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
