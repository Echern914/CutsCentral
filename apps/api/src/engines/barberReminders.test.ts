import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * 🔴 TIME IS FROZEN IN THIS SUITE, and it has to be.
 *
 * The day-ahead digest is claimed once per (shop, barber, date) - that is what
 * stops the 5-minutely job sending it twice. The DEFAULT dayAheadHour is 19.
 * Several cases below call run() with the REAL clock, so whenever the suite
 * happened to run between 19:00 and 19:59 UTC those cases claimed the digest
 * first, and "summarizes tomorrow at the barber's chosen hour" then found the
 * claim already taken and sent nothing.
 *
 * It failed for exactly one hour a day, every day, and passed in isolation -
 * which is the worst kind of red, because it reads like a real scheduling bug.
 * It is not: the engine takes `now` as a parameter and derives the shop-local
 * window from it correctly. The test was reading the wall clock.
 *
 * So: Date is frozen at a fixed instant well away from 19:00 and from midnight,
 * and the shop's timezone is pinned to UTC in the fixture below. ONLY Date is
 * faked - setTimeout and friends stay real, or Prisma's own timers hang.
 *
 * The barber's own reminders. What matters:
 *  - the message names the CLIENT and the SERVICE (that's the whole ask);
 *  - it fires on the barber's OWN lead time, not a global one;
 *  - it fires at most once per appointment, even though the job ticks every
 *    5 minutes;
 *  - a barber who turned it off gets nothing;
 *  - in a two-chair shop each barber only hears about his own chair.
 */

// Capture sends instead of hitting push/SMS/email.
const sent: { userId: string; kind: string; title: string; body: string }[] = [];
vi.mock("../services/barberNotify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/barberNotify.js")>();
  return {
    ...actual,
    sendToBarber: vi.fn(async (p: Parameters<typeof actual.sendToBarber>[0]) => {
      sent.push({
        userId: p.userId,
        kind: p.kind,
        title: p.message.title,
        body: p.message.body,
      });
      return { pushed: true, texted: false, emailed: false };
    }),
  };
});

/** Monday 2026-06-15, 12:00 UTC. Mid-day so no case can drift into another
 *  hour, mid-week so weekday logic is unremarkable, and nowhere near the
 *  default 19:00 digest hour that caused the flake. */
const FROZEN_NOW = new Date("2026-06-15T12:00:00.000Z");

const { runBarberRemindersForShop } = await import("./barberReminders.js");

/** Scoped to THIS suite's shop: the cron sweeps every shop in the shared test
 *  DB, which would fold other suites' appointments into these assertions. */
const run = (now?: Date) => runBarberRemindersForShop(shopId, ownerId, now);

/** Sends belonging to THIS suite (the engine sweeps every shop in the DB). */
function mineOnly(kind: string) {
  return sent.filter((s) => s.kind === kind && (s.userId === ownerId || s.userId === otherUserId));
}

let ownerId: string;
let otherUserId: string;
let shopId: string;
let staffAId: string; // owner's chair
let staffBId: string; // the other barber's chair
let serviceId: string;
let clientId: string;

