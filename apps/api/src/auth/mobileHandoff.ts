import { createHash, timingSafeEqual } from "node:crypto";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { mintSessionToken } from "./session.js";

/**
 * Handing a browser-established session back to the native app.
 *
 * WHY THIS EXISTS. An invited barber has to create their ChairBack account on
 * the WEB: Google refuses OAuth inside an embedded WebView, and App Store
 * Guideline 3.1.1 keeps account creation out of the app shell. So the app opens
 * the system authentication browser (ASWebAuthenticationSession), the barber
 * signs up and accepts their invitation there, and something has to carry that
 * result back across the process boundary.
 *
 * WHAT WE REFUSE TO DO. Put the session in the callback URL. A redirect URL is
 * observable - it lands in the browser's history, in any custom-scheme handler
 * registered by another installed app, and in whatever the OS logs. So the
 * callback carries a CODE: a two-minute, single-use claim ticket that is
 * worthless to anyone but the app instance that started the flow.
 *
 * THREE INDEPENDENT BINDINGS make it worthless to everyone else:
 *  1. PKCE (RFC 7636). The app keeps a random verifier and sends only its
 *     sha256 up front; redeeming requires a preimage of that challenge, which a
 *     code thief does not have.
 *  2. STATE. The app generates a random state, we store its hash, and the
 *     redeem must present the same value - so a callback replayed into a
 *     different (or freshly started) flow does not pay out.
 *  3. SINGLE USE, atomically claimed. The first redeem wins; a second gets the
 *     same generic failure as a forged code.
 *
 * Everything is stored hashed, like PasswordResetToken: a database leak yields
 * nothing redeemable.
 */

/** Long enough to cross a browser dismissal, short enough to bound exposure. */
export const MOBILE_CODE_TTL_MS = 2 * 60 * 1000;

/**
 * What a code may be minted for.
 *
 * Two flows, differing only in WHEN the code is minted - both hand back the
 * same two-minute single-use ticket:
 *   - team_join: after an invited barber's seat exists;
 *   - new_shop:  after a new owner has signed up AND created their shop.
 *
 * `new_shop` waits for the shop deliberately. Handing the app a session for an
 * account with no shop would drop that owner into the shop-creation wizard
 * INSIDE the app shell - the business registration Guideline 3.1.1 keeps out of
 * it, and the reason this whole hand-off exists.
 */
export type MobileCodePurpose = "team_join" | "new_shop";

export class MobileHandoffError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** base64url, unpadded - the encoding RFC 7636 specifies for S256. */
function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Compare two hex digests without leaking, through timing, how much of a guess
 * was right. Length is checked first because timingSafeEqual throws on a
 * mismatch (and length alone is not a secret here).
 */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * RFC 7636 sizes the verifier at 43-128 characters from the unreserved set.
 * The challenge is a base64url sha256, so it is always exactly 43 characters -
 * but we accept the same 43-128 window rather than pinning 43, so a client that
 * pads or uses a different (still S256) encoding isn't silently rejected at the
 * wrong layer. Anything outside the character set is refused outright.
 */
const PKCE_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidPkceValue(value: string): boolean {
  return PKCE_SHAPE.test(value);
}

/** The app's state: our own randomToken() output, so base64url of any length. */
const STATE_SHAPE = /^[A-Za-z0-9_-]{22,256}$/;

export function isValidState(value: string): boolean {
  return STATE_SHAPE.test(value);
}

/**
 * Mint a code for an ALREADY-AUTHENTICATED user. The caller proves identity
 * with a session (the web server action forwards the barber's cookie); this
 * function never authenticates anyone itself.
 *
 * One live code per user: re-entering the flow supersedes any predecessor, so
 * an abandoned attempt can't linger as a second way in. Spent rows are left for
 * the audit trail and swept below.
 */
export async function issueMobileAuthCode(input: {
  userId: string;
  state: string;
  codeChallenge: string;
  purpose?: MobileCodePurpose;
}): Promise<{ code: string; expiresAt: Date }> {
  if (!isValidPkceValue(input.codeChallenge) || !isValidState(input.state)) {
    throw new MobileHandoffError("invalid_input", 400);
  }
  const code = randomToken(); // 32 random bytes, base64url
  const expiresAt = new Date(Date.now() + MOBILE_CODE_TTL_MS);

  await prisma.$transaction([
    prisma.mobileAuthCode.deleteMany({ where: { userId: input.userId, usedAt: null } }),
    prisma.mobileAuthCode.create({
      data: {
        userId: input.userId,
        codeHash: sha256Hex(code),
        codeChallenge: input.codeChallenge,
        stateHash: sha256Hex(input.state),
        purpose: input.purpose ?? "team_join",
        expiresAt,
      },
    }),
  ]);

  // Opportunistic sweep of everything long dead. Cheap (indexed on expiresAt)
  // and it keeps this table from growing forever without adding a cron job -
  // a new job would need its own job_lease seed row to ever run in production.
  await prisma.mobileAuthCode
    .deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } })
    .catch(() => undefined);

  return { code, expiresAt };
}

/**
 * Redeem a code for a session token.
 *
 * ORDER MATTERS: the code is CLAIMED (compare-and-set on usedAt) BEFORE the
 * PKCE and state checks. A wrong verifier therefore burns the code rather than
 * leaving it live for another guess - which is the behavior you want when the
 * only party who can present a wrong verifier is someone who stole the code.
 * The legitimate app always has the right verifier, so it never trips this.
 *
 * Every failure - unknown, expired, spent, wrong verifier, wrong state - is the
 * same generic error. The endpoint is unauthenticated, so it must not become an
 * oracle for which codes exist or how far a guess got.
 */
export async function redeemMobileAuthCode(input: {
  code: string;
  codeVerifier: string;
  state: string;
}): Promise<{
  token: string;
  user: { id: string; email: string; name: string };
}> {
  const invalid = new MobileHandoffError("invalid_or_expired", 400);
  if (!isValidPkceValue(input.codeVerifier) || !isValidState(input.state)) {
    throw invalid;
  }

  const row = await prisma.mobileAuthCode.findUnique({
    where: { codeHash: sha256Hex(input.code) },
  });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw invalid;
  }

  const claimed = await prisma.mobileAuthCode.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) throw invalid; // lost the race - someone else spent it

  if (!digestsEqual(sha256Base64Url(input.codeVerifier), row.codeChallenge)) {
    throw invalid;
  }
  if (!digestsEqual(sha256Hex(input.state), row.stateHash)) {
    throw invalid;
  }

  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { id: true, email: true, name: true, tokenVersion: true },
  });
  if (!user) throw invalid;

  return {
    token: mintSessionToken(user.id, user.tokenVersion),
    user: { id: user.id, email: user.email, name: user.name },
  };
}
