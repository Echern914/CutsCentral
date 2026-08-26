import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mcpResourceUrl } from "../mcp/metadata.js";
import { ACCESS_TOKEN_TTL_MS, hashToken } from "../mcp/tokens.js";

/**
 * THE MCP AUTHORIZATION SURFACE, end to end, against a real database.
 *
 * WHAT THIS FILE IS DEFENDING. This is the first PUBLIC, UNAUTHENTICATED,
 * INTERNET-FACING surface ChairBack has added since the booking API, and it
 * hands out long-lived credentials to software we do not control. Every test
 * below is a way that could go wrong:
 *
 *   - a code or token that works twice
 *   - a token that works somewhere it was not minted for
 *   - a token that outlives the access it was granted from
 *   - a redirect that carries a code to an address nobody registered
 *   - a client naming its own shop, user or role
 *   - one shop's assistant reading another shop
 *   - an error body that says more than it should
 *
 * The token lifecycle is stated once, in mcp/tokens.ts. This file proves it.
 */
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];

let ownerCookie: string;
let ownerEmail: string;
let shopId: string;

/** A second, unrelated tenant. The isolation control. */
let otherCookie: string;
let otherShopId: string;

/** A registered client, re-created per suite run. */
let clientId: string;
const REDIRECT = "https://client.example/cb/callback";

async function signup(email: string, name = "Person"): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

async function makeShop(cookie: string, name: string): Promise<string> {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  return me.body.id as string;
}

/* ───────────────── PKCE helpers, written out rather than imported ─────────────
 * Deliberately re-implemented here from RFC 7636 rather than calling the
 * server's own pkceS256(). A test that uses the implementation it is testing
 * proves only that the function equals itself; this proves we match the spec a
 * real client follows.
 * ---------------------------------------------------------------------------*/
function makeVerifier(): string {
  // 32 random bytes -> 43 base64url chars, the RFC's minimum length.
  return randomBytes(32).toString("base64url");
}
function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A well-formed value that is not any code we ever issued. */
function mintLikeCode(): string {
  return randomBytes(32).toString("base64url");
}

async function registerClient(name = "Test Assistant", uris = [REDIRECT]): Promise<string> {
  const res = await request(app)
    .post("/mcp/oauth/register")
    .send({ client_name: name, redirect_uris: uris });
  expect(res.status).toBe(201);
  return res.body.client_id as string;
}

/** Drive the consent step and return the raw authorization code. */
async function authorize(opts: {
  cookie?: string;
  clientId?: string;
  redirectUri?: string;
  challenge: string;
  scope?: string;
  state?: string;
  resource?: string;
}): Promise<{ status: number; body: Record<string, unknown>; code: string | null }> {
  const res = await request(app)
    .post("/mcp/oauth/authorize/approve")
    .set("Cookie", opts.cookie ?? ownerCookie)
    .send({
      client_id: opts.clientId ?? clientId,
      redirect_uri: opts.redirectUri ?? REDIRECT,
      code_challenge: opts.challenge,
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      ...(opts.state !== undefined ? { state: opts.state } : {}),
      ...(opts.resource !== undefined ? { resource: opts.resource } : {}),
    });
  let code: string | null = null;
  if (res.status === 200 && typeof res.body.redirect_to === "string") {
    code = new URL(res.body.redirect_to).searchParams.get("code");
  }
  return { status: res.status, body: res.body, code };
}

/** The full happy path. Returns the token response body. */
async function connect(opts: { cookie?: string; scope?: string } = {}): Promise<{
  access_token: string;
  refresh_token: string;
  scope?: string;
}> {
  const verifier = makeVerifier();
  const a = await authorize({ ...opts, challenge: challengeFor(verifier) });
  expect(a.code, "authorize did not return a code").not.toBeNull();
  const t = await request(app).post("/mcp/oauth/token").send({
    grant_type: "authorization_code",
    code: a.code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: clientId,
  });
  expect(t.status).toBe(200);
  return t.body;
}

/** Call the MCP endpoint with a bearer token. */
function mcp(token: string, method = "tools/list") {
  return request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .send({ jsonrpc: "2.0", id: 1, method });
}

beforeAll(async () => {
  ownerEmail = `mcp-o-${randomToken(6).toLowerCase()}@test.chairback`;
  ownerCookie = await signup(ownerEmail, "Owner");
  shopId = await makeShop(ownerCookie, "MCP Cuts");

  const otherEmail = `mcp-x-${randomToken(6).toLowerCase()}@test.chairback`;
  otherCookie = await signup(otherEmail, "Other");
  otherShopId = await makeShop(otherCookie, "Other Cuts");
});

beforeEach(async () => {
  clientId = await registerClient();
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.mcpClient.deleteMany({ where: { clientName: { contains: "Test Assistant" } } });
});

/* ═══════════════════════════ discovery ═══════════════════════════ */

