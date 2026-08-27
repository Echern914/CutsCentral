import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma, type McpAccessLevel, type Prisma } from "@chairback/db";

/**
 * The prisma client OR an interactive-transaction client. Every write helper
 * below takes one, so a caller that needs several writes to be atomic can hand
 * its transaction down instead of the helper opening a second one.
 */
type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * The MCP token store: mint, resolve, rotate, revoke.
 *
 * THE WHOLE LIFECYCLE LIVES IN THIS FILE. Nothing else in the codebase creates
 * or validates an MCP token, so there is exactly one place to audit.
 *
 * ── The invariants, stated up front ──────────────────────────────────────────
 *
 *  1. A token's plaintext exists in exactly two places: the HTTP response that
 *     minted it, and the client's memory. It is never stored, never logged and
 *     never returned again. The database holds `sha256(token)`.
 *
 *  2. An authorization code is single-use. A second VALIDATED presentation is
 *     treated as theft (the OAuth 2.1 rule), not as a retry: the code's
 *     connection is revoked and every token descended from it dies.
 *
 *     🔴 VALIDATED is load-bearing. The code is only consumed - and replay is
 *     only declared - AFTER the client, redirect_uri, resource and PKCE verifier
 *     have all checked out. Consuming first would let anyone who merely SAW the
 *     code destroy a barber's in-flight authorization without ever proving
 *     possession of the verifier, which is a denial-of-service handed out for
 *     free. The single-use guarantee still comes from the database (a
 *     compare-and-set on `consumedAt: null`), so validating first costs nothing:
 *     a concurrent second redemption loses the CAS and is treated as the replay
 *     it is.
 *
 *  3. A refresh token is single-use too, and rotation is mandatory. Every token
 *     descended from one authorization shares a `tokenFamily`; presenting an
 *     already-rotated member proves a copy leaked, so the whole family is
 *     revoked. This is the standard refresh-token-replay defence and it is the
 *     reason `rotatedAt` is a distinct column from `revokedAt`.
 *
 *  4. Authorization is re-derived on EVERY request. A resolved token gives us a
 *     connection; the connection gives us a claimed user and shop; the claim is
 *     then re-checked against live membership. A seat removed a second ago
 *     stops working now, not when the access token expires.
 *
 *  5. Nothing the client sends is trusted as identity. `shopId`, `userId` and
 *     role never come off the wire - they come off the resolved connection.
 *
 * ── Why opaque tokens rather than JWTs ───────────────────────────────────────
 *
 * A JWT would let us skip the database read, and would also make invariants 3
 * and 4 impossible to honour: a signed token stays valid until it expires
 * whatever the database says. "Revocation is immediate" and "losing your seat
 * cuts access immediately" are hard requirements here, so the read is the point,
 * not an overhead to optimise away.
 */

/* ─────────────────────────── lifetimes ─────────────────────────── */

/**
 * Short on purpose. The access token is the credential that travels on every
 * request, so it is the one most likely to be captured; 15 minutes bounds the
 * damage without making refresh chatty.
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * A month. Long enough that a barber does not re-authorize constantly, short
 * enough that an abandoned connection dies on its own. Rotation means a
 * captured refresh token is only useful until the legitimate client next
 * refreshes - at which point the theft is DETECTED, not merely outlived.
 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Sixty seconds. The code is exchanged immediately by a machine; anything
 * longer is a window for a code leaked through a redirect chain, a browser
 * history entry or a referrer header.
 */
export const AUTH_CODE_TTL_MS = 60 * 1000;

/** 256 bits of CSPRNG. base64url so it survives headers, URLs and JSON intact. */
const TOKEN_BYTES = 32;

/* ─────────────────────────── primitives ─────────────────────────── */

/**
 * Hash a token for storage/lookup.
 *
 * SHA-256, deliberately, and NOT argon2 (which User.passwordHash uses): these
 * are 256-bit random values, so there is no dictionary to attack and no work
 * factor worth paying on every API call. A slow KDF here would be a
 * self-inflicted rate limit on the hot path. Passwords stay on argon2id
 * precisely because they are low-entropy and guessable.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new unguessable token. The only place MCP secrets are born. */
export function mintSecret(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Constant-time string comparison, for the few places a secret is compared
 * without going through a hash lookup (the PKCE challenge).
 *
 * Length is compared first and NOT in constant time, which is fine: the length
 * of a PKCE challenge is public (43 characters for S256).
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * The PKCE S256 transform (RFC 7636 §4.6): BASE64URL(SHA256(ASCII(verifier))).
 *
 * 🔴 `plain` is NOT implemented and must never be. OAuth 2.1 removed it, and a
 * plain challenge is not a proof of anything - whoever intercepted the redirect
 * has the verifier too.
 */
export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * RFC 7636 §4.1: the verifier is 43-128 characters from an unreserved set.
 * Enforced because a short verifier is brute-forceable and a client that sends
 * one is broken in a way we should refuse loudly rather than accommodate.
 */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidVerifier(v: string): boolean {
  return VERIFIER_RE.test(v);
}

/* ─────────────────────────── minting ─────────────────────────── */

export interface MintedPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  tokenFamily: string;
}

