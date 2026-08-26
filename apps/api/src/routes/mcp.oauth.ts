import { Router } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { prisma, type McpProviderHint } from "@chairback/db";
import { requireUser } from "../middleware/auth.js";
import { resolveShopAccess } from "../middleware/auth.js";
import { oauthLimiter } from "../middleware/rateLimit.js";
import { logMcpAuth } from "../mcp/audit.js";
import { hasShopAccess } from "../mcp/seat.js";
import { mcpIssuer, mcpResourceUrl } from "../mcp/metadata.js";
import { DEFAULT_SCOPES, SCOPE_LABELS, isReadOnly, parseScopes } from "@chairback/config/mcpScopes";
import {
  AUTH_CODE_TTL_MS,
  ACCESS_TOKEN_TTL_MS,
  claimAuthCode,
  hashToken,
  isValidVerifier,
  loadAuthCode,
  mintSecret,
  mintTokenPair,
  pkceS256,
  revokeConnection,
  revokeForAuthCodeReplay,
  rotateRefreshToken,
  safeEqual,
} from "../mcp/tokens.js";

/**
 * The MCP authorization server: registration, consent, token exchange, revocation.
 *
 * ── THE FLOW, END TO END ─────────────────────────────────────────────────────
 *
 *   POST /mcp/oauth/register     client declares itself, gets a client_id
 *   GET  /mcp/oauth/authorize    human approves; we mint a 60s code
 *   POST /mcp/oauth/token        code + PKCE verifier -> access + refresh
 *   POST /mcp/oauth/token        refresh -> rotated pair
 *   POST /mcp/oauth/revoke       either token -> connection dies
 *
 * ── WHAT PROVES WHAT ─────────────────────────────────────────────────────────
 *
 * There is no client secret anywhere in this file. Every MCP client is a PUBLIC
 * client (a desktop app, a browser extension), so a secret would be shipped to
 * the attacker along with the software. Three things carry the weight instead:
 *
 *   the HUMAN         a ChairBack session cookie at /authorize. Consent is a
 *                     first-party, authenticated action - the client never sees
 *                     ChairBack credentials and never handles them.
 *   PKCE              proves the party redeeming the code is the party that
 *                     started the flow, even if the code leaked in transit.
 *   the REDIRECT URI  exact-match, registered up front, re-checked at exchange.
 *
 * ── WHAT IS FROZEN AT CONSENT ────────────────────────────────────────────────
 *
 * The code row stores user, shop, scopes, access level, redirect_uri, resource
 * and the PKCE challenge. The token endpoint compares against THOSE, never
 * against what the client re-sends, so a client cannot widen its own grant
 * between the two calls.
 *
 * ── VALIDATE, THEN CLAIM ─────────────────────────────────────────────────────
 *
 * 🔴 The exchange checks EVERYTHING before it mutates anything. A bare
 * authorization code is not a credential - it leaks through redirect chains,
 * browser history and referrer headers - so consuming one on presentation would
 * let anybody who saw it destroy a barber's in-flight authorization, and
 * declaring replay on it would let them kill a live connection, all without ever
 * holding the PKCE verifier. Validation first closes both.
 *
 * The single-use guarantee is unaffected, because it never came from the
 * ordering: it comes from a compare-and-set on `consumedAt: null`. Exactly one
 * concurrent redemption wins that CAS; a loser is a genuine replay and takes the
 * revocation path, identical to a code presented twice in sequence.
 */
export const mcpOAuthRouter: Router = Router();

/* ─────────────────────────── error shape ─────────────────────────── */

/**
 * RFC 6749 §5.2 error body.
 *
 * 🔴 `error_description` is a fixed CATEGORY string, never anything derived from
 * the request and never an internal message. An OAuth error is returned to an
 * unauthenticated caller by definition, so it is the easiest place in the whole
 * product to leak - which is exactly how a shop's webhook secret ended up echoed
 * in an Acuity error body earlier this month.
 */
function oauthError(
  res: import("express").Response,
  status: number,
  error: string,
  description: string,
): void {
  res.status(status).json({ error, error_description: description });
}

/* ─────────────────────────── registration ─────────────────────────── */

