import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The barber Walk-In surface: claiming is own-chair only, the chair comes
 * from the SEAT (never the request), and a seat with no chair can look but
 * not act.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

let ownerCookie: string;
let barberACookie: string; // seated on chair A
let barberBCookie: string; // seated on chair B
let noChairCookie: string; // BARBER seat, no staff link
let shopId: string;
let chairA: string;
let chairB: string;
let serviceId: string;

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
  };
}

let phoneSeq = 0;
async function makeEntry(): Promise<{ id: string; position: number }> {
  phoneSeq += 1;
  const res = await request(app)
    .post("/api/walk-ins")
    .set("Cookie", ownerCookie)
    .send({
      firstName: `Walk${phoneSeq}`,
      phone: `+1212555${String(3000 + phoneSeq).padStart(4, "0")}`,
      serviceIds: [serviceId],
    });
  expect(res.status).toBe(201);
  return res.body.entry;
}

beforeAll(async () => {
  process.env.WALK_IN_MODE_ENABLED = "true";
  __resetEnvCacheForTests();

  const owner = await signup("wb-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "WalkIn Barber Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", ownerCookie)
    .send({ bookingMode: "native", timezone: "UTC", walkInEnabled: true });

  chairA = (
    await request(app)
      .post("/api/booking/staff")
      .set("Cookie", ownerCookie)
      .send({ name: "Ava" })
  ).body.id;
  chairB = (
    await request(app)
      .post("/api/booking/staff")
      .set("Cookie", ownerCookie)
      .send({ name: "Ben" })
  ).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", ownerCookie)
      .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairA, chairB] })
  ).body.id;

  const bA = await signup("wb-barber-a");
  barberACookie = bA.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: bA.userId, role: "BARBER", staffId: chairA },
  });
  const bB = await signup("wb-barber-b");
  barberBCookie = bB.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: bB.userId, role: "BARBER", staffId: chairB },
  });
  const nc = await signup("wb-nochair");
  noChairCookie = nc.cookie;
  await prisma.shopMember.create({
    data: { shopId, userId: nc.userId, role: "BARBER", staffId: null },
  });
});

afterAll(async () => {
  delete process.env.WALK_IN_MODE_ENABLED;
  __resetEnvCacheForTests();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const shops = await prisma.shop.findMany({
        where: { ownerId: user.id },
        select: { id: true },
      });
      await prisma.walkInEvent.deleteMany({
        where: { shopId: { in: shops.map((s) => s.id) } },
      });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("read", () => {
  it("a barber sees the queue and which chair is theirs", async () => {
    await makeEntry();
    const res = await request(app)
      .get("/api/barber/walk-ins")
      .set("Cookie", barberACookie);
    expect(res.status).toBe(200);
    expect(res.body.chairStaffId).toBe(chairA);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries[0]!.estimate).toHaveProperty("waitMin");
  });

  it("the surface is dark behind the env flag here too", async () => {
    process.env.WALK_IN_MODE_ENABLED = "false";
    __resetEnvCacheForTests();
    const res = await request(app)
      .get("/api/barber/walk-ins")
      .set("Cookie", barberACookie);
    expect(res.status).toBe(404);
    process.env.WALK_IN_MODE_ENABLED = "true";
    __resetEnvCacheForTests();
  });
});

describe("claim", () => {
  it("a claim lands on the SEAT's chair - the request names no staffId", async () => {
    const e = await makeEntry();
    const res = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/claim`)
      .set("Cookie", barberACookie)
      .send({ staffId: chairB }); // ignored: the body is not consulted
    expect(res.status).toBe(200);
    expect(res.body.entry.assignedStaffId).toBe(chairA);
    expect(res.body.entry.status).toBe("ASSIGNED");
  });

  it("claiming an already-claimed customer is refused", async () => {
    const e = await makeEntry();
    await request(app)
      .post(`/api/barber/walk-ins/${e.id}/claim`)
      .set("Cookie", barberACookie);
    const res = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/claim`)
      .set("Cookie", barberBCookie);
    expect(res.status).toBe(409);
  });

  it("a seat with no linked chair can read but not act", async () => {
    const e = await makeEntry();
    const read = await request(app)
      .get("/api/barber/walk-ins")
      .set("Cookie", noChairCookie);
    expect(read.status).toBe(200);
    expect(read.body.chairStaffId).toBeNull();
    const act = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/claim`)
      .set("Cookie", noChairCookie);
    expect(act.status).toBe(403);
    expect(act.body.error).toBe("no_chair");
  });
});

describe("own-chair enforcement", () => {
  it("a barber cannot ready/return/no-show another chair's customer", async () => {
    const e = await makeEntry();
    await request(app)
      .post(`/api/barber/walk-ins/${e.id}/claim`)
      .set("Cookie", barberACookie);
    for (const action of ["ready", "return", "no-show"]) {
      const res = await request(app)
        .post(`/api/barber/walk-ins/${e.id}/${action}`)
        .set("Cookie", barberBCookie);
      expect(res.status, action).toBe(409);
    }
    // ... while the owning chair can.
    const ok = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/ready`)
      .set("Cookie", barberACookie);
    expect(ok.status).toBe(200);
  });

  it("a manager/owner seat passes the role gate here too", async () => {
    const res = await request(app)
      .get("/api/barber/walk-ins")
      .set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
  });
});

describe("start + complete on the barber's own chair (PR 3)", () => {
  it("claim -> start -> complete, all scoped to the seat's chair", async () => {
    const e = await makeEntry();
    await request(app)
      .post(`/api/barber/walk-ins/${e.id}/claim`)
      .set("Cookie", barberACookie);
    const started = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/start`)
      .set("Cookie", barberACookie);
    expect(started.status).toBe(200);
    expect(started.body.entry.assignedStaffId).toBe(chairA);
    const done = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/complete`)
      .set("Cookie", barberACookie);
    expect(done.status).toBe(200);
    expect(done.body.entry.status).toBe("COMPLETED");
  });

  it("a barber can neither start nor complete another chair's customer", async () => {
    const e = await makeEntry();
    await request(app)
      .post(`/api/barber/walk-ins/${e.id}/claim`)
      .set("Cookie", barberACookie);
    const start = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/start`)
      .set("Cookie", barberBCookie);
    expect(start.status).toBe(409);
    await request(app)
      .post(`/api/barber/walk-ins/${e.id}/start`)
      .set("Cookie", barberACookie);
    const complete = await request(app)
      .post(`/api/barber/walk-ins/${e.id}/complete`)
      .set("Cookie", barberBCookie);
    expect(complete.status).toBe(409);
  });
});