/**
 * Mint an access/refresh pair for a connection.
 *
 * `resource` is the RFC 8707 audience and is copied onto BOTH tokens, so a
 * token minted for one MCP server cannot be replayed against another that
 * happens to share this database.
 *
 * `family` continues an existing chain on refresh, or starts one at
 * authorization. Passing the wrong family would break replay detection, so it
 * is required rather than defaulted.
 */
export async function mintTokenPair(opts: {
  connectionId: string;
  resource: string;
  scopes: string[];
  family: string;
  now?: Date;
}): Promise<MintedPair> {
  const now = opts.now ?? new Date();
  const accessToken = mintSecret();
  const refreshToken = mintSecret();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  await prisma.$transaction([
    prisma.mcpAccessToken.create({
      data: {
        tokenHash: hashToken(accessToken),
        connectionId: opts.connectionId,
        resource: opts.resource,
        scopes: opts.scopes,
        expiresAt: accessExpiresAt,
      },
    }),
    prisma.mcpRefreshToken.create({
      data: {
        tokenHash: hashToken(refreshToken),
        connectionId: opts.connectionId,
        tokenFamily: opts.family,
        resource: opts.resource,
        scopes: opts.scopes,
        expiresAt: refreshExpiresAt,
      },
    }),
  ]);

  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, tokenFamily: opts.family };
}

/* ─────────────────────────── revocation ─────────────────────────── */

/**
 * Kill a connection and everything descended from it, in one transaction.
 *
 * Called on: the human revoking, refresh-token replay, authorization-code
 * reuse, and a membership disappearing. There is deliberately no "revoke just
 * this token" path for the theft cases - if one credential leaked, the others
 * from the same authorization are equally suspect.
 */
export async function revokeConnection(
  connectionId: string,
  reason: "user" | "replay" | "membership" | "client_disabled",
  now = new Date(),
  /**
   * Run inside an existing transaction. The replay path needs this: marking the
   * code and revoking what it produced have to be one atomic step, or a replay
   * that lost the race can still revoke a grant it never belonged to.
   */
  tx?: TxClient,
): Promise<void> {
  const run = async (c: TxClient) => {
    await c.mcpConnection.updateMany({
      where: { id: connectionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    await c.mcpAccessToken.updateMany({
      where: { connectionId, revokedAt: null },
      data: { revokedAt: now },
    });
    await c.mcpRefreshToken.updateMany({
      where: { connectionId, revokedAt: null },
      data: { revokedAt: now },
    });
  };
  if (tx) return run(tx);
  await prisma.$transaction((inner) => run(inner));
}

/** Kill one refresh-token family without touching siblings from a later grant. */
export async function revokeFamily(
  connectionId: string,
  family: string,
  now = new Date(),
): Promise<void> {
  await prisma.mcpRefreshToken.updateMany({
    where: { connectionId, tokenFamily: family, revokedAt: null },
    data: { revokedAt: now },
  });
}

/* ─────────────────────────── resolution ─────────────────────────── */

/**
 * Why a bearer token was refused.
 *
 * These strings reach the client as an OAuth `error_description` and land in
 * the audit table as `failureCode`. They are deliberately CATEGORIES, not
 * details: "invalid_token" never says whether the token was unknown, expired or
 * revoked, because that difference is only useful to somebody probing.
 */
export type TokenFailure =
  | "missing_token"
  | "malformed_token"
  | "invalid_token"
  | "expired_token"
  | "revoked_token"
  | "wrong_audience"
  | "membership_gone"
  | "insufficient_scope";

export interface ResolvedToken {
  connectionId: string;
  userId: string;
  shopId: string;
  clientId: string;
  clientName: string;
  accessLevel: McpAccessLevel;
  scopes: string[];
  resource: string;
  accessTokenId: string;
}

export type ResolveResult =
  | { ok: true; token: ResolvedToken }
  | { ok: false; failure: TokenFailure };

/**
 * Resolve a bearer token to an authorization, or refuse it.
 *
 * ORDER MATTERS and is checked cheapest-and-most-certain first: shape, then
 * existence, then revocation, then expiry, then audience. Membership is
 * re-verified by the caller (see `middleware/mcpAuth.ts`) because it needs the
 * role too, and because a membership check is the one lookup we want to be able
 * to reason about separately.
 *
 * 🔴 NOTHING IS READ FROM THE REQUEST except the token string itself. The shop,
 * the user and the granted scopes all come from the stored connection.
 */
export async function resolveAccessToken(
  raw: string,
  expectedResource: string,
  now = new Date(),
): Promise<ResolveResult> {
  // Shape check before touching the database: a 4KB junk string should cost us
  // a regex, not a query.
  if (!raw || raw.length < 20 || raw.length > 512) {
    return { ok: false, failure: "malformed_token" };
  }

  const row = await prisma.mcpAccessToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      resource: true,
      scopes: true,
      connection: {
        select: {
          id: true,
          userId: true,
          shopId: true,
          accessLevel: true,
          revokedAt: true,
          client: { select: { clientId: true, clientName: true, disabledAt: true } },
        },
      },
    },
  });

  // An unknown hash and a hash we deleted are the same answer to the caller.
  if (!row) return { ok: false, failure: "invalid_token" };
  if (row.revokedAt || row.connection.revokedAt || row.connection.client.disabledAt) {
    return { ok: false, failure: "revoked_token" };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, failure: "expired_token" };
  }
  // RFC 8707: a token is valid only at the resource it was issued for. Without
  // this, a token minted for a staging MCP server would work against production
  // if both ever shared a database.
  if (row.resource !== expectedResource) {
    return { ok: false, failure: "wrong_audience" };
  }

  return {
    ok: true,
    token: {
      connectionId: row.connection.id,
      userId: row.connection.userId,
      shopId: row.connection.shopId,
      clientId: row.connection.client.clientId,
      clientName: row.connection.client.clientName,
      accessLevel: row.connection.accessLevel,
      scopes: row.scopes,
      resource: row.resource,
      accessTokenId: row.id,
    },
  };
}

