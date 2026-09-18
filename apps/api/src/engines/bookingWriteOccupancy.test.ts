import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * ONE FIXTURE TABLE, ASKED OF EVERY SURFACE THAT DECIDES WHETHER TIME IS TAKEN.
 *
 * `chairOccupancy.ts` has named this file as the enforcer of its read/write
 * parity invariant since it was written. It did not exist. A comment asserting
 * a guarantee that nothing checks is the dangerous kind of wrong, so here it is.
 *
 * Each row below is set up ONCE and then put to four questions:
 *
 *   1. does the CALENDAR draw it?          GET /api/booking/agenda
 *   2. does AVAILABILITY withhold it?      GET /api/book/:slug/slots
 *   3. is a RESERVATION refused?           POST /api/booking/appointments
 *   4. is a RECEIPT flagged?               POST .../appointments/walk-in
 *
 * 🔴 (3) AND (4) ARE DELIBERATELY DIFFERENT OUTCOMES, and forcing them into one
 * would be a bug, not a simplification. A reservation request is asking to hold
 * future time, so a collision means no. A receipt records a cut that already
 * happened with cash already taken, so a collision means "recorded, and here is
 * the problem". What they SHARE is the overlap detection - the same predicate,
 * the same half-open interval - and that sharing is exactly what this proves.
 */
const app = createApp();
const password = "supersecret123";

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
let clientId: string;

/** The window every fixture occupies: straddling now, so all four surfaces can see it. */
const FROM_MS = -5 * 60_000;
const TO_MS = 25 * 60_000;
const spanNow = () => ({
  start: new Date(Date.now() + FROM_MS),
  end: new Date(Date.now() + TO_MS),
});

interface Span {
  start: Date;
  end: Date;
}

interface Fixture {
  name: string;
  /**
   * Create the row over the given window.
   *
   * 🔴 TWO WINDOWS, BECAUSE THE SURFACES CANNOT SHARE ONE. A receipt is always
   * written at the wall clock - the walk-in button has no time picker - so the
   * receipt and calendar questions have to be asked about NOW. Availability, by
   * contrast, only speaks in slots the grid actually offers, which sit on its
   * own step. Forcing both into one window would test the grid's arithmetic
   * rather than the occupancy rule. Each surface gets a window it can see, and
   * the FIXTURE is identical in both.
   */
  setUp: (at: Span) => Promise<void>;
  /** Does the barber's calendar draw it? */
  onCalendar: boolean;
  /** Does it hold the chair against availability and against a RESERVATION? */
  holdsChair: boolean;
  /**
   * Does it flag a RECEIPT?
   *
   * 🔴 USUALLY THE SAME AS holdsChair, AND DELIBERATELY NOT FOR A BLOCK. The
   * walk-in passes `externalBlocks: "ignore"` on purpose: the person is
   * physically in the chair and the money is in the till, so ejecting them over
   * a calendar entry the barber drew would be the wrong answer. A reservation
   * into that same block IS refused, and can only cross it through the audited
   * override. The two commands share the overlap detection and differ here, and
   * that difference is the contract - not a gap in it.
   */
  flagsReceipt: boolean;
}

const FIXTURES: Fixture[] = [
  {
    name: "a BOOKED native appointment",
    setUp: (at) => appointment("BOOKED", at),
    onCalendar: true,
    holdsChair: true,
    flagsReceipt: true,
  },
  {
    name: "a CANCELED native appointment",
    setUp: (at) => appointment("CANCELED", at),
    onCalendar: true, // struck through - the barber still wants to see it
    holdsChair: false,
    flagsReceipt: false,
  },
  {
    name: "a NO_SHOW native appointment",
    setUp: (at) => appointment("NO_SHOW", at),
    onCalendar: true,
    holdsChair: false,
    flagsReceipt: false,
  },
  {
    name: "an IN-PROGRESS completed appointment (a walk-in mid-cut)",
    setUp: (at) => appointment("COMPLETED", at),
    onCalendar: true,
    holdsChair: true, // someone is physically in the chair
    flagsReceipt: true,
  },
  {
    name: "an Acuity-ingested visit",
    setUp: (at) => visit("SCHEDULED", at),
    onCalendar: true,
    holdsChair: true, // shop-wide: a Visit carries no staffId
    flagsReceipt: true,
  },
  {
    name: "a CANCELED Acuity visit",
    setUp: (at) => visit("CANCELED", at),
    onCalendar: false, // hidden: a cancelled booking is not on the schedule
    holdsChair: false,
    flagsReceipt: false,
  },
  {
    name: "blocked time synced from the external calendar",
    setUp: (at) => externalBlock(at),
    onCalendar: true,
    holdsChair: true,
    // 🔴 The one row where the two commands differ: see flagsReceipt.
    flagsReceipt: false,
  },
  {
    name: "🔴 an ADJACENT appointment that only touches the window",
    // Ends exactly when the window starts. Half-open: no overlap at all.
    setUp: (at) =>
      appointment("BOOKED", {
        start: new Date(at.start.getTime() - 30 * 60_000),
        end: at.start,
      }),
    onCalendar: true,
    holdsChair: false,
    flagsReceipt: false,
  },
];

async function appointment(
  status: "BOOKED" | "CANCELED" | "COMPLETED" | "NO_SHOW",
  at = spanNow(),
) {
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Fixture",
      status,
      startsAt: at.start,
      endsAt: at.end,
      manageToken: randomToken(),
    },
  });
}