/**
 * A redirect URI we are willing to register.
 *
 * 🔴 THE OPEN-REDIRECT GATE. An attacker who can register `https://evil/` as a
 * redirect for a client and then trick a barber through /authorize walks away
 * with an authorization code. So:
 *
 *   - https only, EXCEPT loopback, which the OAuth 2.1 native-app guidance
 *     requires (a desktop client listens on 127.0.0.1 on a random port);
 *   - no fragment (RFC 6749 §3.1.2 forbids it);
 *   - no credentials in the URI;
 *   - a bare custom scheme (`myapp://cb`) is allowed because native clients use
 *     them, but it must have a scheme AND a host-or-path so it cannot be a
 *     degenerate value that some client-side parser normalises into something
 *     else.
 *
 * Exact string matching at exchange time does the rest: this only decides what
 * may enter the allowlist.
 */
function isRegisterableRedirectUri(raw: string): boolean {
  if (raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash !== "") return false;
  if (u.username !== "" || u.password !== "") return false;

  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    // Loopback only, and by literal address - "localhost" can resolve
    // somewhere unexpected on a compromised machine.
    return u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  }
  // Custom scheme for a native client.
  if (/^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "file:", "vbscript:"].includes(u.protocol)) {
    return (u.host !== "" || u.pathname !== "") && raw.length > u.protocol.length + 1;
  }
  return false;
}

const registerSchema = z.object({
  client_name: z.string().min(1).max(120),
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(8),
});