/* ─────────────────────────── refresh ─────────────────────────── */

export type RefreshResult =
  | { ok: true; pair: MintedPair; connectionId: string }
  | { ok: false; failure: TokenFailure | "replay_detected" };

/**
 * Exchange a refresh token for a new pair, rotating it.
 *
 * 🔴 THE REPLAY BRANCH IS THE POINT OF THIS FUNCTION. A refresh token that has
 * already been rotated (or revoked) is not "stale" - it is evidence that a copy
 * of it exists somewhere it should not, because the legitimate client discards
 * its old token the moment it receives a new one. So presenting one revokes the
 * whole connection rather than merely refusing the request. The legitimate
 * client is logged out too, which is correct: it is the only way to be sure the
 * thief is.
 *
 * The read-then-rotate is done inside a transaction with the rotation guarded by
 * `rotatedAt: null`, so two concurrent refreshes cannot both succeed - the loser
 * updates zero rows and is treated as a replay.
 */
export async function rotateRefreshToken(
  raw: string,
  expectedResource: string,
  now = new Date(),
): Promise<RefreshResult> {
  if (!raw || raw.length < 20 || raw.length > 512) {
    return { ok: false, failure: "malformed_token" };
  }

  const row = await prisma.mcpRefreshToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: {
      id: true,
      connectionId: true,
      tokenFamily: true,
      resource: true,
      scopes: true,
      expiresAt: true,
      rotatedAt: true,
      revokedAt: true,
      connection: {
        select: { revokedAt: true, client: { select: { disabledAt: true } } },
      },
    },
  });

  if (!row) return { ok: false, failure: "invalid_token" };

  // Already spent, or already killed -> theft. Burn the connection.
  if (row.rotatedAt || row.revokedAt) {
    await prisma.mcpRefreshToken.updateMany({
      where: { id: row.id, replayDetectedAt: null },
      data: { replayDetectedAt: now },
    });
    await revokeConnection(row.connectionId, "replay", now);
    return { ok: false, failure: "replay_detected" };
  }

  if (row.connection.revokedAt || row.connection.client.disabledAt) {
    return { ok: false, failure: "revoked_token" };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, failure: "expired_token" };
  }
  if (row.resource !== expectedResource) {
    return { ok: false, failure: "wrong_audience" };
  }

  // Claim the rotation. `rotatedAt: null` in the WHERE is the concurrency guard:
  // exactly one caller can win, and the loser falls into the replay branch on
  // its next attempt.
  const claimed = await prisma.mcpRefreshToken.updateMany({
    where: { id: row.id, rotatedAt: null },
    data: { rotatedAt: now },
  });
  if (claimed.count !== 1) {
    await revokeConnection(row.connectionId, "replay", now);
    return { ok: false, failure: "replay_detected" };
  }

  // The old ACCESS tokens die with the rotation. Keeping them alive would mean
  // a refresh does not actually shorten the life of a captured access token.
  await prisma.mcpAccessToken.updateMany({
    where: { connectionId: row.connectionId, revokedAt: null },
    data: { revokedAt: now },
  });

  const pair = await mintTokenPair({
    connectionId: row.connectionId,
    resource: row.resource,
    scopes: row.scopes,
    family: row.tokenFamily,
    now,
  });
  return { ok: true, pair, connectionId: row.connectionId };
}