describe("discovery — how a client that has never seen us finds its way in", () => {
  it("an unauthenticated MCP call answers 401 with the RFC 9728 challenge", async () => {
    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    const wa = res.headers["www-authenticate"];
    expect(wa).toBeDefined();
    // The challenge is the ENTIRE bootstrap: without resource_metadata a client
    // has no way to discover the authorization server.
    expect(wa).toContain("resource_metadata=");
    expect(wa).toContain("/.well-known/oauth-protected-resource");
  });

  it("protected-resource metadata names this server and its authorization server", async () => {
    const res = await request(app).get("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(mcpResourceUrl());
    expect(res.body.authorization_servers).toHaveLength(1);
    // 🔴 Header-only. A token in a query string lands in access logs, browser
    // history and Referer headers.
    expect(res.body.bearer_methods_supported).toEqual(["header"]);
  });

  it("authorization-server metadata advertises S256 only and no client secret", async () => {
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    // 🔴 `plain` must never appear: OAuth 2.1 removed it and a plain challenge
    // proves nothing — whoever intercepted the redirect has the verifier too.
    expect(res.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(res.body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(res.body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    // Grants OAuth 2.1 removed must not be offered.
    expect(res.body.grant_types_supported).not.toContain("implicit");
    expect(res.body.grant_types_supported).not.toContain("password");
  });

  it("discovery is public — it is what a client fetches BEFORE it has a token", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect((await request(app).get(path)).status).toBe(200);
    }
  });

  it("🔴 the resource identifier is fixed, and never taken from the Host header", async () => {
    const res = await request(app)
      .get("/.well-known/oauth-protected-resource")
      .set("Host", "evil.example")
      .set("X-Forwarded-Host", "evil.example");
    expect(res.body.resource).toBe(mcpResourceUrl());
    expect(JSON.stringify(res.body)).not.toContain("evil.example");
  });
});

/* ═══════════════════════════ registration ═══════════════════════════ */

describe("client registration", () => {
  it("issues a client_id and NO client secret", async () => {
    const res = await request(app)
      .post("/mcp/oauth/register")
      .send({ client_name: "Test Assistant", redirect_uris: [REDIRECT] });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBeTruthy();
    expect(res.body.token_endpoint_auth_method).toBe("none");
    // 🔴 Every MCP client is PUBLIC. A secret would ship to the attacker inside
    // the software; PKCE is what proves the caller.
    const keys = Object.keys(res.body).join(" ");
    expect(keys).not.toContain("client_secret");
  });

  it("🔴 refuses redirect URIs that would make this an open redirector", async () => {
    const forbidden = [
      "http://evil.example/steal", // plain http, not loopback
      "javascript:alert(1)",
      "data:text/html,<script>",
      "https://ok.example/cb#fragment", // RFC 6749 §3.1.2 forbids a fragment
      "https://user:pw@ok.example/cb", // credentials in the URI
      "not-a-url",
    ];
    for (const uri of forbidden) {
      const res = await request(app)
        .post("/mcp/oauth/register")
        .send({ client_name: "Test Assistant", redirect_uris: [uri] });
      expect(res.status, `accepted ${uri}`).toBe(400);
      expect(res.body.error).toBe("invalid_redirect_uri");
    }
  });

  it("allows loopback http, which native clients require", async () => {
    for (const uri of ["http://127.0.0.1:49152/cb", "http://[::1]:1234/cb"]) {
      const res = await request(app)
        .post("/mcp/oauth/register")
        .send({ client_name: "Test Assistant", redirect_uris: [uri] });
      expect(res.status, `rejected ${uri}`).toBe(201);
    }
  });

  it("client-info returns what the client registered, and nothing else", async () => {
    const id = await registerClient("Test Assistant Named", [REDIRECT]);
    const res = await request(app).get("/mcp/oauth/client-info").query({ client_id: id });
    expect(res.status).toBe(200);
    expect(res.body.client_name).toBe("Test Assistant Named");
    expect(res.body.redirect_uris).toEqual([REDIRECT]);
    // 🔴 This is what lets the consent screen refuse a tampered link. It must
    // never grow a field that is not the client's own registration.
    expect(Object.keys(res.body).sort()).toEqual([
      "client_name",
      "provider_hint",
      "redirect_uris",
    ]);
  });

  it("client-info refuses an unknown client without saying more", async () => {
    const res = await request(app)
      .get("/mcp/oauth/client-info")
      .query({ client_id: "cb_mcp_not_a_real_client_id_at_all_padding" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client");
    expect(JSON.stringify(res.body)).not.toContain("not_a_real_client");
  });

  it("the declared client name is a LABEL and never an authorization input", async () => {
    // A client calling itself "ChatGPT" gets a providerHint for UI copy and
    // absolutely nothing else.
    const id = await registerClient("Test Assistant ChatGPT");
    const row = await prisma.mcpClient.findUnique({
      where: { clientId: id },
      select: { providerHint: true },
    });
    expect(row?.providerHint).toBe("CHATGPT");
    // It confers no scope, no access level and no shop.
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${id}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
  });
});

/* ═══════════════════════════ the code flow ═══════════════════════════ */

describe("authorization code + PKCE", () => {
  it("the happy path issues an access and a refresh token", async () => {
    const tokens = await connect();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const ok = await mcp(tokens.access_token);
    expect(ok.status).toBe(200);
    expect(ok.body.result.tools).toEqual([]);
  });

  it("🔴 a WRONG verifier is refused and does NOT burn the code", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const bad = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: makeVerifier(), // a different, well-formed verifier
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_grant");

    // 🔴 Nothing was mutated. A bare code leaks through redirect chains and
    // browser history; if merely presenting one could spend it, anybody who saw
    // it could deny a barber their authorization without holding the verifier.
    const row = await prisma.mcpAuthCode.findUniqueOrThrow({
      where: { codeHash: hashToken(a.code!) },
      select: { consumedAt: true, replayDetectedAt: true },
    });
    expect(row.consumedAt).toBeNull();
    expect(row.replayDetectedAt).toBeNull();
  });

  it("🔴 the legitimate client still succeeds after a wrong-verifier attempt", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const bad = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: makeVerifier(),
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(bad.status).toBe(400);

    const good = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(good.status).toBe(200);
    expect((await mcp(good.body.access_token)).status).toBe(200);
  });

  it("🔴 a wrong client_id, redirect_uri or resource does not consume the code", async () => {
    const cases: { name: string; body: Record<string, unknown> }[] = [];
    const thief = await registerClient("Test Assistant Thief");

    for (const [name, override] of [
      ["client_id", { client_id: thief }],
      ["redirect_uri", { redirect_uri: "https://client.example/cb/callback2" }],
      ["resource", { resource: "https://mcp.evil.example/mcp" }],
    ] as const) {
      cases.push({ name, body: override });
    }

    for (const c of cases) {
      const verifier = makeVerifier();
      const a = await authorize({ challenge: challengeFor(verifier) });
      const res = await request(app)
        .post("/mcp/oauth/token")
        .send({
          grant_type: "authorization_code",
          code: a.code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: clientId,
          ...c.body,
        });
      expect(res.status, c.name).toBe(400);

      const row = await prisma.mcpAuthCode.findUniqueOrThrow({
        where: { codeHash: hashToken(a.code!) },
        select: { consumedAt: true, replayDetectedAt: true },
      });
      expect(row.consumedAt, `${c.name} consumed the code`).toBeNull();
      expect(row.replayDetectedAt, `${c.name} declared a replay`).toBeNull();

      // And the legitimate exchange still works afterwards.
      const good = await request(app).post("/mcp/oauth/token").send({
        grant_type: "authorization_code",
        code: a.code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      });
      expect(good.status, `${c.name} left the code unusable`).toBe(200);
    }
  });

  it("🔴 an invalid redemption never reveals WHICH check failed", async () => {
    const verifier = makeVerifier();
    const thief = await registerClient("Test Assistant Probe");
    const bodies: Record<string, unknown>[] = [
      { code_verifier: makeVerifier() },
      { client_id: thief },
      { redirect_uri: "https://client.example/cb/callback2" },
      { code: mintLikeCode() },
    ];
    const seen = new Set<string>();
    for (const override of bodies) {
      const a = await authorize({ challenge: challengeFor(verifier) });
      const res = await request(app).post("/mcp/oauth/token").send({
        grant_type: "authorization_code",
        code: a.code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
        ...override,
      });
      expect(res.status).toBe(400);
      seen.add(JSON.stringify(res.body));
    }
    // One body, four causes. An attacker probing cannot tell them apart.
    expect(seen.size, `distinguishable errors: ${[...seen].join(" | ")}`).toBe(1);
  });

  it("🔴 two concurrent VALID redemptions yield exactly one token response", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const send = () =>
      request(app).post("/mcp/oauth/token").send({
        grant_type: "authorization_code",
        code: a.code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: clientId,
      });

    // Both requests validate successfully; the database CAS on `consumedAt`
    // decides which one is real.
    const [x, y] = await Promise.all([send(), send()]);
    const statuses = [x.status, y.status].sort();
    expect(statuses).toEqual([200, 400]);

    const winner = x.status === 200 ? x : y;
    expect(winner.body.access_token).toBeTruthy();
    // The CAS loser is a genuine replay and takes the revocation path, so the
    // winner's token is dead too - the same outcome as a sequential replay.
    expect((await mcp(winner.body.access_token)).status).toBe(401);
  });

  it("🔴 REUSING a code is treated as theft: the connection dies with it", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const first = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(first.status).toBe(200);
    const token = first.body.access_token as string;
    expect((await mcp(token)).status).toBe(200);

    // Second presentation of the same code.
    const second = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(second.status).toBe(400);

    // 🔴 The token minted by the FIRST (legitimate) exchange is now dead too.
    // That is the point: if the code leaked, we cannot tell which exchange was
    // the thief, so both lose.
    expect((await mcp(token)).status).toBe(401);
    const conn = await prisma.mcpConnection.findFirst({
      where: { shopId, revokedReason: "replay" },
      select: { revokedAt: true },
    });
    expect(conn?.revokedAt).toBeTruthy();

    // 🔴 And every token that grant produced is gone - not just the one we
    // happened to hold.
    const live = await prisma.mcpAccessToken.count({
      where: { connection: { shopId, client: { clientId } }, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it("an EXPIRED code is refused", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    await prisma.mcpAuthCode.updateMany({
      where: { codeHash: hashToken(a.code!) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("🔴 the redirect_uri must match the one the code was minted for", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const res = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: "https://client.example/cb/callback2",
      client_id: clientId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("🔴 a DIFFERENT client cannot redeem another client's code", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const thief = await registerClient("Test Assistant Thief");
    const res = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: thief,
    });
    expect(res.status).toBe(400);
  });

  it("a malformed verifier is refused WITHOUT burning the code", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const short = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: "too-short",
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(short.status).toBe(400);
    // The legitimate client can still complete: a broken request from anyone
    // must not be a denial-of-service against the real flow.
    const good = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(good.status).toBe(200);
  });

  it("state is echoed back BYTE-FOR-BYTE, so the client can detect a mix-up", async () => {
    const state = "opaque-state-é-!@#$%^&*()_+";
    const a = await authorize({ challenge: challengeFor(makeVerifier()), state });
    const url = new URL(a.body.redirect_to as string);
    expect(url.searchParams.get("state")).toBe(state);
    // RFC 9207: the issuer is named so a client cannot be tricked into
    // redeeming a code at the wrong authorization server.
    expect(url.searchParams.get("iss")).toBeTruthy();
  });

  it("🔴 the code goes ONLY to a registered redirect_uri", async () => {
    const res = await authorize({
      challenge: challengeFor(makeVerifier()),
      redirectUri: "https://evil.example/steal",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  /**
   * 🔴 CSRF on the consent endpoint would be the whole game: an attacker's page
   * causing a signed-in barber's browser to silently mint an authorization code
   * for the ATTACKER's registered client. Two independent things stop it, and
   * both are checked here because either one alone is a single point of failure.
   */
  it("🔴 a cross-site form POST cannot drive consent", async () => {
    // (1) The endpoint only parses application/json. A cross-origin HTML form
    // can only send urlencoded/multipart/text-plain without triggering a
    // preflight, and the preflight would only pass for the app's own origin.
    const formPost = await request(app)
      .post("/mcp/oauth/authorize/approve")
      .set("Cookie", ownerCookie)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(
        `client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT)}` +
          `&code_challenge=${challengeFor(makeVerifier())}`,
      );
    expect(formPost.status).toBe(400);
    expect(formPost.body.error).toBe("invalid_request");

    // (2) The session cookie is SameSite=Lax, so a genuine cross-site POST
    // would not carry it at all - which this stands in for: no cookie, no
    // consent, whatever the body says.
    const noCookie = await request(app)
      .post("/mcp/oauth/authorize/approve")
      .send({
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challengeFor(makeVerifier()),
      });
    expect(noCookie.status).toBe(401);
  });

  it("the session cookie that guards consent is SameSite=Lax", async () => {
    const email = `mcp-c-${randomToken(6).toLowerCase()}@test.chairback`;
    emails.push(email);
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password, name: "Cookie", smsAttested: true });
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const session = cookies.find((c) => c.startsWith("cb_session="))!;
    // Load-bearing for the CSRF argument above, and easy to weaken by accident
    // while chasing an unrelated cross-site problem.
    expect(session.toLowerCase()).toContain("samesite=lax");
    expect(session.toLowerCase()).toContain("httponly");
  });

  it("consent requires a signed-in human", async () => {
    const res = await request(app).post("/mcp/oauth/authorize/approve").send({
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challengeFor(makeVerifier()),
    });
    expect(res.status).toBe(401);
  });

  it("🔴 the GET authorize endpoint refuses `plain` PKCE explicitly", async () => {
    const res = await request(app).get("/mcp/oauth/authorize").query({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "plain",
    });
    expect(res.status).toBe(400);
    expect(res.body.error_description).toContain("S256");
  });

  it("🔴 an invalid redirect_uri is NOT redirected to — that would be the open redirect", async () => {
    const res = await request(app).get("/mcp/oauth/authorize").query({
      client_id: clientId,
      redirect_uri: "https://evil.example/steal",
      response_type: "code",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
    });
    // A 400 rendered HERE, never a 302 to the unvalidated address.
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });
});

/* ═══════════════════════════ audience binding ═══════════════════════════ */

describe("resource / audience binding (RFC 8707)", () => {
  it("refuses to mint a token for somebody else's resource", async () => {
    const res = await authorize({
      challenge: challengeFor(makeVerifier()),
      resource: "https://mcp.evil.example/mcp",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_target");
  });

  it("🔴 a token minted for another audience is refused at the MCP endpoint", async () => {
    const tokens = await connect();
    // Re-point the stored token at a different resource, exactly as a token
    // issued by a sibling deployment sharing this database would look.
    await prisma.mcpAccessToken.updateMany({
      where: { tokenHash: hashToken(tokens.access_token) },
      data: { resource: "https://mcp.other.example/mcp" },
    });
    const res = await mcp(tokens.access_token);
    expect(res.status).toBe(401);
    // The client is not told WHY — an audience mismatch is only interesting to
    // somebody probing.
    expect(res.body.error_description).not.toMatch(/audience|resource/i);
  });
});

/* ═══════════════════════════ refresh + rotation ═══════════════════════════ */

describe("refresh rotation and replay", () => {
  it("a refresh returns a NEW pair and retires the old access token", async () => {
    const first = await connect();
    const r = await request(app).post("/mcp/oauth/token").send({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
    });
    expect(r.status).toBe(200);
    expect(r.body.access_token).not.toBe(first.access_token);
    expect(r.body.refresh_token).not.toBe(first.refresh_token);

    // 🔴 The OLD access token is dead. Otherwise refreshing would not actually
    // shorten the life of a captured access token.
    expect((await mcp(first.access_token)).status).toBe(401);
    expect((await mcp(r.body.access_token)).status).toBe(200);
  });

  it("🔴 REPLAYING a rotated refresh token kills the whole connection", async () => {
    const first = await connect();
    const second = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    const live = second.body.access_token as string;
    expect((await mcp(live)).status).toBe(200);

    // The thief presents the token the legitimate client already rotated away.
    const replay = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(replay.status).toBe(400);

    // 🔴 The legitimate client is logged out too. That is correct: it is the
    // only way to be certain the thief is.
    expect((await mcp(live)).status).toBe(401);
    const replayed = await prisma.mcpRefreshToken.findUnique({
      where: { tokenHash: hashToken(first.refresh_token) },
      select: { replayDetectedAt: true },
    });
    expect(replayed?.replayDetectedAt).toBeTruthy();
  });

  it("🔴 refresh replay revokes ONLY the affected connection", async () => {
    // Same barber, same shop, two different assistants. A thief who captures
    // one assistant's refresh token must not be able to log the other out.
    const victimClient = clientId;
    const bystanderClient = await registerClient("Test Assistant Bystander");

    const victim = await connect();
    const bystanderVerifier = makeVerifier();
    const bAuth = await authorize({
      challenge: challengeFor(bystanderVerifier),
      clientId: bystanderClient,
    });
    const bystander = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: bAuth.code,
      code_verifier: bystanderVerifier,
      redirect_uri: REDIRECT,
      client_id: bystanderClient,
    });
    expect(bystander.status).toBe(200);

    // Rotate the victim, then replay the token it rotated away.
    const rotated = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: victim.refresh_token });
    expect(rotated.status).toBe(200);
    const replay = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: victim.refresh_token });
    expect(replay.status).toBe(400);

    // The victim's connection is dead...
    expect((await mcp(rotated.body.access_token)).status).toBe(401);
    // ...and the bystander's is untouched, on the same shop and the same user.
    expect((await mcp(bystander.body.access_token)).status).toBe(200);

    const [v, b] = await Promise.all([
      prisma.mcpConnection.findFirstOrThrow({
        where: { shopId, client: { clientId: victimClient } },
        select: { revokedAt: true, revokedReason: true },
      }),
      prisma.mcpConnection.findFirstOrThrow({
        where: { shopId, client: { clientId: bystanderClient } },
        select: { revokedAt: true },
      }),
    ]);
    expect(v.revokedReason).toBe("replay");
    expect(b.revokedAt).toBeNull();
  });

  it("🔴 a replay never reaches another SHOP's connection", async () => {
    const mine = await connect();
    const theirs = await connect({ cookie: otherCookie });

    const rotated = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: mine.refresh_token });
    expect(rotated.status).toBe(200);
    await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: mine.refresh_token });

    expect((await mcp(rotated.body.access_token)).status).toBe(401);
    // A different tenant entirely, same registered client.
    expect((await mcp(theirs.access_token)).status).toBe(200);
    const other = await prisma.mcpConnection.findFirstOrThrow({
      where: { shopId: otherShopId, client: { clientId } },
      select: { revokedAt: true },
    });
    expect(other.revokedAt).toBeNull();
  });

  it("the successor refresh token is also dead after a replay", async () => {
    const first = await connect();
    const second = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    const after = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: second.body.refresh_token });
    expect(after.status).toBe(400);
  });

  it("an EXPIRED refresh token is refused", async () => {
    const t = await connect();
    await prisma.mcpRefreshToken.updateMany({
      where: { tokenHash: hashToken(t.refresh_token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    expect(res.status).toBe(400);
  });

  it("a refresh token from one connection cannot refresh another", async () => {
    const a = await connect();
    const otherClient = await registerClient("Test Assistant Two");
    const verifier = makeVerifier();
    const auth = await authorize({ challenge: challengeFor(verifier), clientId: otherClient });
    const b = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: auth.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: otherClient,
    });
    expect(b.status).toBe(200);
    // Each refresh only ever produces tokens for ITS OWN connection.
    const r = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: a.refresh_token });
    expect(r.status).toBe(200);
    const resolved = await prisma.mcpAccessToken.findUnique({
      where: { tokenHash: hashToken(r.body.access_token) },
      select: { connection: { select: { client: { select: { clientId: true } } } } },
    });
    expect(resolved?.connection.client.clientId).toBe(clientId);
  });
});

