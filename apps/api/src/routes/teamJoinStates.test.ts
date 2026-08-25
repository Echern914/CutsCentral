import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * Why an invitation stopped working - and who is allowed to be told.
 *
 * The preview used to answer one opaque 410 for expired, revoked, already-used
 * and never-existed alike. That was the right instinct (an endpoint must not
 * become a probe for which invitations exist) applied one step too far: the
 * invited barber, holding the link and signed in as the address it was sent to,
 * got a shrug. "Ask for a new one" is a different action from "you already
 * joined", and they could not tell which they were in.
 *
 * So the reason is disclosed only when the caller has BOTH the 32-byte token
 * AND a session as the invited address - at which point they are the invitee
 * and learn nothing they didn't bring with them. These tests pin both halves.
 */
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];
let lastInviteToken: string | null = null;

async function signup(email: string, name = "Person"): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

let ownerCookie: string;
let shopId: string;

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    const m = /token=([^\s&]+)/.exec(input.text);
    lastInviteToken = m ? decodeURIComponent(m[1]!) : null;
    return { id: "TEST", status: "sent" as const };
  });

  ownerCookie = await signup(`owner-${randomToken(6).toLowerCase()}@test.chairback`, "Owner");
  await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Reason Cuts", smsAttested: true });
  const me = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
  shopId = me.body.id as string;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

/** Invite a fresh barber and sign them up; returns their token + cookie. */
async function invitedBarber(): Promise<{ token: string; cookie: string; email: string }> {
  const email = `barber-${randomToken(6).toLowerCase()}@test.chairback`;
  const res = await request(app)
    .post("/api/team/invites")
    .set("Cookie", ownerCookie)
    .send({ email, role: "BARBER" });
  expect(res.status).toBe(201);
  const token = lastInviteToken!;
  const cookie = await signup(email, "Barber");
  return { token, cookie, email };
}

function preview(token: string, cookie: string) {
  return request(app).get("/api/team/join/preview").query({ token }).set("Cookie", cookie);
}

describe("the invited barber is told what happened", () => {
  it("says EXPIRED when the window has passed", async () => {
    const { token, cookie, email } = await invitedBarber();
    await prisma.teamInvite.updateMany({
      where: { shopId, email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await preview(token, cookie);
    expect(res.status).toBe(410);
    expect(res.body.reason).toBe("expired");
  });

  it("says REVOKED when the owner withdrew it", async () => {
    const { token, cookie, email } = await invitedBarber();
    await prisma.teamInvite.updateMany({
      where: { shopId, email },
      data: { revokedAt: new Date() },
    });

    const res = await preview(token, cookie);
    expect(res.status).toBe(410);
    expect(res.body.reason).toBe("revoked");
  });

  it("says USED after they have already joined", async () => {
    const { token, cookie } = await invitedBarber();
    const accepted = await request(app)
      .post("/api/team/join")
      .set("Cookie", cookie)
      .send({ token });
    expect(accepted.status).toBe(201);

    const res = await preview(token, cookie);
    expect(res.status).toBe(410);
    expect(res.body.reason).toBe("used");
  });
});

describe("nobody else is", () => {
  it("tells a signed-in stranger holding the token nothing", async () => {
    const { token, email } = await invitedBarber();
    await prisma.teamInvite.updateMany({
      where: { shopId, email },
      data: { revokedAt: new Date() },
    });
    const strangerCookie = await signup(
      `stranger-${randomToken(6).toLowerCase()}@test.chairback`,
    );

    const res = await preview(token, strangerCookie);
    expect(res.status).toBe(410);
    // Same status, no reason: they hold the link but the invitation is not
    // theirs, so the response must not describe its state.
    expect(res.body.reason).toBeUndefined();
  });

  it("tells nobody about a token that never existed", async () => {
    const { cookie } = await invitedBarber();
    const res = await preview(randomToken(), cookie);
    expect(res.status).toBe(410);
    expect(res.body.reason).toBeUndefined();
  });

  it("still refuses acceptance from the wrong signed-in address", async () => {
    const { token } = await invitedBarber();
    const strangerCookie = await signup(
      `wrong-${randomToken(6).toLowerCase()}@test.chairback`,
    );

    const res = await request(app)
      .post("/api/team/join")
      .set("Cookie", strangerCookie)
      .send({ token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("email_mismatch");
  });
});