/** Guess the provider from the declared name. UI LABEL ONLY - never a decision. */
function providerHintFor(name: string): McpProviderHint {
  const n = name.toLowerCase();
  if (n.includes("chatgpt") || n.includes("openai")) return "CHATGPT";
  if (n.includes("claude") || n.includes("anthropic")) return "CLAUDE";
  return "OTHER";
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Open by design: MCP clients cannot be pre-provisioned, and registering grants
 * NOTHING on its own - a client_id with no human consent behind it can read
 * exactly zero bytes of shop data. The value that matters is created at
 * /authorize, by a signed-in barber, not here.
 *
 * Rate-limited per IP with the shared oauth limiter so the table cannot be
 * filled by a script.
 */
mcpOAuthRouter.post("/register", oauthLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    oauthError(res, 400, "invalid_client_metadata", "client_name and redirect_uris are required");
    return;
  }
  const { client_name, redirect_uris } = parsed.data;

  const bad = redirect_uris.filter((u) => !isRegisterableRedirectUri(u));
  if (bad.length > 0) {
    // Names no specific URI: the caller sent them and knows which, and echoing
    // one back is a reflected-content path we do not need.
    oauthError(res, 400, "invalid_redirect_uri", "one or more redirect_uris are not acceptable");
    return;
  }

  const clientId = `cb_mcp_${mintSecret()}`;
  const client = await prisma.mcpClient.create({
    data: {
      clientId,
      clientName: client_name,
      redirectUris: redirect_uris,
      providerHint: providerHintFor(client_name),
    },
    select: { clientId: true, clientName: true, redirectUris: true, createdAt: true },
  });

  res.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    // Explicit rather than absent, so a client cannot infer that we simply
    // forgot to send a secret and go looking for one.
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

/**
 * What the consent screen needs to describe the request honestly.
 *
 * 🔴 WHY THIS ENDPOINT EXISTS. The consent page is reachable directly, so every
 * value in its query string is attacker-controlled. If it rendered the client
 * name from the URL, anyone could send a barber to a page that says "ChairBack
 * Official" and points at their own server. So the page asks US what this
 * client_id ACTUALLY registered, and refuses to render a consent form when the
 * redirect_uri in the URL is not one of them.
 *
 * The registered name is still SELF-DECLARED and the page labels it as such -
 * knowing that "Claude Desktop" is what the software calls itself is useful to a
 * human; treating it as proof of anything is not. The redirect host is shown
 * beside it because that is the part an attacker cannot fake without also
 * controlling the destination.
 *
 * Not sensitive: a client_id is 43 characters of CSPRNG, so this is not an
 * enumeration surface, and everything returned is what the caller themselves
 * registered.
 */
mcpOAuthRouter.get("/client-info", oauthLimiter, async (req, res) => {
  const id = typeof req.query.client_id === "string" ? req.query.client_id : "";
  if (!id || id.length > 200) {
    oauthError(res, 400, "invalid_client", "unknown client");
    return;
  }
  const client = await prisma.mcpClient.findUnique({
    where: { clientId: id },
    select: { clientName: true, redirectUris: true, providerHint: true, disabledAt: true },
  });
  if (!client || client.disabledAt) {
    oauthError(res, 400, "invalid_client", "unknown client");
    return;
  }
  res.json({
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    provider_hint: client.providerHint,
  });
});

/* ─────────────────────────── authorize ─────────────────────────── */

const authorizeSchema = z.object({
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().min(1).max(2000),
  response_type: z.literal("code"),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal("S256"),
  state: z.string().min(1).max(500).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(500).optional(),
});

/**
 * Where the human approves.
 *
 * 🔴 THE REDIRECT_URI IS VALIDATED BEFORE ANYTHING IS REDIRECTED. An OAuth error
 * is normally returned BY redirecting to the client with `?error=`, but doing
 * that with an unvalidated URI turns this endpoint into an open redirector. So
 * the order is: resolve the client, match the URI exactly against its registered
 * list, and only then is redirecting to it safe. Every failure before that point
 * renders here instead.
 *
 * The human's identity comes from the ChairBack session cookie. An unauthenticated
 * visitor is sent to the normal login page with a `next` that returns them here,
 * so the AI client never sees, handles or proxies a ChairBack credential.
 */
mcpOAuthRouter.get("/authorize", oauthLimiter, async (req, res) => {
  const parsed = authorizeSchema.safeParse(req.query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // A bad `code_challenge_method` is the one worth naming: it is the
    // difference between "your library is old" and "your request was garbage".
    const isPlain =
      issue?.path.join(".") === "code_challenge_method" &&
      typeof req.query.code_challenge_method === "string";
    oauthError(
      res,
      400,
      "invalid_request",
      isPlain
        ? "code_challenge_method must be S256; plain is not supported"
        : "missing or invalid authorization parameters",
    );
    return;
  }
  const q = parsed.data;

  const client = await prisma.mcpClient.findUnique({
    where: { clientId: q.client_id },
    select: { id: true, clientName: true, redirectUris: true, disabledAt: true },
  });
  if (!client || client.disabledAt) {
    oauthError(res, 400, "invalid_client", "unknown client");
    return;
  }
  // EXACT match. No normalisation, no trailing-slash forgiveness, no prefix.
  if (!client.redirectUris.includes(q.redirect_uri)) {
    oauthError(res, 400, "invalid_request", "redirect_uri does not match a registered value");
    return;
  }

  // RFC 8707. Default to our own resource, but a client that names one must
  // name OURS - otherwise it is trying to get us to mint a token for somebody
  // else's server.
  const resource = q.resource ?? mcpResourceUrl();
  if (resource !== mcpResourceUrl()) {
    oauthError(res, 400, "invalid_target", "resource does not match this server");
    return;
  }

  const scopes = parseScopes(q.scope);
  if (!scopes.ok) {
    oauthError(res, 400, "invalid_scope", "one or more requested scopes are not supported");
    return;
  }
  // Belt and braces on top of an empty WRITE_SCOPES: even if a write scope were
  // added to the list by accident, it cannot be granted here.
  if (!isReadOnly(scopes.scopes)) {
    oauthError(res, 400, "invalid_scope", "only read-only scopes can be granted");
    return;
  }

  // The consent screen lives in the web app (it is a human-facing page with the
  // dashboard's chrome and the barber's session). Everything it needs is passed
  // through; it POSTs back to /authorize/approve with the same values.
  const consent = new URL(`${apiEnv().APP_BASE_URL.replace(/\/$/, "")}/mcp/authorize`);
  consent.searchParams.set("client_id", q.client_id);
  consent.searchParams.set("redirect_uri", q.redirect_uri);
  consent.searchParams.set("code_challenge", q.code_challenge);
  consent.searchParams.set("resource", resource);
  consent.searchParams.set("scope", scopes.scopes.join(" "));
  if (q.state) consent.searchParams.set("state", q.state);
  res.redirect(302, consent.toString());
});

const approveSchema = authorizeSchema.omit({ response_type: true, code_challenge_method: true });

/**
 * The consent POST. Requires a real ChairBack session - this is the moment a
 * human grants access, so it is the one endpoint here that is authenticated as
 * a person rather than as a client.
 *
 * Everything is re-validated from scratch. The web consent page is a
 * convenience, not a trust boundary: a request that skipped it entirely must be
 * exactly as safe as one that did not.
 */
mcpOAuthRouter.post("/authorize/approve", oauthLimiter, requireUser, async (req, res) => {
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    oauthError(res, 400, "invalid_request", "missing or invalid authorization parameters");
    return;
  }
  const q = parsed.data;
  const userId = req.userId!;

  const client = await prisma.mcpClient.findUnique({
    where: { clientId: q.client_id },
    select: { id: true, clientName: true, redirectUris: true, disabledAt: true },
  });
  if (!client || client.disabledAt) {
    oauthError(res, 400, "invalid_client", "unknown client");
    return;
  }
  if (!client.redirectUris.includes(q.redirect_uri)) {
    oauthError(res, 400, "invalid_request", "redirect_uri does not match a registered value");
    return;
  }
  const resource = q.resource ?? mcpResourceUrl();
  if (resource !== mcpResourceUrl()) {
    oauthError(res, 400, "invalid_target", "resource does not match this server");
    return;
  }
  const scopes = parseScopes(q.scope);
  if (!scopes.ok || !isReadOnly(scopes.scopes)) {
    oauthError(res, 400, "invalid_scope", "only read-only scopes can be granted");
    return;
  }

  // 🔴 THE SHOP COMES FROM THE SESSION, NEVER FROM THE REQUEST. resolveShopAccess
  // re-derives which shop this user acts in and with what role; a shopId in the
  // body would be a cross-tenant grant waiting to happen.
  const access = await resolveShopAccess(userId, req.cookies?.cb_active_shop);
  if (!access) {
    oauthError(res, 403, "access_denied", "this account does not belong to a shop");
    return;
  }

  // One connection per (user, shop, client): re-authorizing REPLACES the grant
  // rather than stacking a second one the human cannot tell apart. Any tokens
  // from the previous grant are killed, so an old client instance cannot keep
  // reading after a re-consent it was not part of.
  const existing = await prisma.mcpConnection.findUnique({
    where: {
      userId_shopId_clientId: { userId, shopId: access.shop.id, clientId: client.id },
    },
    select: { id: true },
  });
  if (existing) await revokeConnection(existing.id, "user");

  const connection = await prisma.mcpConnection.upsert({
    where: {
      userId_shopId_clientId: { userId, shopId: access.shop.id, clientId: client.id },
    },
    create: {
      userId,
      shopId: access.shop.id,
      clientId: client.id,
      accessLevel: "READ_ONLY",
    },
    update: { revokedAt: null, revokedReason: null, accessLevel: "READ_ONLY" },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.mcpToolGrant.deleteMany({ where: { connectionId: connection.id } }),
    prisma.mcpToolGrant.createMany({
      data: scopes.scopes.map((scope) => ({ connectionId: connection.id, scope })),
    }),
  ]);

  const code = mintSecret();
  await prisma.mcpAuthCode.create({
    data: {
      codeHash: hashToken(code),
      clientId: client.id,
      userId,
      shopId: access.shop.id,
      codeChallenge: q.code_challenge,
      redirectUri: q.redirect_uri,
      resource,
      scopes: scopes.scopes,
      accessLevel: "READ_ONLY",
      expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
    },
  });

  await logMcpAuth({
    shopId: access.shop.id,
    userId,
    connectionId: connection.id,
    toolName: "oauth.authorize",
    result: "OK",
  });

  // The client gets the code on ITS redirect_uri, which we have now matched
  // exactly against the registered list.
  const back = new URL(q.redirect_uri);
  back.searchParams.set("code", code);
  if (q.state) back.searchParams.set("state", q.state);
  // RFC 9207: name the issuer so a client cannot be tricked into redeeming a
  // code at the wrong authorization server (mix-up attack).
  back.searchParams.set("iss", mcpIssuer());
  res.json({ redirect_to: back.toString() });
});