async function visit(status: "SCHEDULED" | "CANCELED", at = spanNow()) {
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acu-${randomToken(8)}`,
      status,
      scheduledAt: at.start,
      endAt: at.end,
    },
  });
}

async function externalBlock(at = spanNow()) {
  await prisma.externalBlock.create({
    data: {
      shopId,
      externalId: `blk-${randomToken(8)}`,
      startsAt: at.start,
      endsAt: at.end,
    },
  });
}

// ── the four questions ────────────────────────────────────────────────────

async function calendarDrawsIt(): Promise<boolean> {
  const res = await request(app)
    .get("/api/booking/agenda")
    .query({
      from: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
      to: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
    })
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return (res.body.rows ?? res.body.agenda ?? []).length > 0;
}

/** Every instant the public page is currently offering. */
async function offered(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}/slots`).query({
    staffId,
    serviceId,
    from: new Date(Date.now() - 60 * 60_000).toISOString(),
    to: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
  });
  expect(res.status).toBe(200);
  return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
}

/**
 * Is `target` - an instant the grid offered when the book was empty - still on
 * offer? Asking about a real slot rather than an interval of our own choosing
 * keeps this a question about occupancy instead of about the grid's step size.
 */
async function stillOffered(target: string): Promise<boolean> {
  return (await offered()).includes(target);
}

/** A RESERVATION aimed into the window: refused on collision. */
async function reservationRefused(): Promise<boolean> {
  const res = await request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({
      staffId,
      serviceId,
      firstName: "Reserver",
      startsAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      customTime: true,
    });
  if (res.status < 300) {
    await prisma.appointment.deleteMany({ where: { shopId, firstName: "Reserver" } });
    return false;
  }
  return true;
}

/** A RECEIPT: always recorded, flagged on collision. */
async function receiptFlagged(): Promise<boolean> {
  const res = await request(app)
    .post("/api/booking/appointments/walk-in")
    .set("Cookie", cookie)
    .send({ amount: 25, staffId });
  expect(res.status).toBe(201); // never refused - that is the asymmetry
  const flagged = Boolean(res.body.conflict);
  await prisma.bookingConflict.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId, firstName: "Walk-in" } });
  return flagged;
}

beforeAll(async () => {
  const email = `contract-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Contract", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Contract Cuts", bookingUrl: "https://c.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  expect(
    (
      await request(app)
        .patch("/api/shops/me")
        .set("Cookie", cookie)
        .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 })
    ).status,
  ).toBe(200);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Chair" });
  staffId = staff.body.id;
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = svc.body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 24 * 60 })),
    });
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1555${randomToken(7)}`,
      magicToken: randomToken(),
      firstName: "Fixture",
    },
    select: { id: true },
  });
  clientId = client.id;
});

beforeEach(async () => {
  await prisma.bookingConflict.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.externalBlock.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
});

describe("16. every surface agrees about the same interval", () => {
  /** Wipe the book between questions so each answer is about one fixture. */
  async function clean() {
    await prisma.bookingConflict.deleteMany({ where: { shopId } });
    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.visit.deleteMany({ where: { shopId } });
    await prisma.externalBlock.deleteMany({ where: { shopId } });
  }

  for (const f of FIXTURES) {
    it(`${f.name}: calendar=${f.onCalendar}, holds=${f.holdsChair}, flags=${f.flagsReceipt}`, async () => {
      // ── window A: NOW. The calendar and both commands are asked here,
      // because a receipt is always written at the wall clock.
      await clean();
      await f.setUp(spanNow());
      expect(await calendarDrawsIt()).toBe(f.onCalendar);
      expect(await reservationRefused()).toBe(f.holdsChair);
      expect(await receiptFlagged()).toBe(f.flagsReceipt);

      // ── window B: a slot the GRID offered. Availability is asked here,
      // about a real offered instant rather than one of our choosing.
      await clean();
      const target = (await offered())[3];
      expect(target).toBeTruthy();
      // Starts exactly ON the offered instant: an occupying fixture then
      // covers it, and the "adjacent" one ends exactly where it begins.
      const at = {
        start: new Date(target!),
        end: new Date(new Date(target!).getTime() + 25 * 60_000),
      };
      await f.setUp(at);
      // Offered exactly when it does NOT hold the chair.
      expect(await stillOffered(target!)).toBe(!f.holdsChair);
    });
  }

  it("🔴 the read and the write never disagree, across the whole table", async () => {
    // The parity invariant itself: a slot availability OFFERS must be one a
    // reservation ACCEPTS, and one it withholds must be one a reservation
    // refuses. A read that offers what the write rejects bounces a customer at
    // the final step; a write that accepts what the read withheld is the
    // outage chairOccupancy.ts was written for.
    for (const f of FIXTURES) {
      await clean();
      const target = (await offered())[3]!;
      const at = {
        start: new Date(target),
        end: new Date(new Date(target).getTime() + 25 * 60_000),
      };
      await f.setUp(at);

      const offeredNow = await stillOffered(target);
      const res = await request(app)
        .post("/api/booking/appointments")
        .set("Cookie", cookie)
        .send({ staffId, serviceId, firstName: "Parity", startsAt: target });
      const accepted = res.status < 300;
      if (accepted) {
        await prisma.appointment.deleteMany({ where: { shopId, firstName: "Parity" } });
      }
      expect({ fixture: f.name, offered: offeredNow, accepted }).toEqual({
        fixture: f.name,
        offered: offeredNow,
        accepted: offeredNow,
      });
    }
  });
});
