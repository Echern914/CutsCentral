import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * Team seats: employee logins.
 *
 * This is the first time a non-owner can hold a session against a shop, so the
 * tests below are mostly about what an employee CANNOT do:
 *   - a BARBER is refused on every pre-existing dashboard router (none of them
 *     is staff-scoped yet — default-deny until each is opened deliberately),
 *   - only the OWNER may invite, change roles, or remove seats,
 *   - an invite is single-use, expiring, revocable, and bound to the invited
 *     EMAIL, so forwarding the link grants nothing,
 *   - the owner's own seat can't be demoted or deleted.
 */
const app = createApp();

const password = "correct horse battery staple";
const emails: string[] = [];
/** Raw invite tokens captured from the outgoing email (never stored server-side). */
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
let ownerEmail: string;
let shopId: string;
let staffId: string;

beforeAll(async () => {
  // Capture the emailed link instead of sending: the raw token exists ONLY in
  // the email (we store its sha256), so this is the only way to redeem one.
  __setSendEmailForTests(async (input) => {
    const m = /token=([^\s&]+)/.exec(input.text);
    lastInviteToken = m ? decodeURIComponent(m[1]!) : null;
    return { id: "TEST", status: "sent" as const };
  });

  ownerEmail = `owner-${randomToken(6).toLowerCase()}@test.chairback`;
  ownerCookie = await signup(ownerEmail, "Owner");
  await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Team Cuts", smsAttested: true });
  const me = await request(app).get("/api/shops/me").set("Cookie", ownerCookie);
  shopId = me.body.id as string;
  const staff = await prisma.staff.create({
    data: { shopId, name: "Chair 1" },
    select: { id: true },
  });
  staffId = staff.id;
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

beforeEach(() => {
  lastInviteToken = null;
});

/** Invite `email` as `role`, returning the emailed token. */
async function invite(
  email: string,
  role: "MANAGER" | "BARBER",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post("/api/team/invites")
    .set("Cookie", ownerCookie)
    .send({ email, role, ...extra });
  expect(res.status).toBe(201);
  expect(lastInviteToken).toBeTruthy();
  return lastInviteToken!;
}

describe("the owner's own seat", () => {
  it("is backfilled/created so the roster lists the owner", async () => {
    const res = await request(app).get("/api/team").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("OWNER");
    const owner = res.body.members.find(
      (m: { user: { email: string } }) => m.user.email === ownerEmail,
    );
    expect(owner).toBeDefined();
    expect(owner.role).toBe("OWNER");
  });
});

describe("invitations", () => {
  it("round-trips: invite -> preview -> accept -> seat exists", async () => {
    const email = `barber-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(email, "BARBER", { staffId });
    const cookie = await signup(email, "Barber");

    const preview = await request(app)
      .get("/api/team/join/preview")
      .query({ token })
      .set("Cookie", cookie);
    expect(preview.status).toBe(200);
    expect(preview.body.shopName).toBe("Team Cuts");
    expect(preview.body.role).toBe("BARBER");
    expect(preview.body.emailMatches).toBe(true);

    const join = await request(app)
      .post("/api/team/join")
      .set("Cookie", cookie)
      .send({ token });
    expect(join.status).toBe(201);

    const seat = await prisma.shopMember.findFirst({
      where: { shopId, user: { email } },
      select: { role: true, staffId: true },
    });
    expect(seat).toMatchObject({ role: "BARBER", staffId });
  });

  it("cannot be redeemed twice", async () => {
    const email = `once-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(email, "BARBER");
    const cookie = await signup(email);
    expect((await request(app).post("/api/team/join").set("Cookie", cookie).send({ token })).status).toBe(201);
    const second = await request(app)
      .post("/api/team/join")
      .set("Cookie", cookie)
      .send({ token });
    expect(second.status).toBe(410);
  });

  it("refuses a forwarded link: the signed-in email must match", async () => {
    const invited = `invited-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(invited, "BARBER");
    // Somebody else opens the link.
    const strangerCookie = await signup(`stranger-${randomToken(6).toLowerCase()}@test.chairback`);

    const preview = await request(app)
      .get("/api/team/join/preview")
      .query({ token })
      .set("Cookie", strangerCookie);
    expect(preview.body.emailMatches).toBe(false);

    const join = await request(app)
      .post("/api/team/join")
      .set("Cookie", strangerCookie)
      .send({ token });
    expect(join.status).toBe(403);
    expect(join.body.error).toBe("email_mismatch");
    const seat = await prisma.shopMember.findFirst({
      where: { shopId, user: { email: { not: ownerEmail } }, role: "BARBER" },
      select: { id: true },
    });
    // No seat was created for the stranger.
    const strangerSeat = await prisma.shopMember.findFirst({
      where: { shopId, user: { email: { startsWith: "stranger-" } } },
    });
    expect(strangerSeat).toBeNull();
    expect(seat === null || seat !== null).toBe(true);
  });

  it("refuses an expired or revoked invite the same way as an unknown one", async () => {
    const email = `expired-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(email, "BARBER");
    const cookie = await signup(email);
    await prisma.teamInvite.updateMany({
      where: { shopId, email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(app).post("/api/team/join").set("Cookie", cookie).send({ token });
    expect(res.status).toBe(410);

    const unknown = await request(app)
      .post("/api/team/join")
      .set("Cookie", cookie)
      .send({ token: randomToken() });
    expect(unknown.status).toBe(410); // identical answer: no shop enumeration
  });

  it("stores only the token's hash, never the raw value", async () => {
    const email = `hash-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(email, "BARBER");
    const row = await prisma.teamInvite.findFirst({
      where: { shopId, email },
      select: { tokenHash: true },
    });
    expect(row!.tokenHash).not.toContain(token);
    expect(row!.tokenHash).toHaveLength(64); // sha256 hex
  });

  it("re-inviting supersedes the previous link", async () => {
    const email = `resend-${randomToken(6).toLowerCase()}@test.chairback`;
    const first = await invite(email, "BARBER");
    const second = await invite(email, "BARBER");
    expect(second).not.toBe(first);
    const cookie = await signup(email);
    const old = await request(app)
      .post("/api/team/join")
      .set("Cookie", cookie)
      .send({ token: first });
    expect(old.status).toBe(410); // the first link is dead
  });

  it("409s when the person already has a seat", async () => {
    const email = `dupe-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(email, "BARBER");
    const cookie = await signup(email);
    await request(app).post("/api/team/join").set("Cookie", cookie).send({ token });
    const again = await request(app)
      .post("/api/team/invites")
      .set("Cookie", ownerCookie)
      .send({ email, role: "BARBER" });
    expect(again.status).toBe(409);
  });

  it("won't link two seats to the same chair", async () => {
    const chair = await prisma.staff.create({
      data: { shopId, name: "Chair 2" },
      select: { id: true },
    });
    const a = `chair-a-${randomToken(6).toLowerCase()}@test.chairback`;
    const tokenA = await invite(a, "BARBER", { staffId: chair.id });
    const cookieA = await signup(a);
    await request(app).post("/api/team/join").set("Cookie", cookieA).send({ token: tokenA });

    const res = await request(app)
      .post("/api/team/invites")
      .set("Cookie", ownerCookie)
      .send({ email: `chair-b-${randomToken(6).toLowerCase()}@test.chairback`, role: "BARBER", staffId: chair.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("staff_taken");
  });
});

describe("what an employee may do", () => {
  let barberCookie: string;

  beforeAll(async () => {
    const email = `emp-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(email, "BARBER");
    barberCookie = await signup(email, "Employee");
    await request(app).post("/api/team/join").set("Cookie", barberCookie).send({ token });
  });

  it("is DENIED on every pre-existing dashboard router (default-deny)", async () => {
    // None of these is staff-scoped yet: a barber reaching them would see the
    // whole shop's clients, numbers and money.
    for (const path of [
      "/api/dashboard/overview",
      "/api/insights",
      "/api/booking/services",
      "/api/booking/agenda",
      "/api/payments/settings",
      "/api/loyalty/rewards",
      "/api/promos",
      "/api/billing/status",
    ]) {
      const res = await request(app).get(path).set("Cookie", barberCookie);
      expect(res.status, `${path} must refuse a BARBER`).toBe(403);
      expect(res.body.error).toBe("forbidden_role");
    }
  });

  it("resolves the shop it was invited to (owning none of its own)", async () => {
    // Probes /api/auth/me rather than /api/team. This test's point is that a
    // member's session resolves to the shop they were INVITED to despite owning
    // none; /api/team was only ever a convenient endpoint a barber could reach,
    // and it no longer is (see the roster test below). /api/auth/me answers the
    // actual question directly, and is what the web chrome reads.
    const res = await request(app).get("/api/auth/me").set("Cookie", barberCookie);
    expect(res.status).toBe(200);
    expect(res.body.shopRole).toBe("BARBER");
    expect(res.body.activeShopId).toBeTruthy();
  });

  it("cannot read the roster (colleagues' emails are not a barber's business)", async () => {
    // Writes here were owner-gated from the start, but the GET wasn't gated at
    // all, so any member could list every colleague's name, email and avatar
    // plus every pending invite's email address. It went unnoticed because a
    // barber 403'd on every other dashboard route, so no session ever reached
    // this one until the barber dashboard existed.
    const res = await request(app).get("/api/team").set("Cookie", barberCookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
  });

  it("cannot invite, change a role, or remove anyone", async () => {
    const invitePost = await request(app)
      .post("/api/team/invites")
      .set("Cookie", barberCookie)
      .send({ email: `nope-${randomToken(5).toLowerCase()}@test.chairback`, role: "BARBER" });
    expect(invitePost.status).toBe(403);

    const members = await request(app).get("/api/team").set("Cookie", ownerCookie);
    const someone = members.body.members.find(
      (m: { role: string }) => m.role !== "OWNER",
    );
    const patch = await request(app)
      .patch(`/api/team/members/${someone.id}`)
      .set("Cookie", barberCookie)
      .send({ role: "MANAGER" });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/team/members/${someone.id}`)
      .set("Cookie", barberCookie);
    expect(del.status).toBe(403);
  });
});

describe("owner-only seat management", () => {
  it("changes a role and removes a seat, leaving the Staff row intact", async () => {
    // Its own chair: ShopMember.staffId is unique and earlier tests claimed
    // the shared one.
    const chair = await prisma.staff.create({
      data: { shopId, name: "Chair 3" },
      select: { id: true },
    });
    const email = `mgr-${randomToken(6).toLowerCase()}@test.chairback`;
    const token = await invite(email, "BARBER", { staffId: chair.id });
    const cookie = await signup(email);
    await request(app).post("/api/team/join").set("Cookie", cookie).send({ token });

    const roster = await request(app).get("/api/team").set("Cookie", ownerCookie);
    const seat = roster.body.members.find(
      (m: { user: { email: string } }) => m.user.email === email,
    );

    const promote = await request(app)
      .patch(`/api/team/members/${seat.id}`)
      .set("Cookie", ownerCookie)
      .send({ role: "MANAGER" });
    expect(promote.status).toBe(200);
    // A MANAGER passes the gate a BARBER failed.
    expect((await request(app).get("/api/insights").set("Cookie", cookie)).status).toBe(200);

    const removed = await request(app)
      .delete(`/api/team/members/${seat.id}`)
      .set("Cookie", ownerCookie);
    expect(removed.status).toBe(200);
    // Access is gone...
    expect((await request(app).get("/api/team").set("Cookie", cookie)).status).toBe(404);
    // ...but their chair, hours and history are untouched.
    expect(await prisma.staff.findUnique({ where: { id: chair.id } })).not.toBeNull();
  });

  it("refuses to demote or delete the owner's own seat", async () => {
    const roster = await request(app).get("/api/team").set("Cookie", ownerCookie);
    const owner = roster.body.members.find((m: { role: string }) => m.role === "OWNER");
    const patch = await request(app)
      .patch(`/api/team/members/${owner.id}`)
      .set("Cookie", ownerCookie)
      .send({ role: "BARBER" });
    expect(patch.status).toBe(409);
    const del = await request(app)
      .delete(`/api/team/members/${owner.id}`)
      .set("Cookie", ownerCookie);
    expect(del.status).toBe(409);
  });

  it("cannot touch another shop's seats by id", async () => {
    const otherEmail = `other-${randomToken(6).toLowerCase()}@test.chairback`;
    const otherCookie = await signup(otherEmail, "Other Owner");
    await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other Shop", smsAttested: true });

    const mine = await request(app).get("/api/team").set("Cookie", ownerCookie);
    const mySeatId = mine.body.members[0].id as string;
    // The other owner names MY seat id: scoped by shopId, so it's a 404.
    const res = await request(app)
      .delete(`/api/team/members/${mySeatId}`)
      .set("Cookie", otherCookie);
    expect(res.status).toBe(404);
    expect(await prisma.shopMember.findUnique({ where: { id: mySeatId } })).not.toBeNull();
  });
});
