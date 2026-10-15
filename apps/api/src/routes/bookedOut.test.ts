import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { collectBookedOutFacts } from "../services/bookedOutFacts.js";

/**
 * "How do I get booked out more?" - the numbers, counted against a history
 * built by hand, and the route that serves them.
 *
 * `now` is pinned to a UTC midnight in a UTC shop, so every open minute is a
 * whole number and every expectation below is worked out in its comment.
 * Hours: two providers, 09:00-17:00 every day = 480 minutes each per day.
 */
const app = createApp();
const DAY = 24 * 60 * 60_000;
const NOW = new Date(Date.UTC(2027, 0, 13)); // a Wednesday, 00:00 UTC
const at = (days: number, hour = 10) => new Date(NOW.getTime() + days * DAY + hour * 3_600_000);
const emails: string[] = [];

let shopId: string;
let ownerCookie: string;
let sam: string;
let lee: string;
let cut: string;

async function signup(label: string) {
  const email = `bkout-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}

async function client(name: string, archived = false) {
  return (
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `k-${randomToken(8)}`,
        magicToken: randomToken(),
        firstName: name,
        lastName: "Sample",
        ...(archived ? { archivedAt: NOW } : {}),
      },
      select: { id: true },
    })
  ).id;
}

async function appt(staffId: string, clientId: string | null, days: number, status: "BOOKED" | "COMPLETED" | "NO_SHOW") {
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: cut,
      clientId,
      firstName: "Pat",
      lastName: "Sample",
      status,
      startsAt: at(days),
      endsAt: new Date(at(days).getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: randomToken(),
    },
  });
}

beforeAll(async () => {
  const owner = await signup("owner");
  ownerCookie = owner.cookie;
  const shop = await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Booked Out Cuts", bookingUrl: "https://bo.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native", timezone: "UTC" } });
  sam = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  lee = (await prisma.staff.create({ data: { shopId, name: "Lee" }, select: { id: true } })).id;
  cut = (await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 }, select: { id: true } })).id;
  const design = (await prisma.service.create({ data: { shopId, name: "Design", durationMin: 30 }, select: { id: true } })).id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId: cut, staffId: sam },
      { shopId, serviceId: cut, staffId: lee },
      { shopId, serviceId: design, staffId: sam },
    ],
  });
  for (const staffId of [sam, lee]) {
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ shopId, staffId, weekday, startMin: 540, endMin: 1020 })),
    });
  }
  // Lee is off all day in 2 days: 480 minutes fewer open.
  await prisma.availabilityException.create({
    data: { shopId, staffId: lee, startsAt: at(2, 0), endsAt: at(3, 0), isBlock: true },
  });
  // Sam stops ONE service tomorrow: the time stays open for the rest (#642).
  await prisma.availabilityException.create({
    data: { shopId, staffId: sam, startsAt: at(1, 9), endsAt: at(1, 17), isBlock: true, serviceIds: [design] },
  });

  const A = await client("Ann");
  const B = await client("Bo");
  const C = await client("Cy");
  const D = await client("Di");
  const E = await client("Ed", true);
  const F = await client("Fay");
  const G = await client("Gus");
  const H = await client("Hal");
  // A: came back within 6 weeks.
  await appt(sam, A, -60, "COMPLETED");
  await appt(sam, A, -30, "COMPLETED");
  // B: seen once, 50 days ago.
  await appt(sam, B, -50, "COMPLETED");
  // C: every 20 days, last 60 days ago, nothing booked -> overdue.
  for (const d of [-100, -80, -60]) await appt(sam, C, d, "COMPLETED");
  // D: the same rhythm, but booked in 5 days -> not overdue.
  for (const d of [-100, -80, -60]) await appt(sam, D, d, "COMPLETED");
  await appt(sam, D, 5, "BOOKED");
  // E: the same rhythm, archived -> nobody to win back.
  for (const d of [-100, -80, -60]) await appt(sam, E, d, "COMPLETED");
  // F: new 10 days ago. G: new 5 days ago, and a no-show.
  await appt(sam, F, -10, "COMPLETED");
  await appt(sam, G, -5, "NO_SHOW");
  // H: seen 85 days ago, back 50 days later - past the 6-week line, so NOT
  // counted as coming back.
  await appt(sam, H, -85, "COMPLETED");
  await appt(sam, H, -35, "COMPLETED");
  // Lee: one booking in 3 days.
  await appt(lee, null, 3, "BOOKED");
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

describe("the numbers, for the whole shop", () => {
  it("🔴 counts each one the way its comment says", async () => {
    const f = (await collectBookedOutFacts({ shopId, now: NOW }))!;
    expect(f.scope).toBe("shop");
    // 14 days x 2 providers x 480, less Lee's day off. Sam's Design-only block
    // keeps the time open. Booked: D in 5 days + Lee in 3 = 2 x 30.
    expect(f.upcoming).toEqual({ openMin: 14 * 2 * 480 - 480, bookedMin: 60 });
    // 28 finished days x 960. Booked in them: F (-10) + G (-5), no-show included.
    expect(f.past).toEqual({ openMin: 28 * 960, bookedMin: 60 });
    expect(f.weekdays).toHaveLength(7);
    expect(f.weekdays.every((w) => w.days === 8 && w.openMin === 8 * 960)).toBe(true);
    // Seen 6-13 weeks ago: A, B, C, D, H (E archived). Back within 6 weeks: A
    // only - H came back after 50 days.
    expect(f.returning).toEqual({ cohort: 5, returned: 1 });
    // First-ever booking: F and G in the last 30 days; A and B the 30 before.
    expect(f.newClients).toEqual({ last30: 2, prior30: 2 });
    // Past bookings in the last 60 days: A x2, B, C, D, E, F, G, H = 9; G no-showed.
    expect(f.noShows).toEqual({ bookings: 9, noShows: 1 });
    // C only: D is booked, E is archived.
    expect(f.overdueRegulars).toBe(1);
    expect(f.profileMissingPhoto).toBe(2);
    expect(f.services).toEqual({ total: 2, unpriced: 1 });
    expect(f.page).toMatchObject({ hasBio: false, galleryCount: 0, hasInstagram: false });
  });
});

describe("the numbers, for one provider's own book", () => {
  it("🔴 only Lee's hours, Lee's bookings and Lee's services", async () => {
    const f = (await collectBookedOutFacts({ shopId, staffId: lee, now: NOW }))!;
    expect(f.scope).toBe("own");
    expect(f.upcoming).toEqual({ openMin: 14 * 480 - 480, bookedMin: 30 });
    expect(f.returning).toEqual({ cohort: 0, returned: 0 });
    expect(f.overdueRegulars).toBe(0);
    expect(f.page).toBeNull();
    expect(f.profileMissingPhoto).toBe(1);
    // Lee offers Cut only, which is priced.
    expect(f.services).toEqual({ total: 1, unpriced: 0 });
  });
});

describe("GET /api/assistant/booked-out", () => {
  it("an owner gets the shop's brief: counts, no money, no client names", async () => {
    const res = await request(app).get("/api/assistant/booked-out").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.brief.scope).toBe("shop");
    expect(typeof res.body.brief.headline).toBe("string");
    const text = JSON.stringify(res.body);
    for (const name of ["Ann", "Bo ", "Cy", "Di", "Fay", "Gus", "Hal", "Sample", "Pat"]) expect(text).not.toContain(name);
    expect(text).not.toMatch(/\$\d/);
  });

  it("🔴 a provider seat gets its own book, never the shop's", async () => {
    const seat = await signup("lee");
    await prisma.shopMember.create({ data: { shopId, userId: seat.userId, role: "BARBER", staffId: lee } });
    const res = await request(app).get("/api/assistant/booked-out").set("Cookie", seat.cookie);
    expect(res.status).toBe(200);
    expect(res.body.brief.scope).toBe("own");
    expect(res.body.brief.items.map((i: { id: string }) => i.id)).not.toContain("page_gaps");
  });

  it("a provider seat with no calendar has no book to read", async () => {
    const seat = await signup("nocal");
    await prisma.shopMember.create({ data: { shopId, userId: seat.userId, role: "BARBER", staffId: null } });
    expect((await request(app).get("/api/assistant/booked-out").set("Cookie", seat.cookie)).status).toBe(404);
  });

  it("refuses anyone not signed in", async () => {
    expect((await request(app).get("/api/assistant/booked-out")).status).toBe(401);
  });
});
