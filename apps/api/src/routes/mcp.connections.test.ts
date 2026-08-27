import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The connection panel's API: what a barber can see, and the button that cuts
 * an assistant off.
 *
 * 🔴 THE LOAD-BEARING TEST IS "IMMEDIATELY". A disconnect that takes effect at
 * token expiry is not a disconnect - it is a promise to disconnect in up to
 * fifteen minutes, which is useless in the situation the button exists for.
 * Every revocation test here proves the NEXT request fails, using a token that
 * worked a moment earlier and has not expired.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
const REDIRECT = "https://panel.example/cb/callback";

let shopId: string;
let ownerCookie: string;
let ownerId: string;
let barberCookie: string;
let barberId: string;
let strangerCookie: string;
let otherShopId: string;

interface Seat {
  cookie: string;
  userId: string;
}

async function signup(label: string): Promise<Seat> {
  const email = `mcpc-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

/** A full OAuth round trip for a seat. Returns the live access token. */
async function connect(seat: Seat, name = "Panel Test Client"): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const reg = await request(app)
    .post("/mcp/oauth/register")
    .send({ client_name: name, redirect_uris: [REDIRECT] });
  const approve = await request(app)
    .post("/mcp/oauth/authorize/approve")
    .set("Cookie", seat.cookie)
    .send({
      client_id: reg.body.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      scope: "chairback:readiness:read",
    });
  expect(approve.status).toBe(200);
  const code = new URL(approve.body.redirect_to).searchParams.get("code")!;
  const tok = await request(app).post("/mcp/oauth/token").send({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: reg.body.client_id,
  });
  expect(tok.status).toBe(200);
  return tok.body.access_token as string;
}

/** Does this token still work? The only question that matters here. */
const mcpStatus = async (token: string): Promise<number> =>
  (
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  ).status;

const list = (cookie: string) =>
  request(app).get("/api/mcp/connections").set("Cookie", cookie);

beforeAll(async () => {
  const owner = await signup("owner");
  ownerCookie = owner.cookie;
  ownerId = owner.userId;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Panel Cuts", smsAttested: true });
  shopId = shop.body.id;

  const chair = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", ownerCookie)
    .send({ name: "Chair" });

  const barber = await signup("barber");
  barberCookie = barber.cookie;
  barberId = barber.userId;
  await prisma.shopMember.create({
    data: { shopId, userId: barberId, role: "BARBER", staffId: chair.body.id },
  });

  const stranger = await signup("stranger");
  strangerCookie = stranger.cookie;
  const other = await request(app)
    .post("/api/shops")
    .set("Cookie", strangerCookie)
    .send({ name: "Other Panel Cuts", smsAttested: true });
  otherShopId = other.body.id;
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.mcpClient.deleteMany({ where: { clientName: { contains: "Panel Test" } } });
});

describe("the connection list", () => {
  it("shows what to paste, and what it can read", async () => {
    const token = await connect({ cookie: ownerCookie, userId: ownerId });
    const res = await list(ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.entitled).toBe(true);
    // The URL shown is the one tokens are actually bound to.
    expect(res.body.connectUrl).toMatch(/\/mcp$/);
    expect(res.body.accessLevel).toBe("READ_ONLY");

    const mine = res.body.connections[0];
    expect(mine.clientName).toBe("Panel Test Client");
    expect(mine.mine).toBe(true);
    expect(mine.connectedBy).toBe("You");
    // Human words, the same ones the consent screen used.
    expect(mine.permissions[0]).toMatch(/setup progress/i);
    expect(await mcpStatus(token)).toBe(200);
  });

  it("🔴 never returns token material of any kind", async () => {
    await connect({ cookie: ownerCookie, userId: ownerId });
    const res = await list(ownerCookie);
    const raw = JSON.stringify(res.body);
    for (const key of ["tokenHash", "codeHash", "access_token", "refresh_token", "Bearer"]) {
      expect(raw).not.toContain(key);
    }
  });

  it("a barber sees their own connection and not a colleague's", async () => {
    await connect({ cookie: ownerCookie, userId: ownerId }, "Panel Test Owner Client");
    await connect({ cookie: barberCookie, userId: barberId }, "Panel Test Barber Client");

    const barberView = await list(barberCookie);
    expect(barberView.body.connections.every((c: { mine: boolean }) => c.mine)).toBe(true);
    expect(
      barberView.body.connections.some(
        (c: { clientName: string }) => c.clientName === "Panel Test Owner Client",
      ),
    ).toBe(false);
  });

  it("an owner sees the whole shop's connections, labelled", async () => {
    await connect({ cookie: barberCookie, userId: barberId }, "Panel Test Barber Client");
    const ownerView = await list(ownerCookie);
    const theirs = ownerView.body.connections.find((c: { mine: boolean }) => !c.mine);
    // The owner is accountable for the shop's data, so "an employee connected
    // an assistant and left" has to be visible and fixable.
    expect(theirs).toBeTruthy();
    expect(theirs.connectedBy).not.toBe("You");
  });

  it("another shop's owner sees none of it", async () => {
    await connect({ cookie: ownerCookie, userId: ownerId });
    const res = await list(strangerCookie);
    expect(res.status).toBe(200);
    expect(res.body.connections).toEqual([]);
    expect(otherShopId).not.toBe(shopId);
  });
});

describe("🔴 disconnect kills access immediately, not at expiry", () => {
  it("the next request with the same live token is refused", async () => {
    const token = await connect({ cookie: ownerCookie, userId: ownerId });
    expect(await mcpStatus(token)).toBe(200);

    const conns = await list(ownerCookie);
    const id = conns.body.connections[0].id;
    const del = await request(app)
      .delete(`/api/mcp/connections/${id}`)
      .set("Cookie", ownerCookie);
    expect(del.status).toBe(204);

    // 🔴 THE POINT. Same token, unexpired, one request later.
    expect(await mcpStatus(token)).toBe(401);
  });

  it("the refresh token dies with it, so it cannot be traded for a new one", async () => {
    // A disconnect that killed only the access token would be undone by the
    // client's next scheduled refresh.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const reg = await request(app)
      .post("/mcp/oauth/register")
      .send({ client_name: "Panel Test Refresh", redirect_uris: [REDIRECT] });
    const approve = await request(app)
      .post("/mcp/oauth/authorize/approve")
      .set("Cookie", ownerCookie)
      .send({
        client_id: reg.body.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        scope: "chairback:readiness:read",
      });
    const code = new URL(approve.body.redirect_to).searchParams.get("code")!;
    const tok = await request(app).post("/mcp/oauth/token").send({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: reg.body.client_id,
    });
    const refresh = tok.body.refresh_token as string;

    const conns = await list(ownerCookie);
    const id = conns.body.connections.find(
      (c: { clientName: string }) => c.clientName === "Panel Test Refresh",
    ).id;
    await request(app).delete(`/api/mcp/connections/${id}`).set("Cookie", ownerCookie);

    const retry = await request(app).post("/mcp/oauth/token").send({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: reg.body.client_id,
    });
    expect(retry.status).toBe(400);
  });

  it("disconnecting twice is a success both times", async () => {
    // The button gets clicked in a panic. A second click must not read as a
    // failure to disconnect.
    await connect({ cookie: ownerCookie, userId: ownerId });
    const id = (await list(ownerCookie)).body.connections[0].id;
    const first = await request(app)
      .delete(`/api/mcp/connections/${id}`)
      .set("Cookie", ownerCookie);
    const second = await request(app)
      .delete(`/api/mcp/connections/${id}`)
      .set("Cookie", ownerCookie);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it("a revoked connection leaves the list", async () => {
    const token = await connect({ cookie: ownerCookie, userId: ownerId });
    const id = (await list(ownerCookie)).body.connections[0].id;
    await request(app).delete(`/api/mcp/connections/${id}`).set("Cookie", ownerCookie);
    const after = await list(ownerCookie);
    expect(after.body.connections.some((c: { id: string }) => c.id === id)).toBe(false);
    expect(await mcpStatus(token)).toBe(401);
  });

  it("🔴 a barber cannot disconnect a colleague's assistant", async () => {
    const ownerToken = await connect({ cookie: ownerCookie, userId: ownerId });
    const id = (await list(ownerCookie)).body.connections.find(
      (c: { mine: boolean }) => c.mine,
    ).id;

    const attempt = await request(app)
      .delete(`/api/mcp/connections/${id}`)
      .set("Cookie", barberCookie);
    // 404 rather than 403: a status that only appears for other people's
    // connections would confirm one exists.
    expect(attempt.status).toBe(404);
    expect(await mcpStatus(ownerToken)).toBe(200);
  });

  it("🔴 another shop cannot disconnect ours, even with the real id", async () => {
    const token = await connect({ cookie: ownerCookie, userId: ownerId });
    const id = (await list(ownerCookie)).body.connections[0].id;
    const attempt = await request(app)
      .delete(`/api/mcp/connections/${id}`)
      .set("Cookie", strangerCookie);
    expect(attempt.status).toBe(404);
    expect(await mcpStatus(token)).toBe(200);
  });

  it("the revocation is audited", async () => {
    await connect({ cookie: ownerCookie, userId: ownerId });
    const id = (await list(ownerCookie)).body.connections[0].id;
    await request(app).delete(`/api/mcp/connections/${id}`).set("Cookie", ownerCookie);
    const row = await prisma.mcpAuditEvent.findFirst({
      where: { shopId, toolName: "connection.revoke", connectionId: id },
      orderBy: { createdAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row!.operationType).toBe("AUTH");
    expect(row!.result).toBe("OK");
  });
});

describe("🔴 removing someone from the shop kills their assistant", () => {
  it("the next request is refused, and the connection is marked", async () => {
    const seat = await signup("leaver");
    const chair = await request(app)
      .post("/api/booking/staff")
      .set("Cookie", ownerCookie)
      .send({ name: "Leaver chair" });
    const member = await prisma.shopMember.create({
      data: { shopId, userId: seat.userId, role: "BARBER", staffId: chair.body.id },
    });

    const token = await connect(seat, "Panel Test Leaver");
    expect(await mcpStatus(token)).toBe(200);

    // They leave the shop. Nothing touches the token.
    await prisma.shopMember.delete({ where: { id: member.id } });

    // 🔴 Refused on the very next call - the seat is re-read every request.
    expect(await mcpStatus(token)).toBe(401);

    const conn = await prisma.mcpConnection.findFirst({
      where: { shopId, userId: seat.userId },
      select: { revokedAt: true, revokedReason: true },
    });
    // Not merely refused: the grant is dead, so a revoked colleague's client
    // does not sit there retrying every fifteen minutes forever.
    expect(conn!.revokedAt).not.toBeNull();
    expect(conn!.revokedReason).toBe("membership");
  });
});