/* ─────────────────────────── authorization codes ─────────────────────────── */

/**
 * An authorization code, read WITHOUT mutating it.
 *
 * 🔴 READ-ONLY BY DESIGN. The caller has to be able to check the client, the
 * redirect_uri, the resource and PKCE *before* anything is consumed, because
 * those checks are what separate "a legitimate client redeeming its own code"
 * from "somebody holding a stolen code". Consuming first would let anyone who
 * merely SAW the code (a redirect chain, a browser history entry, a referrer)
 * destroy a barber's in-flight authorization without ever proving possession of
 * the verifier - a denial-of-service handed out for free.
 *
 * `consumedAt` comes back so the caller can tell a first redemption from a
 * second one, but acting on it is the caller's decision, made only after the
 * request has been proven authentic.
 */
export interface LoadedAuthCode {
  id: string;
  clientId: string;
  userId: string;
  shopId: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  accessLevel: McpAccessLevel;
  expiresAt: Date;
  consumedAt: Date | null;
}

export async function loadAuthCode(rawCode: string): Promise<LoadedAuthCode | null> {
  if (!rawCode || rawCode.length < 20 || rawCode.length > 512) return null;
  return prisma.mcpAuthCode.findUnique({
    where: { codeHash: hashToken(rawCode) },
    select: {
      id: true,
      clientId: true,
      userId: true,
      shopId: true,
      codeChallenge: true,
      redirectUri: true,
      resource: true,
      scopes: true,
      accessLevel: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
}

/**
 * Claim a code, exactly once, via a database compare-and-set.
 *
 * `consumedAt: null` in the WHERE is the whole mechanism: the single-use
 * guarantee is enforced by Postgres, not by a read-then-write in application
 * code that two concurrent requests could interleave. Exactly one caller sees
 * `count === 1`; every other caller sees `0` and is a genuine replay.
 *
 * Called ONLY after the redemption has been fully validated - see the note on
 * `loadAuthCode`.
 */
export async function claimAuthCode(id: string, now = new Date()): Promise<boolean> {
  const claimed = await prisma.mcpAuthCode.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: now },
  });
  return claimed.count === 1;
}

/**
 * A VALIDATED redemption arrived for a code that was already spent.
 *
 * 🔴 THIS IS THEFT, NOT A RETRY (OAuth 2.1 §4.1.3). Reaching here means the
 * caller proved possession of the PKCE verifier and still presented a code that
 * had already been exchanged - so two parties hold the same verifier, and the
 * one we served first may well have been the attacker. Everything that code
 * produced dies, which is the only way to be sure the thief's tokens do.
 *
 * 🔴 THE CODE ROW IS THE INTERLOCK, AND IT IS RE-CHECKED HERE, IN THIS
 * TRANSACTION. Deleting stale codes at re-consent stops a stale code being
 * LOADED, but it cannot stop one that was loaded a moment earlier and is still
 * in flight:
 *
 *     1. a replay loads consumed code A
 *     2. re-consent deletes code A and reactivates the reused connection
 *     3. the in-flight replay resumes
 *     4. it revokes the connection - the REPLACEMENT grant, which it was never
 *        part of
 *
 * So the conditional mark and the revocation are one atomic step, and a mark
 * that touches ZERO rows aborts the whole thing. Zero rows means the code was
 * deleted by a re-consent, or another replay already handled it; either way this
 * replay is stale and has no grant of its own left to revoke.
 *
 * LOCK ORDER: authorization code, then connection - the same order
 * `/authorize/approve` takes, so the two can never deadlock against each other.
 *
 * Returns true only when this call actually revoked something.
 */
export async function revokeForAuthCodeReplay(
  code: Pick<LoadedAuthCode, "id" | "userId" | "shopId" | "clientId">,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const marked = await tx.mcpAuthCode.updateMany({
      where: { id: code.id, replayDetectedAt: null },
      data: { replayDetectedAt: now },
    });
    // 🔴 The abort. Never revoke on the strength of a row we did not win.
    if (marked.count !== 1) return false;

    const conn = await tx.mcpConnection.findUnique({
      where: {
        userId_shopId_clientId: {
          userId: code.userId,
          shopId: code.shopId,
          clientId: code.clientId,
        },
      },
      select: { id: true },
    });
    if (!conn) return false;
    await revokeConnection(conn.id, "replay", now, tx);
    return true;
  });
}