/* ─────────────────────────── token ─────────────────────────── */

const codeGrantSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1).max(512),
  code_verifier: z.string().min(1).max(256),
  redirect_uri: z.string().min(1).max(2000),
  client_id: z.string().min(1).max(200),
  resource: z.string().max(500).optional(),
});

const refreshGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1).max(512),
  client_id: z.string().min(1).max(200).optional(),
  resource: z.string().max(500).optional(),
});

/**
 * Token endpoint. Two grants, one shared rule: everything is compared against
 * what was frozen at consent, never against what the client asserts now.
 */
mcpOAuthRouter.post("/token", oauthLimiter, async (req, res) => {
  // No caching, ever - these responses contain bearer tokens.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");

  const grant = typeof req.body?.grant_type === "string" ? req.body.grant_type : "";

  if (grant === "authorization_code") {
    await handleCodeGrant(req, res);
    return;
  }
  if (grant === "refresh_token") {
    await handleRefreshGrant(req, res);
    return;
  }
  oauthError(res, 400, "unsupported_grant_type", "supported grants: authorization_code, refresh_token");
});

async function handleCodeGrant(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  const parsed = codeGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    oauthError(res, 400, "invalid_request", "missing or invalid grant parameters");
    return;
  }
  const b = parsed.data;

  /* ── VALIDATE FIRST. NOTHING IS MUTATED IN THIS BLOCK. ────────────────────
   *
   * 🔴 Every refusal below returns the SAME generic `invalid_grant` and leaves
   * the code untouched: not consumed, not marked replayed, and with no
   * connection revoked. That matters because a bare authorization code is not a
   * credential - it leaks through redirect chains, browser history and referrer
   * headers - and PKCE is what proves the caller is the party that started the
   * flow. If an unvalidated presentation could consume or revoke, anyone who
   * merely SAW a code could destroy a barber's in-flight authorization, or kill
   * a live connection, without ever holding the verifier.
   *
   * The responses are also deliberately identical to each other, so a caller
   * cannot use the error to learn WHICH of the client, redirect_uri, resource or
   * verifier was wrong. Rate limiting and audit still apply on the way in.
   * -------------------------------------------------------------------------*/

  // Shape check first: it is the only one that needs no database read.
  if (!isValidVerifier(b.code_verifier)) {
    oauthError(res, 400, "invalid_grant", "authorization code is not valid");
    return;
  }

  const code = await loadAuthCode(b.code);
  if (!code) {
    oauthError(res, 400, "invalid_grant", "authorization code is not valid");
    return;
  }
  if (code.expiresAt.getTime() <= Date.now()) {
    // An expired code cannot be a replay - nothing can be minted from it - so
    // this is the one refusal that says something specific. It is also useless
    // to an attacker, who can read a clock.
    oauthError(res, 400, "invalid_grant", "authorization code has expired");
    return;
  }

  const client = await prisma.mcpClient.findUnique({
    where: { id: code.clientId },
    select: { id: true, clientId: true, disabledAt: true },
  });
  if (
    !client ||
    client.disabledAt ||
    client.clientId !== b.client_id ||
    b.redirect_uri !== code.redirectUri ||
    (b.resource !== undefined && b.resource !== code.resource) ||
    // PKCE last, and constant-time, against the challenge frozen at consent.
    !safeEqual(pkceS256(b.code_verifier), code.codeChallenge)
  ) {
    oauthError(res, 400, "invalid_grant", "authorization code is not valid");
    return;
  }

  /* ── The request is now PROVEN AUTHENTIC. Only past this line may the code be
   * consumed, or a replay declared. ----------------------------------------*/

  // 🔴 Already spent, by a request that also held the verifier. Two parties have
  // the same verifier, and the one served first may have been the attacker, so
  // everything this grant produced dies.
  if (code.consumedAt) {
    await revokeForAuthCodeReplay(code);
    oauthError(res, 400, "invalid_grant", "authorization code is not valid");
    return;
  }

  // Single-use, enforced by the database. Exactly one concurrent redemption can
  // win; a loser is indistinguishable from a second presentation and takes the
  // same replay path.
  if (!(await claimAuthCode(code.id))) {
    await revokeForAuthCodeReplay(code);
    oauthError(res, 400, "invalid_grant", "authorization code is not valid");
    return;
  }

  const connection = await prisma.mcpConnection.findUnique({
    where: {
      userId_shopId_clientId: {
        userId: code.userId,
        shopId: code.shopId,
        clientId: code.clientId,
      },
    },
    select: { id: true, revokedAt: true },
  });
  if (!connection || connection.revokedAt) {
    oauthError(res, 400, "invalid_grant", "authorization is no longer valid");
    return;
  }

  // 🔴 MEMBERSHIP IS RE-CHECKED HERE TOO. Consent may have been seconds ago, but
  // a seat can be removed in between, and a token minted after that would
  // outlive the access it was granted from.
  const stillMember = await hasShopAccess(code.userId, code.shopId);
  if (!stillMember) {
    await revokeConnection(connection.id, "membership");
    oauthError(res, 400, "invalid_grant", "authorization is no longer valid");
    return;
  }

  const pair = await mintTokenPair({
    connectionId: connection.id,
    resource: code.resource,
    scopes: code.scopes,
    // A fresh authorization starts a NEW family: tokens from a previous grant
    // must not be able to implicate this one in a replay.
    family: mintSecret(),
  });

  await logMcpAuth({
    shopId: code.shopId,
    userId: code.userId,
    connectionId: connection.id,
    toolName: "oauth.token.code",
    result: "OK",
  });

  res.json({
    access_token: pair.accessToken,
    refresh_token: pair.refreshToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: code.scopes.join(" "),
  });
}

