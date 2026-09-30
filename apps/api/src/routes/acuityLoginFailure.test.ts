import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { ACUITY, apiEnv, encrypt, randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { AcuityError, getAcuityClientForShop } from "../acuity/client.js";
import { createOAuthState, OAUTH_STATE_COOKIE } from "../acuity/oauth.js";
import { collectReadinessFacts } from "../services/readinessFacts.js";
import { integrationTools } from "../mcp/tools/integrations.js";
import { visitsWithoutLiveSource } from "../engines/syncedVisitTrust.js";

/**
 * An Acuity login that has quietly expired or been revoked used to count as
 * connected: the row stayed, so settings, readiness and the assistant all said
 * "connected" while nothing synced. Now a refusal is recorded on the row
 * (authFailedAt), shown as "Reconnect Acuity", and cleared by the next call
 * Acuity accepts or by reconnecting - without deleting the connection or
 * touching the booking mode. Acuity itself is a stub at the network edge.
 */

const app = createApp();
const key = apiEnv().TOKEN_ENCRYPTION_KEY;
const emails: string[] = [];
let cookie: string;
let shopId: string;

type Answer = (url: string) => Response;
let answer: Answer = () => new Response("[]", { status: 200 });
const fetchMock = vi.fn(async (input: string | URL | Request) =>
  answer(String(input instanceof Request ? input.url : input)),
);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const failedAt = async () =>
  (await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId } })).authFailedAt;
const client = () => getAcuityClientForShop(shopId);

beforeAll(async () => {
  const email = `acuitylogin-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Login Owner", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Login Test Shop", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
});

beforeEach(async () => {
  answer = () => new Response("[]", { status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  await prisma.acuityConnection.deleteMany({ where: { shopId } });
  await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: "acct_login_test", accessToken: encrypt("test-token", key) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("a refused login is recorded", () => {
  it("a 401 stamps it, and the connection, its token and the booking mode are kept", async () => {
    const before = await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId } });
    answer = () => new Response("{}", { status: 401 });
    await expect((await client()).listCalendars()).rejects.toBeInstanceOf(AcuityError);

    const after = await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId } });
    expect(after.authFailedAt).toBeInstanceOf(Date);
    expect(after.accessToken).toBe(before.accessToken);
    expect(after.acuityAccountId).toBe(before.acuityAccountId);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).bookingMode).toBe("native");
  });

  it("a 403 is recorded too", async () => {
    answer = () => new Response("{}", { status: 403 });
    await expect((await client()).listCalendars()).rejects.toBeInstanceOf(AcuityError);
    expect(await failedAt()).toBeInstanceOf(Date);
  });

  it("the first refusal keeps its time", async () => {
    answer = () => new Response("{}", { status: 401 });
    // Two clients opened before anything was refused - two jobs running at
    // once - each see a clean row, and each tries to stamp it.
    const [a, b] = [await client(), await client()];
    await expect(a.listCalendars()).rejects.toThrow();
    const first = await failedAt();
    expect(first).toBeInstanceOf(Date);
    await new Promise((r) => setTimeout(r, 20));
    await expect(b.listCalendars()).rejects.toThrow();
    expect(await failedAt()).toEqual(first);
  });

  it("an outage or a missing record is not a refused login", async () => {
    for (const status of [404, 429, 500, 503]) {
      answer = () => new Response("{}", { status });
      await expect((await client()).getAppointment("1")).rejects.toThrow();
    }
    expect(await failedAt()).toBeNull();
  });

  it("a write Acuity refuses is recorded the same way", async () => {
    answer = () => new Response("{}", { status: 401 });
    await expect(
      (await client()).createBlock({
        start: "2026-10-01T10:00:00-0400",
        end: "2026-10-01T10:30:00-0400",
        calendarID: "1",
        notes: "ref",
      }),
    ).rejects.toThrow();
    expect(await failedAt()).toBeInstanceOf(Date);
  });

  it("a refused token refresh is recorded; an outage at the token endpoint is not", async () => {
    await prisma.acuityConnection.update({
      where: { shopId },
      data: { refreshToken: encrypt("refresh-token", key) },
    });
    let tokenStatus = 503;
    answer = (url) =>
      url === ACUITY.tokenUrl
        ? new Response("{}", { status: tokenStatus })
        : new Response("{}", { status: 401 });

    await expect((await client()).listCalendars()).rejects.toThrow();
    expect(await failedAt()).toBeNull();

    tokenStatus = 400; // invalid_grant: the refresh token itself is gone
    await expect((await client()).listCalendars()).rejects.toThrow();
    expect(await failedAt()).toBeInstanceOf(Date);
  });
});

describe("clearing it", () => {
  it("the next call Acuity accepts clears it", async () => {
    await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: new Date() } });
    answer = () => json([{ id: 1, name: "Calendar" }]);
    await (await client()).listCalendars();
    expect(await failedAt()).toBeNull();
  });

  it("reconnecting clears it", async () => {
    await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: new Date() } });
    // The background history import is made to fail (a 500, which says nothing
    // about the login), so only the reconnect itself can have cleared it.
    let historyCalls = 0;
    answer = (url) => {
      if (url === ACUITY.tokenUrl) return json({ access_token: "fresh-access", token_type: "Bearer" });
      if (url === `${ACUITY.apiBase}/me`) return json({ id: "acct_login_test" });
      if (url === `${ACUITY.apiBase}/webhooks`) return json({ id: 1 });
      historyCalls++;
      return new Response("{}", { status: 500 });
    };
    const state = createOAuthState(shopId, Math.floor(Date.now() / 1000));
    const res = await request(app)
      .get(`/api/acuity/oauth/callback?code=fixture-code&state=${encodeURIComponent(state)}`)
      .set("Cookie", `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    expect(await failedAt()).toBeNull();
    // Let the background import hit the stub before it is taken away.
    for (let i = 0; i < 50 && historyCalls === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
  });
});