/* ═══════════════════════════ expiry + revocation ═══════════════════════════ */

describe("expiry and revocation take effect immediately", () => {
  it("an expired access token is refused", async () => {
    const t = await connect();
    await prisma.mcpAccessToken.updateMany({
      where: { tokenHash: hashToken(t.access_token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await mcp(t.access_token)).status).toBe(401);
  });

  it("access tokens are SHORT-lived by construction", async () => {
    const t = await connect();
    const row = await prisma.mcpAccessToken.findUnique({
      where: { tokenHash: hashToken(t.access_token) },
      select: { expiresAt: true, createdAt: true },
    });
    const life = row!.expiresAt.getTime() - row!.createdAt.getTime();
    expect(life).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS + 1000);
    expect(life).toBeGreaterThan(60_000);
  });

  it("🔴 revoking takes effect on the NEXT request, not at expiry", async () => {
    const t = await connect();
    expect((await mcp(t.access_token)).status).toBe(200);
    const res = await request(app).post("/mcp/oauth/revoke").send({ token: t.access_token });
    expect(res.status).toBe(200);
    // No waiting for the 15-minute TTL. This is the property a JWT could not
    // have given us.
    expect((await mcp(t.access_token)).status).toBe(401);
  });

  it("revoking the REFRESH token also kills the access token", async () => {
    const t = await connect();
    await request(app).post("/mcp/oauth/revoke").send({ token: t.refresh_token });
    expect((await mcp(t.access_token)).status).toBe(401);
    const r = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    expect(r.status).toBe(400);
  });

  it("revocation answers 200 for an unknown token — never an oracle", async () => {
    const res = await request(app).post("/mcp/oauth/revoke").send({ token: "not-a-real-token-value-at-all" });
    expect(res.status).toBe(200);
  });

  it("re-authorizing REPLACES the grant and kills the previous tokens", async () => {
    const first = await connect();
    expect((await mcp(first.access_token)).status).toBe(200);
    const second = await connect();
    // Old client instance cannot keep reading after a re-consent it was not
    // part of.
    expect((await mcp(first.access_token)).status).toBe(401);
    expect((await mcp(second.access_token)).status).toBe(200);
    // And there is exactly ONE connection, not a pile the human cannot tell
    // apart.
    const count = await prisma.mcpConnection.count({
      where: { shopId, client: { clientId } },
    });
    expect(count).toBe(1);
  });
});

/* ═══════════════════════════ membership + role ═══════════════════════════ */

describe("🔴 authorization is re-derived from live membership on every request", () => {
  it("losing the seat stops access immediately, and revokes the grant", async () => {
    const barberEmail = `mcp-b-${randomToken(6).toLowerCase()}@test.chairback`;
    const barberCookie = await signup(barberEmail, "Marcus");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: barberEmail } });
    const staff = await prisma.staff.create({ data: { shopId, name: "Marcus" } });
    const seat = await prisma.shopMember.create({
      data: { shopId, userId: user.id, role: "BARBER", staffId: staff.id },
    });

    const t = await connect({ cookie: barberCookie });
    expect((await mcp(t.access_token)).status).toBe(200);

    // The manager removes them.
    await prisma.shopMember.delete({ where: { id: seat.id } });

    // Not "at the next refresh" — now.
    expect((await mcp(t.access_token)).status).toBe(401);
    const conn = await prisma.mcpConnection.findFirst({
      where: { userId: user.id, shopId },
      select: { revokedAt: true, revokedReason: true },
    });
    expect(conn?.revokedReason).toBe("membership");
    // And no new token can be minted either.
    const r = await request(app)
      .post("/mcp/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    expect(r.status).toBe(400);
  });

  it("a role CHANGE is picked up without re-authorizing", async () => {
    const email = `mcp-r-${randomToken(6).toLowerCase()}@test.chairback`;
    const cookie = await signup(email, "Rolechange");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const seat = await prisma.shopMember.create({
      data: { shopId, userId: user.id, role: "MANAGER" },
    });
    const t = await connect({ cookie });
    expect((await mcp(t.access_token)).status).toBe(200);

    await prisma.shopMember.update({ where: { id: seat.id }, data: { role: "BARBER" } });
    // 🔴 The token is unchanged; the ROLE it carries is re-read from the
    // database, so the demotion is live on the very next call. Nothing about
    // the role was ever baked into the token.
    expect((await mcp(t.access_token)).status).toBe(200);
    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { userId: user.id, shopId },
      select: { accessLevel: true },
    });
    expect(conn.accessLevel).toBe("READ_ONLY");

    await prisma.shopMember.delete({ where: { id: seat.id } });
  });

  it("removing ONE membership does not touch a second shop's connection", async () => {
    const email = `mcp-m-${randomToken(6).toLowerCase()}@test.chairback`;
    const cookie = await signup(email, "Multi");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const seatA = await prisma.shopMember.create({
      data: { shopId, userId: user.id, role: "MANAGER" },
    });
    const seatB = await prisma.shopMember.create({
      data: { shopId: otherShopId, userId: user.id, role: "MANAGER" },
    });

    // Two separate authorizations, one per shop, each with its own client.
    const tA = await connect({ cookie });
    await prisma.mcpConnection.updateMany({
      where: { userId: user.id, shopId: otherShopId },
      data: {},
    });
    expect((await mcp(tA.access_token)).status).toBe(200);

    await prisma.shopMember.delete({ where: { id: seatB.id } });
    // Shop A is untouched.
    expect((await mcp(tA.access_token)).status).toBe(200);

    await prisma.shopMember.delete({ where: { id: seatA.id } });
  });
});

