import type { NextFunction, Request, Response } from "express";
import { prisma, type McpAccessLevel } from "@chairback/db";
import type { ShopRole } from "../auth/roles.js";
import { logMcpEvent } from "../mcp/audit.js";
import { resolveMcpSeat } from "../mcp/seat.js";
import { mcpResourceUrl, protectedResourceMetadataUrl } from "../mcp/metadata.js";
import { resolveAccessToken, revokeConnection, type TokenFailure } from "../mcp/tokens.js";

/**
 * Bearer authentication for the MCP endpoint.
 *
 * ── WHAT THIS ESTABLISHES, AND IN WHAT ORDER ─────────────────────────────────
 *
 *   1. a Bearer token is present and well-formed          -> else 401
 *   2. it resolves to a live, unexpired, unrevoked token  -> else 401
 *   3. it was minted for THIS resource (RFC 8707)         -> else 401
 *   4. the connection's user STILL has a seat at the shop -> else 401 + revoke
 *   5. the role is re-read from the live membership       -> never from a token
 *
 * ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────────
 *
 * 🔴 SHOP, USER AND ROLE COME FROM THE DATABASE ON EVERY SINGLE REQUEST, never
 * from the token body and never from the request. A model on the other end of
 * this connection can say anything it likes; none of it is read here. The token
 * is a pointer to a stored grant, and the grant is re-validated from scratch.
 *
 * That is also what makes "removed from the shop = access stops immediately"
 * true rather than aspirational: step 4 runs before any tool does, and a failed
 * membership check revokes the connection rather than merely refusing the call.
 *
 * ── WHY 401 AND NOT 403 ──────────────────────────────────────────────────────
 *
 * Every failure here is a 401 with a `WWW-Authenticate` challenge, because RFC
 * 9728 is how a client discovers where to authorize. A 403 would tell a client
 * "you are authenticated but not allowed", which sends it down a dead end
 * instead of back through the OAuth flow. Scope failures are the exception and
 * are handled at the tool layer, where 403 IS the right answer.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireMcpAuth. Never populated from client-supplied values. */
      mcp?: {
        connectionId: string;
        userId: string;
        shopId: string;
        clientId: string;
        clientName: string;
        accessLevel: McpAccessLevel;
        /** Re-read from live membership on this request, not from the token. */
        role: ShopRole;
        staffId: string | null;
        scopes: string[];
      };
    }
  }
}

/**
 * The RFC 9728 §5.1 challenge. Sent on EVERY 401 from the MCP surface so a
 * client that arrives with no token, or a stale one, can find its way to the
 * authorization server without any out-of-band configuration.
 */
function challenge(res: Response, error: string, description: string): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="chairback", error="${error}", error_description="${description}", ` +
      `resource_metadata="${protectedResourceMetadataUrl()}"`,
  );
}

/**
 * Map an internal failure to what the client is told.
 *
 * 🔴 THE CLIENT LEARNS ONE BIT: your token did not work. Whether it was unknown,
 * expired, revoked, minted for another audience, or belonged to somebody who
 * just lost their job is NOT distinguishable from the outside - each of those
 * differences is only useful to someone probing. The precise reason is written
 * to the audit trail, where an authorized human can read it.
 */
const CLIENT_FACING: Record<TokenFailure, { error: string; description: string }> = {
  missing_token: { error: "invalid_request", description: "a Bearer token is required" },
  malformed_token: { error: "invalid_token", description: "the access token is not valid" },
  invalid_token: { error: "invalid_token", description: "the access token is not valid" },
  expired_token: { error: "invalid_token", description: "the access token is not valid" },
  revoked_token: { error: "invalid_token", description: "the access token is not valid" },
  wrong_audience: { error: "invalid_token", description: "the access token is not valid" },
  membership_gone: { error: "invalid_token", description: "the access token is not valid" },
  insufficient_scope: { error: "insufficient_scope", description: "this token lacks the required scope" },
};

function deny(res: Response, failure: TokenFailure): void {
  const c = CLIENT_FACING[failure];
  challenge(res, c.error, c.description);
  res.status(401).json({ error: c.error, error_description: c.description });
}

/**
 * Pull the bearer token out of the Authorization header.
 *
 * HEADER ONLY. A token in a query string lands in access logs, browser history
 * and Referer headers, so `?access_token=` is not read here even though some
 * clients still send it - and the protected-resource metadata advertises
 * `bearer_methods_supported: ["header"]` to say so.
 */
function bearerFrom(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer (.+)$/.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export async function requireMcpAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const raw = bearerFrom(req);
  if (!raw) {
    deny(res, "missing_token");
    return;
  }

  const resolved = await resolveAccessToken(raw, mcpResourceUrl());
  if (!resolved.ok) {
    // No shopId is known for an unresolvable token, so there is nothing to
    // audit against a tenant - which is correct: an audit row for "somebody
    // presented a bad token" belongs in the request log, not in a shop's
    // history, and writing one would let an outsider append to a shop's audit
    // trail by guessing tokens.
    deny(res, resolved.failure);
    return;
  }
  const t = resolved.token;

  // 🔴 STEP 4. The live seat, re-read now, through the SAME resolver the consent
  // and refresh paths use (mcp/seat.ts). Four moments ask this question and they
  // must never answer it differently.
  const seat = await resolveMcpSeat(t.userId, t.shopId);

  if (!seat) {
    // Not merely refused: the grant is dead. Anything else would leave a
    // revoked colleague's assistant retrying every 15 minutes forever.
    await revokeConnection(t.connectionId, "membership");
    await logMcpEvent({
      shopId: t.shopId,
      userId: t.userId,
      connectionId: t.connectionId,
      toolName: "auth.bearer",
      operationType: "AUTH",
      result: "DENIED",
      failureCode: "membership_gone",
    });
    deny(res, "membership_gone");
    return;
  }

  req.mcp = {
    connectionId: t.connectionId,
    userId: t.userId,
    shopId: t.shopId,
    clientId: t.clientId,
    clientName: t.clientName,
    accessLevel: t.accessLevel,
    role: seat.role,
    staffId: seat.staffId,
    scopes: t.scopes,
  };

  // "Last used" is a UI nicety, so it must not be able to fail the request or
  // add latency to it.
  void prisma.mcpConnection
    .update({ where: { id: t.connectionId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  next();
}

/**
 * Scope gate for an individual tool. 403 here, not 401: the caller IS
 * authenticated, they simply were not granted this capability, and sending them
 * back through the OAuth flow would not change that unless the human re-consents.
 */
export function requireScope(scope: string) {
  return function scopeGate(req: Request, res: Response, next: NextFunction): void {
    if (!req.mcp) {
      deny(res, "missing_token");
      return;
    }
    if (!req.mcp.scopes.includes(scope)) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="chairback", error="insufficient_scope", scope="${scope}"`,
      );
      res.status(403).json({ error: "insufficient_scope", error_description: "this token lacks the required scope" });
      return;
    }
    next();
  };
}

/**
 * The gate every write tool will sit behind.
 *
 * 🔴 Nothing in this release can pass it, because nothing can mint a MANAGEMENT
 * connection. It exists now so the write PR adds tools behind an existing,
 * already-tested refusal rather than inventing the check at the same time as the
 * thing it guards.
 */
export function requireManagementAccess(req: Request, res: Response, next: NextFunction): void {
  if (!req.mcp) {
    deny(res, "missing_token");
    return;
  }
  if (req.mcp.accessLevel !== "MANAGEMENT") {
    res.status(403).json({
      error: "insufficient_scope",
      error_description: "this assistant has read-only access",
    });
    return;
  }
  next();
}

export { mcpResourceUrl };