describe("reconnecting: same account vs a different one", () => {
  /** Reconnect as `accountId`; the background history import is stubbed away. */
  async function reconnectAs(accountId: string) {
    answer = (url) => {
      if (url === ACUITY.tokenUrl) return json({ access_token: "fresh-access", token_type: "Bearer" });
      if (url === `${ACUITY.apiBase}/me`) return json({ id: accountId });
      if (url === `${ACUITY.apiBase}/webhooks`) return json({ id: 1 });
      return new Response("{}", { status: 500 });
    };
    const state = createOAuthState(shopId, Math.floor(Date.now() / 1000));
    const res = await request(app)
      .get(`/api/acuity/oauth/callback?code=fixture-code&state=${encodeURIComponent(state)}`)
      .set("Cookie", `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    // Let the background import hit the stub before it is taken away.
    await new Promise((r) => setTimeout(r, 300));
  }
  const connectedAt = async () =>
    (await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId } })).connectedAt;
  const LONG_AGO = new Date("2026-01-01T00:00:00Z");

  it("the SAME account logging in again keeps its connection date - its calendars are still its own", async () => {
    await prisma.acuityConnection.update({ where: { shopId }, data: { connectedAt: LONG_AGO } });
    await reconnectAs("acct_login_test");
    expect((await connectedAt()).toISOString()).toBe(LONG_AGO.toISOString());
  });

  it("🔴 a DIFFERENT account restarts it, so chair mappings made on the old account read stale", async () => {
    await prisma.acuityConnection.update({ where: { shopId }, data: { connectedAt: LONG_AGO } });
    const before = Date.now();
    await reconnectAs("acct_someone_else");
    const row = await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId } });
    expect(row.acuityAccountId).toBe("acct_someone_else");
    expect(row.connectedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("what the owner sees", () => {
  it("settings: connected but needs reconnecting, not healthy, and no Repair offered", async () => {
    await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: new Date() } });
    await prisma.shop.update({ where: { id: shopId }, data: { acuityWebhookIds: [] } });
    const refused = await request(app).get("/api/acuity/oauth/status").set("Cookie", cookie);
    expect(refused.body).toMatchObject({
      connected: true,
      needsReconnect: true,
      liveSyncHealthy: false,
      needsRepair: false,
    });

    await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: null } });
    const fine = await request(app).get("/api/acuity/oauth/status").set("Cookie", cookie);
    expect(fine.body).toMatchObject({ connected: true, needsReconnect: false, needsRepair: true });
  });

  it("readiness: a shop booking in Acuity is not 'connected' while the login is refused", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "acuity" } });
    try {
      await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: new Date() } });
      const refused = (await collectReadinessFacts(shopId))!;
      expect(refused.acuityConnected).toBe(true);
      expect(refused.acuityAuthFailed).toBe(true);
      expect(refused.integrationConnected).toBe(false);

      await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: null } });
      const fine = (await collectReadinessFacts(shopId))!;
      expect(fine.acuityAuthFailed).toBe(false);
      expect(fine.integrationConnected).toBe(true);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
    }
  });

  it("the assistant is told the connection needs reconnecting", async () => {
    await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: new Date() } });
    await prisma.shop.update({ where: { id: shopId }, data: { acuityWebhookIds: ["1"] } });
    const r = await integrationTools[0]!.handler({
      args: {},
      shopId,
      userId: "u",
      role: "OWNER",
      chairFilterStaffId: null,
      hasAccess: true,
      now: new Date(),
    });
    expect(r.ok).toBe(true);
    const acuity = (r as { data: { acuity: Record<string, unknown> } }).data.acuity;
    expect(acuity).toMatchObject({ connected: true, needsReconnect: true, inboundSyncHealthy: false });
  });
});

describe("synced visits", () => {
  it("a visit whose Acuity login is refused can no longer be checked, until it works again", async () => {
    const visits = [{ id: "v1", shopId, acuityAppointmentId: "123456" }];
    await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: new Date() } });
    expect([...(await visitsWithoutLiveSource(visits))]).toEqual(["v1"]);

    await prisma.acuityConnection.update({ where: { shopId }, data: { authFailedAt: null } });
    expect([...(await visitsWithoutLiveSource(visits))]).toEqual([]);
  });
});