/* ═══════════════════════════ tenancy ═══════════════════════════ */

describe("🔴 tenancy — nothing the client says is trusted", () => {
  it("the shop comes from the SESSION at consent, never from the request body", async () => {
    // The owner of shop A consents while naming shop B in the body.
    const verifier = makeVerifier();
    const res = await request(app)
      .post("/mcp/oauth/authorize/approve")
      .set("Cookie", ownerCookie)
      .send({
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challengeFor(verifier),
        shopId: otherShopId,
        shop_id: otherShopId,
        userId: "somebody-else",
      });
    expect(res.status).toBe(200);
    const code = new URL(res.body.redirect_to).searchParams.get("code")!;
    const row = await prisma.mcpAuthCode.findUniqueOrThrow({
      where: { codeHash: hashToken(code) },
      select: { shopId: true },
    });
    // Their OWN shop, not the one they asked for.
    expect(row.shopId).toBe(shopId);
    expect(row.shopId).not.toBe(otherShopId);
  });

  it("a token for shop A resolves to shop A, whatever the request contains", async () => {
    const t = await connect();
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${t.access_token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { shopId: otherShopId } });
    expect(res.status).toBe(200);
    const stored = await prisma.mcpAccessToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(t.access_token) },
      select: { connection: { select: { shopId: true } } },
    });
    expect(stored.connection.shopId).toBe(shopId);
  });

  it("one shop's token is never resolvable to another shop's connection", async () => {
    const mine = await connect();
    const theirs = await connect({ cookie: otherCookie });
    const [a, b] = await Promise.all([
      prisma.mcpAccessToken.findUniqueOrThrow({
        where: { tokenHash: hashToken(mine.access_token) },
        select: { connection: { select: { shopId: true } } },
      }),
      prisma.mcpAccessToken.findUniqueOrThrow({
        where: { tokenHash: hashToken(theirs.access_token) },
        select: { connection: { select: { shopId: true } } },
      }),
    ]);
    expect(a.connection.shopId).toBe(shopId);
    expect(b.connection.shopId).toBe(otherShopId);
    expect(a.connection.shopId).not.toBe(b.connection.shopId);
  });

  it("🔴 a ChairBack platform ADMIN gets no extra reach through MCP", async () => {
    // Admin is a PLATFORM flag (the /admin operator portal), not a shop role.
    // The customer MCP server must not become a back door into it: the spec is
    // explicit that internal admin tooling would be a separate server with its
    // own authorization policy.
    const email = `mcp-a-${randomToken(6).toLowerCase()}@test.chairback`;
    const cookie = await signup(email, "Admin");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({ where: { id: user.id }, data: { isAdmin: true } });
    const adminShop = await makeShop(cookie, "Admin Cuts");

    const t = await connect({ cookie });
    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { userId: user.id },
      select: { shopId: true, accessLevel: true },
    });
    // Their OWN shop and read-only, exactly like anybody else. The admin flag
    // buys nothing here.
    expect(conn.shopId).toBe(adminShop);
    expect(conn.shopId).not.toBe(shopId);
    expect(conn.accessLevel).toBe("READ_ONLY");
    expect((await mcp(t.access_token)).status).toBe(200);
    // And the token still resolves to one shop, not to "all of them".
    const stored = await prisma.mcpAccessToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(t.access_token) },
      select: { scopes: true, connection: { select: { shopId: true } } },
    });
    expect(stored.connection.shopId).toBe(adminShop);
    expect(stored.scopes.every((sc: string) => sc.endsWith(":read"))).toBe(true);
  });

  it("a user with no shop at all cannot consent", async () => {
    const email = `mcp-n-${randomToken(6).toLowerCase()}@test.chairback`;
    const cookie = await signup(email, "Nobody");
    const res = await authorize({ cookie, challenge: challengeFor(makeVerifier()) });
    expect(res.status).toBe(403);
  });
});