async function handleRefreshGrant(
  req: import("express").Request,
  res: import("express").Response,
): Promise<void> {
  const parsed = refreshGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    oauthError(res, 400, "invalid_request", "missing or invalid grant parameters");
    return;
  }
  const b = parsed.data;

  const rotated = await rotateRefreshToken(b.refresh_token, b.resource ?? mcpResourceUrl());
  if (!rotated.ok) {
    // A replay has ALREADY revoked the connection inside rotateRefreshToken.
    // The client is told the same thing either way - naming replay here would
    // tell an attacker their stolen token was detected.
    oauthError(res, 400, "invalid_grant", "refresh token is not valid");
    return;
  }

  const conn = await prisma.mcpConnection.findUnique({
    where: { id: rotated.connectionId },
    select: { id: true, userId: true, shopId: true },
  });
  if (!conn) {
    oauthError(res, 400, "invalid_grant", "refresh token is not valid");
    return;
  }

  // 🔴 EVERY REFRESH RE-CHECKS MEMBERSHIP. This is what makes "removed from the
  // shop = access stops" true in practice: at worst an access token survives its
  // own 15 minutes, and no NEW one can ever be minted.
  if (!(await hasShopAccess(conn.userId, conn.shopId))) {
    await revokeConnection(conn.id, "membership");
    oauthError(res, 400, "invalid_grant", "refresh token is not valid");
    return;
  }

  await logMcpAuth({
    shopId: conn.shopId,
    userId: conn.userId,
    connectionId: conn.id,
    toolName: "oauth.token.refresh",
    result: "OK",
  });

  res.json({
    access_token: rotated.pair.accessToken,
    refresh_token: rotated.pair.refreshToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  });
}

