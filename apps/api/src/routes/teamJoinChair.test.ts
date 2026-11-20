import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * Accepting an invitation always ends with somewhere to be booked.
 *
 * The invitation told a new team member they would get their own place on the
 * booking page. When the owner had not picked one, the seat was created with
 * none, and the person who accepted opened a screen telling them to ask the
 * owner to link them. Now a BARBER seat that arrives with nothing gets one made
 * in the same transaction (services/memberChair.ts).
 *
 *  - no pick -> one made, named after them, theirs, offered the shop's
 *    "everyone" services;
 *  - a pick -> that one, and nothing extra made;
 *  - a pick someone else claimed meanwhile -> their own, not none;
 *  - a MANAGER -> none (they may not take appointments at all);
 *  - an account whose name is an email address -> never published as a name;
 *  - 🔴 two accepts at once -> one seat, one made, the loser told the link is spent.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
let lastInviteToken: string | null = null;

async function signup(email: string, name: string): Promise<{ cookie: string; userId: string }> {
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}

let ownerCookie: string;
let shopId: string;
let offeredByAllServiceId: string;

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    const m = /token=([^\s&]+)/.exec(input.text);
    lastInviteToken = m ? decodeURIComponent(m[1]!) : null;
    return { id: "TEST", status: "sent" as const };
  });
  ownerCookie = (await signup(`jc-owner-${randomToken(6).toLowerCase()}@test.chairback`, "Owner")).cookie;
  await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Join Cuts", smsAttested: true });
  shopId = (await request(app).get("/api/shops/me").set("Cookie", ownerCookie)).body.id as string;
  expect((await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ bookingMode: "native" })).status).toBe(200);
  // A service everyone offers, on the menu before anyone joins.
  const svc = await request(app)
    .post("/api/booking/services/bulk")
    .set("Cookie", ownerCookie)
    .send({ services: [{ name: "Taper", durationMin: 30, price: 40 }] });
  expect(svc.status).toBe(201);
  offeredByAllServiceId = (await prisma.service.findFirstOrThrow({ where: { shopId }, select: { id: true } })).id;
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
});

/** Invite an address, sign that person up, and hand back what they need to accept. */
async function invited(opts: { role?: "BARBER" | "MANAGER"; staffId?: string; name?: string } = {}) {
  const email = `jc-${randomToken(6).toLowerCase()}@test.chairback`;
  const res = await request(app)
    .post("/api/team/invites")
    .set("Cookie", ownerCookie)
    .send({ email, role: opts.role ?? "BARBER", ...(opts.staffId ? { staffId: opts.staffId } : {}) });
  expect(res.status).toBe(201);
  const token = lastInviteToken!;
  const person = await signup(email, opts.name ?? "Dee Fields");
  return { email, token, ...person };
}

const accept = (token: string, cookie: string) => request(app).post("/api/team/join").set("Cookie", cookie).send({ token });
const seatOf = (userId: string) => prisma.shopMember.findFirstOrThrow({ where: { shopId, userId }, select: { role: true, staffId: true } });
const staffCount = () => prisma.staff.count({ where: { shopId } });
async function newStaff(name: string): Promise<string> {
  const res = await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("accepting an invitation as someone who takes appointments", () => {
  it("🔴 no pick: one is made for them - named after them, theirs, and offered the shop's services", async () => {
    const before = await staffCount();
    const p = await invited({ name: "Dee Fields" });
    expect((await accept(p.token, p.cookie)).status).toBe(201);

    const seat = await seatOf(p.userId);
    expect(seat.role).toBe("BARBER");
    expect(seat.staffId).not.toBeNull();
    expect(await staffCount()).toBe(before + 1);
    const made = await prisma.staff.findUniqueOrThrow({ where: { id: seat.staffId! } });
    expect(made).toMatchObject({ shopId, name: "Dee Fields", active: true, userId: p.userId });
    // Bookable for what the shop already offers, without the owner doing anything.
    expect(await prisma.serviceStaff.count({ where: { shopId, staffId: made.id, serviceId: offeredByAllServiceId } })).toBe(1);
  });

  it("a pick: that one is theirs, and nothing extra is made", async () => {
    const picked = await newStaff("Kai");
    const before = await staffCount();
    const p = await invited({ staffId: picked });
    expect((await accept(p.token, p.cookie)).status).toBe(201);
    expect((await seatOf(p.userId)).staffId).toBe(picked);
    expect(await staffCount()).toBe(before);
    expect((await prisma.staff.findUniqueOrThrow({ where: { id: picked } })).userId).toBe(p.userId);
  });

  it("🔴 a pick someone else claimed meanwhile: they get their own, not nothing", async () => {
    const picked = await newStaff("Lee");
    const p = await invited({ staffId: picked, name: "Sam Reyes" });
    // Between the invitation and the accept, the owner links it to someone else.
    const other = await signup(`jc-other-${randomToken(6).toLowerCase()}@test.chairback`, "Other");
    await prisma.shopMember.create({ data: { shopId, userId: other.userId, role: "BARBER", staffId: picked } });

    expect((await accept(p.token, p.cookie)).status).toBe(201);
    const seat = await seatOf(p.userId);
    expect(seat.staffId).not.toBeNull();
    expect(seat.staffId).not.toBe(picked);
    expect((await prisma.staff.findUniqueOrThrow({ where: { id: seat.staffId! } })).name).toBe("Sam Reyes");
    // The other person's link is untouched.
    expect((await seatOf(other.userId)).staffId).toBe(picked);
  });

  it("an account whose name is an email address never has it published as a name", async () => {
    const p = await invited({ name: "relay-abc@privaterelay.appleid.com" });
    expect((await accept(p.token, p.cookie)).status).toBe(201);
    const made = await prisma.staff.findUniqueOrThrow({ where: { id: (await seatOf(p.userId)).staffId! } });
    expect(made.name).not.toContain("@");
    expect(made.name).toMatch(/^New /);
  });
});

describe("accepting as a manager", () => {
  it("🔴 gets the seat and nothing on the booking page", async () => {
    const before = await staffCount();
    const p = await invited({ role: "MANAGER" });
    expect((await accept(p.token, p.cookie)).status).toBe(201);
    expect(await seatOf(p.userId)).toEqual({ role: "MANAGER", staffId: null });
    expect(await staffCount()).toBe(before);
  });
});

describe("two accepts at once", () => {
  it("🔴 one seat and one made; the loser is told the link is spent", async () => {
    const before = await staffCount();
    const p = await invited({ name: "Twice Tapped" });
    const invite = await prisma.teamInvite.findFirstOrThrow({ where: { shopId, email: p.email }, select: { id: true } });

    // Both read the invitation as pending (a plain read does not wait on the
    // row lock), then both queue at the claim. Released, the claim's own
    // "still pending" condition is the only thing between one seat and two.
    const { results, settledEarly } = await raceBehindRowLock("TeamInvite", invite.id, [
      () => accept(p.token, p.cookie),
      () => accept(p.token, p.cookie),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
    expect(statuses).toEqual([201, 410]);

    expect(await prisma.shopMember.count({ where: { shopId, userId: p.userId } })).toBe(1);
    expect(await staffCount()).toBe(before + 1);
    expect(await prisma.staff.count({ where: { shopId, name: "Twice Tapped" } })).toBe(1);
  });
});