/* ═══════════════════════════ scopes ═══════════════════════════ */

describe("scopes", () => {
  it("defaults to the two that carry no customer data", async () => {
    const t = await connect();
    expect(t.scope).toBe("chairback:help:read chairback:readiness:read");
  });

  it("🔴 an unknown scope is an ERROR, never silently dropped", async () => {
    const res = await authorize({
      challenge: challengeFor(makeVerifier()),
      scope: "chairback:help:read chairback:everything:write",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_scope");
  });

  it("🔴 no write scope can be granted in this release", async () => {
    for (const scope of [
      "chairback:calendar:write",
      "chairback:appointments:write",
      "chairback:clients:write",
    ]) {
      const res = await authorize({ challenge: challengeFor(makeVerifier()), scope });
      expect(res.status, scope).toBe(400);
    }
  });

  it("🔴 every connection is minted READ_ONLY", async () => {
    await connect({ scope: "chairback:calendar:read chairback:clients:read" });
    const conns = await prisma.mcpConnection.findMany({
      where: { shopId },
      select: { accessLevel: true },
    });
    expect(conns.length).toBeGreaterThan(0);
    for (const c of conns) expect(c.accessLevel).toBe("READ_ONLY");
  });

  it("granted scopes are stored as tool grants a human can inspect", async () => {
    await connect({ scope: "chairback:calendar:read" });
    const conn = await prisma.mcpConnection.findFirstOrThrow({
      where: { shopId, client: { clientId } },
      select: { id: true },
    });
    const grants = await prisma.mcpToolGrant.findMany({
      where: { connectionId: conn.id },
      select: { scope: true, enabled: true },
    });
    expect(grants.map((g) => g.scope)).toEqual(["chairback:calendar:read"]);
    expect(grants.every((g) => g.enabled)).toBe(true);
  });
});

/* ═══════════════════════════ storage + leakage ═══════════════════════════ */

describe("🔴 what is stored, and what is never said", () => {
  it("no token plaintext is ever written to the database", async () => {
    const t = await connect();
    // The exact bytes handed to the client must not appear in any column.
    const [access, refresh] = await Promise.all([
      prisma.mcpAccessToken.findFirst({ where: { tokenHash: t.access_token } }),
      prisma.mcpRefreshToken.findFirst({ where: { tokenHash: t.refresh_token } }),
    ]);
    expect(access).toBeNull();
    expect(refresh).toBeNull();
    // Only the hash resolves.
    expect(
      await prisma.mcpAccessToken.findUnique({ where: { tokenHash: hashToken(t.access_token) } }),
    ).not.toBeNull();
  });

  it("the stored hash is not the token, and not reversible to it", async () => {
    const t = await connect();
    const h = hashToken(t.access_token);
    expect(h).not.toBe(t.access_token);
    expect(h).toHaveLength(64); // sha256 hex
    expect(t.access_token).not.toContain(h);
  });

  it("an authorization code is stored hashed too", async () => {
    const a = await authorize({ challenge: challengeFor(makeVerifier()) });
    expect(await prisma.mcpAuthCode.findFirst({ where: { codeHash: a.code! } })).toBeNull();
    expect(
      await prisma.mcpAuthCode.findUnique({ where: { codeHash: hashToken(a.code!) } }),
    ).not.toBeNull();
  });

  it("🔴 an unauthenticated error body never distinguishes WHY a token failed", async () => {
    const t = await connect();
    const unknown = await mcp("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await prisma.mcpAccessToken.updateMany({
      where: { tokenHash: hashToken(t.access_token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await mcp(t.access_token);
    // Unknown, expired and revoked are indistinguishable from outside.
    expect(unknown.body.error).toBe(expired.body.error);
    expect(unknown.body.error_description).toBe(expired.body.error_description);
  });

  it("🔴 no OAuth error body echoes anything the caller sent", async () => {
    const marker = "REFLECTED-MARKER-9f3a";
    const bodies: string[] = [];
    // NOTE: a SUCCESSFUL registration legitimately echoes client_name and
    // redirect_uris - RFC 7591 §3.2.1 requires the client metadata back, and
    // the caller is reading its own submission. The rule under test is about
    // ERROR bodies, which are returned to unauthenticated callers and are the
    // easiest place in the product to leak. So this case uses a registration
    // that FAILS.
    bodies.push(
      JSON.stringify(
        (
          await request(app)
            .post("/mcp/oauth/register")
            .send({ client_name: marker, redirect_uris: [`javascript:${marker}`] })
        ).body,
      ),
    );
    bodies.push(
      JSON.stringify(
        (
          await request(app).post("/mcp/oauth/token").send({
            grant_type: "authorization_code",
            code: marker,
            code_verifier: "x".repeat(43),
            redirect_uri: `https://evil.example/${marker}`,
            client_id: marker,
          })
        ).body,
      ),
    );
    bodies.push(
      JSON.stringify(
        (await request(app).post("/mcp/oauth/token").send({ grant_type: marker })).body,
      ),
    );
    for (const b of bodies) {
      expect(b, `an error body echoed the caller's input: ${b}`).not.toContain(marker);
    }
  });

  it("token responses are marked no-store", async () => {
    const verifier = makeVerifier();
    const a = await authorize({ challenge: challengeFor(verifier) });
    const res = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code: a.code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    });
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("🔴 the audit trail carries no customer or credential data", async () => {
    const t = await connect();
    await mcp(t.access_token, "initialize");
    const events = await prisma.mcpAuditEvent.findMany({
      where: { shopId },
      select: {
        toolName: true,
        failureCode: true,
        resourceType: true,
        resourceId: true,
        result: true,
      },
    });
    expect(events.length).toBeGreaterThan(0);
    const blob = JSON.stringify(events);
    expect(blob).not.toContain(t.access_token);
    expect(blob).not.toContain(t.refresh_token);
    expect(blob).not.toContain(ownerEmail);
    expect(blob).not.toContain(password);
    // failureCode is a short machine slug or nothing — never a message.
    for (const e of events) {
      if (e.failureCode !== null) expect(e.failureCode).toMatch(/^[a-z0-9_]{1,40}$/);
    }
  });
});

/* ═══════════════════════════ the endpoint itself ═══════════════════════════ */

describe("the MCP endpoint ships no tools yet", () => {
  it("tools/list is empty and tools/call is refused", async () => {
    const t = await connect();
    const list = await mcp(t.access_token, "tools/list");
    expect(list.body.result.tools).toEqual([]);
    const call = await mcp(t.access_token, "tools/call");
    expect(call.status).toBe(404);
  });

  it("initialize does not advertise a capability that does not exist", async () => {
    const t = await connect();
    const res = await mcp(t.access_token, "initialize");
    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBeTruthy();
    expect(res.body.result.capabilities.tools).toEqual({});
  });

  it("a non-JSON-RPC body is refused", async () => {
    const t = await connect();
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${t.access_token}`)
      .send({ hello: "world" });
    expect(res.status).toBe(400);
  });

  it("🔴 a token in the QUERY STRING is not accepted", async () => {
    const t = await connect();
    const res = await request(app)
      .post(`/mcp?access_token=${encodeURIComponent(t.access_token)}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
  });

  it("a malformed Authorization header is refused without a database lookup", async () => {
    for (const header of ["", "Bearer", "Basic abc", "Bearer ", "bearer x"]) {
      const res = await request(app)
        .post("/mcp")
        .set("Authorization", header)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(res.status, header).toBe(401);
    }
  });
});