/* ─────────────────────────── revoke ─────────────────────────── */

/**
 * RFC 7009 revocation.
 *
 * Always answers 200, even for a token we have never seen. That is the RFC's
 * requirement and it is also the right security answer: a distinguishable
 * response here would turn this endpoint into an oracle for guessing valid
 * tokens.
 *
 * Revoking ANY token kills the whole connection. A caller asking us to forget
 * one credential has, by definition, decided the client should stop working.
 */
mcpOAuthRouter.post("/revoke", oauthLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const raw = typeof req.body?.token === "string" ? req.body.token : "";
  if (!raw || raw.length > 512) {
    res.status(200).json({});
    return;
  }
  const tokenHash = hashToken(raw);
  const [access, refresh] = await Promise.all([
    prisma.mcpAccessToken.findUnique({
      where: { tokenHash },
      select: { connectionId: true, connection: { select: { shopId: true, userId: true } } },
    }),
    prisma.mcpRefreshToken.findUnique({
      where: { tokenHash },
      select: { connectionId: true, connection: { select: { shopId: true, userId: true } } },
    }),
  ]);
  const hit = access ?? refresh;
  if (hit) {
    await revokeConnection(hit.connectionId, "user");
    await logMcpAuth({
      shopId: hit.connection.shopId,
      userId: hit.connection.userId,
      connectionId: hit.connectionId,
      toolName: "oauth.revoke",
      result: "OK",
    });
  }
  res.status(200).json({});
});

/* ─────────────────────────── shared ─────────────────────────── */

/** Consent-screen copy for the scopes being requested. Used by the web page. */
export function scopeLabels(scopes: readonly string[]): { scope: string; label: string }[] {
  return scopes.map((scope) => ({ scope, label: SCOPE_LABELS[scope] ?? scope }));
}

export { DEFAULT_SCOPES };
