import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The operator surface for the coverage audit + backfill.
 *
 * The route layer is where the two things that matter to a non-engineer live:
 * only a manager can reach it, and a shop that is merely rehearsing cannot be
 * made to write. Both are asserted here rather than assumed from the router's
 * middleware list, because a future refactor that moves these routes to another
 * router would silently drop either one.
 */
const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(async () => ({ id: `blk_${Math.floor(Date.now() % 100000)}` })),
  deleteBlock: vi.fn(),
  listBlocks: vi.fn(async () => []),
  listCalendars: vi.fn(async () => [{ id: "cal_route", name: "Chair 1" }]),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));

vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return {
    ...actual,
    getAcuityClientForShop: vi.fn(async () => acuityMock),
  };
});

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Backfill Op", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

beforeAll(async () => {
  const email = `bfroute-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Backfill Route Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = service.body.id;

  const conn = await prisma.acuityConnection.create({
    data: {
      shopId,
      acuityAccountId: "acct_route",
      accessToken: "enc",
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
    select: { connectedAt: true },
  });
  await prisma.staff.update({
    where: { id: staffId },
    data: {
      acuityCalendarId: "cal_route",
      // Derived from connectedAt, never Node's clock: connectedAt is Postgres'
      // now() at microsecond precision while a JS Date is millisecond-truncated,
      // so the two straddle a boundary about half the time and isMappingStale (a
      // strict `<`) then calls a fresh mapping STALE.
      acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1000),
    },
  });
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

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { acuityOutboundMode: "ENFORCE" },
  });
});

async function bookOne(minutesOut = 90): Promise<string> {
  const startsAt = new Date(Date.now() + minutesOut * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Priya",
      lastName: "Raman",
      phone: "+15555550199",
      email: "priya@example.test",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

describe("GET /api/booking/acuity/backfill (dry run)", () => {
  it("requires a signed-in manager", async () => {
    const anon = await request(app).get("/api/booking/acuity/backfill");
    expect([401, 403]).toContain(anon.status);
  });

  it("reports the gap without writing or calling Acuity", async () => {
    await bookOne();
    const res = await request(app).get("/api/booking/acuity/backfill").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.shops).toHaveLength(1);
    expect(res.body.shops[0].shopId).toBe(shopId);
    expect(res.body.shops[0].counts.missing).toBe(1);
    expect(res.body.totals.missing).toBe(1);
    for (const fn of Object.values(acuityMock)) expect(fn).not.toHaveBeenCalled();
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);
  });

  it("returns no customer PII", async () => {
    await bookOne();
    const res = await request(app).get("/api/booking/acuity/backfill").set("Cookie", cookie);
    const wire = JSON.stringify(res.body);
    for (const s of ["Priya", "Raman", "5555550199", "priya@example.test"]) {
      expect(wire).not.toContain(s);
    }
  });
});

describe("POST /api/booking/acuity/backfill (execute)", () => {
  it("requires a signed-in manager", async () => {
    const anon = await request(app).post("/api/booking/acuity/backfill").send({});
    expect([401, 403]).toContain(anon.status);
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
  });

  it("protects the gap and is idempotent on a rerun", async () => {
    const apptId = await bookOne();

    const first = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({ limit: 10 });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(1);
    expect(first.body.active).toBe(1);
    expect(first.body.done).toBe(true);

    const rows = await prisma.acuityOutboundBlock.findMany({ where: { shopId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.appointmentId).toBe(apptId);
    expect(rows[0]!.state).toBe("ACTIVE");

    const second = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({ limit: 10 });
    expect(second.body.created).toBe(0);
    expect(second.body.skippedProtected).toBe(1);
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(1);

    const audit = await request(app).get("/api/booking/acuity/backfill").set("Cookie", cookie);
    expect(audit.body.shops[0].counts.missing).toBe(0);
    expect(audit.body.shops[0].counts.protected).toBe(1);
  });

  it("409s while the shop is only OBSERVING, and writes nothing", async () => {
    await bookOne();
    await prisma.shop.update({
      where: { id: shopId },
      data: { acuityOutboundMode: "OBSERVE" },
    });
    const res = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_enforcing");
    expect(acuityMock.createBlock).not.toHaveBeenCalled();
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);
  });

  it("409s while the shop is OFF", async () => {
    await bookOne();
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
    const res = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_enforcing");
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(0);
  });

  it("rejects an oversized batch rather than quietly clamping it", async () => {
    const res = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({ limit: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("walks in bounded batches and reports a resumable cursor", async () => {
    await bookOne(60);
    await bookOne(120);
    await bookOne(180);

    const first = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({ limit: 2 });
    expect(first.body.created).toBe(2);
    expect(first.body.done).toBe(false);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({ limit: 2, cursor: first.body.nextCursor });
    expect(second.body.created).toBe(1);
    expect(second.body.done).toBe(true);
    expect(await prisma.acuityOutboundBlock.count({ where: { shopId } })).toBe(3);
  });

  it("returns no customer PII", async () => {
    await bookOne();
    const res = await request(app)
      .post("/api/booking/acuity/backfill")
      .set("Cookie", cookie)
      .send({});
    const wire = JSON.stringify(res.body);
    for (const s of ["Priya", "Raman", "5555550199", "priya@example.test"]) {
      expect(wire).not.toContain(s);
    }
  });
});