/** An appointment `minutesFromNow` out, on the given chair. */
async function makeAppt(staffId: string, minutesFromNow: number, first = "Sam") {
  const startsAt = new Date(Date.now() + minutesFromNow * 60_000);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: first,
      lastName: "Cole",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 45 * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  // toFake: ["Date"] ONLY. Faking setTimeout/setInterval too would stall
  // Prisma's internal timers and hang the suite; all this needs is for
  // new Date() / Date.now() to stop moving.
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });

  const owner = await prisma.user.create({
    data: { email: `bn-own-${randomToken(6)}@test.local`, passwordHash: "x", name: "Own" },
  });
  ownerId = owner.id;
  const other = await prisma.user.create({
    data: { email: `bn-oth-${randomToken(6)}@test.local`, passwordHash: "x", name: "Oth" },
  });
  otherUserId = other.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId,
      name: "Notify Cuts",
      bookingUrl: "https://nc.test",
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
    },
  });
  shopId = shop.id;
  const a = await prisma.staff.create({
    data: { shopId, name: "Owner Chair", userId: ownerId },
    select: { id: true },
  });
  staffAId = a.id;
  const b = await prisma.staff.create({
    data: { shopId, name: "Other Chair", userId: otherUserId },
    select: { id: true },
  });
  staffBId = b.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Fade", durationMin: 45, price: 40 },
    select: { id: true },
  });
  serviceId = svc.id;
  const c = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `bn-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Sam",
    },
    select: { id: true },
  });
  clientId = c.id;
});

afterEachCleanup();
function afterEachCleanup() {
  beforeEach(async () => {
    sent.length = 0;
    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.barberNotifyPref.deleteMany({ where: { shopId } });
  });
}

afterAll(async () => {
  vi.useRealTimers();
  await prisma.shop.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId] } } });
  await prisma.$disconnect();
});

describe("barber next-up reminder", () => {
  it("names the client AND the service, and stamps the appointment", async () => {
    // 20 min out, inside the default 30-min lead.
    const appt = await makeAppt(staffAId, 20);
    await run();

    const mine = mineOnly("nextUp");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.userId).toBe(ownerId);
    expect(mine[0]!.title).toContain("Sam Cole");
    expect(mine[0]!.body).toContain("Sam Cole");
    expect(mine[0]!.body).toContain("Fade"); // the type of cut
    const row = await prisma.appointment.findUnique({
      where: { id: appt.id },
      select: { barberNextUpSentAt: true },
    });
    expect(row!.barberNextUpSentAt).not.toBeNull();
  });

  it("does not fire before the lead window opens, and never twice", async () => {
    await makeAppt(staffAId, 90); // outside the default 30-min lead
    await run();
    expect(mineOnly("nextUp")).toHaveLength(0);

    await prisma.appointment.deleteMany({ where: { shopId } });
    await makeAppt(staffAId, 10);
    await run();
    expect(mineOnly("nextUp")).toHaveLength(1);
    // A second tick 5 minutes later must not re-send.
    sent.length = 0;
    await run();
    expect(mineOnly("nextUp")).toHaveLength(0);
  });

  it("honors the barber's OWN lead time", async () => {
    await prisma.barberNotifyPref.create({
      data: { shopId, userId: ownerId, nextUpLeadMin: 120, dayAheadEnabled: false },
    });
    await makeAppt(staffAId, 90); // outside 30, inside 120
    await run();
    expect(mineOnly("nextUp")).toHaveLength(1);
  });

  it("sends nothing when the barber turned next-up off", async () => {
    await prisma.barberNotifyPref.create({
      data: { shopId, userId: ownerId, nextUpEnabled: false, dayAheadEnabled: false },
    });
    await makeAppt(staffAId, 10);
    await run();
    expect(mineOnly("nextUp")).toHaveLength(0);
  });

  it("routes each chair's appointment to ITS barber, not the owner", async () => {
    await makeAppt(staffBId, 10, "Dee");
    await run();
    const mine = mineOnly("nextUp");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.userId).toBe(otherUserId); // not ownerId
    expect(mine[0]!.body).toContain("Dee");
  });

  it("ignores holds and cancellations", async () => {
    const held = await makeAppt(staffAId, 10, "Held");
    await prisma.appointment.update({
      where: { id: held.id },
      data: { holdExpiresAt: new Date(Date.now() + 600_000) },
    });
    const canceled = await makeAppt(staffAId, 12, "Gone");
    await prisma.appointment.update({
      where: { id: canceled.id },
      data: { status: "CANCELED" },
    });
    await run();
    expect(mineOnly("nextUp")).toHaveLength(0);
  });
});

describe("barber day-ahead digest", () => {
  /** Run the job as if it were the given shop-local hour. */
  async function runAtHour(hour: number) {
    // Built from the FROZEN date, not the wall clock: the appointments below
    // are created relative to the same frozen instant, so the two can never
    // land on different calendar days (a real midnight-straddle risk before).
    const now = new Date(FROZEN_NOW);
    now.setUTCHours(hour, 5, 0, 0); // shop tz is UTC in this suite
    await run(now);
  }

  it("summarizes tomorrow at the barber's chosen hour, once", async () => {
    await prisma.barberNotifyPref.create({
      data: { shopId, userId: ownerId, dayAheadHour: 19, nextUpEnabled: false },
    });
    // Two appointments tomorrow on the owner's chair.
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    for (const hour of [9, 16]) {
      const startsAt = new Date(tomorrow);
      startsAt.setUTCHours(hour, 0, 0, 0);
      await prisma.appointment.create({
        data: {
          shopId,
          staffId: staffAId,
          serviceId,
          clientId,
          firstName: hour === 9 ? "First" : "Last",
          status: "BOOKED",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 45 * 60_000),
          manageToken: randomToken(),
        },
      });
    }

    await runAtHour(18); // not yet his hour
    expect(sent.filter((s) => s.kind === "dayAhead")).toHaveLength(0);

    await runAtHour(19);
    const digest = sent.filter((s) => s.kind === "dayAhead" && s.userId === ownerId);
    expect(digest).toHaveLength(1);
    expect(digest[0]!.title).toContain("2 cuts");
    expect(digest[0]!.body).toContain("First"); // who's first up

    // A later tick in the same hour must not send a second one.
    sent.length = 0;
    await runAtHour(19);
    expect(sent.filter((s) => s.kind === "dayAhead" && s.userId === ownerId)).toHaveLength(0);
  });

  it("says nothing when tomorrow is empty", async () => {
    await prisma.barberNotifyPref.create({
      data: { shopId, userId: ownerId, dayAheadHour: 20, nextUpEnabled: false },
    });
    await runAtHour(20);
    expect(sent.filter((s) => s.kind === "dayAhead" && s.userId === ownerId)).toHaveLength(0);
  });
});
