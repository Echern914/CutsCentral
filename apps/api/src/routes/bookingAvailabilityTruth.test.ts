import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { dayAvailabilityCache, noteAvailabilityChanged } from "../services/availabilityCache.js";
import { raceBehindAdvisoryLock, winners } from "../testing/raceBarrier.js";

/**
 * "Customers should not normally see a time that is already booked."
 *
 * Two separable claims, and the tests are deliberately split along that line:
 *
 *  1. THE GRID IS HONEST - every blocking source is subtracted before the list
 *     is rendered, including partial overlaps and the turnover buffer.
 *  2. THE GRID IS NOT THE GUARD - it can only ever be a snapshot, so the write
 *     path must still refuse a contested slot atomically, and exactly one of
 *     twenty simultaneous customers may win.
 *
 * Both matter. Fixing only (1) hides a race instead of resolving it; relying
 * only on (2) means every customer discovers the truth by being refused.
 *
 * 🔴 The concurrency test uses a REAL BARRIER (testing/raceBarrier.ts), not
 * `Promise.all`. An audit of this repo found 17 of 28 "two concurrent X" tests
 * passed with their guard deleted, because the calls never actually contended.
 * `settledEarly` is the assertion that fails when the guard is gone.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let slug: string;
let shopId: string;
let chairA: string;
let chairB: string;
let shortId: string; // 30 min
let longId: string; // 90 min

/** The shop's own local calendar day, `days` out, as YYYY-MM-DD. */
function dayString(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function slotsFor(serviceId: string, staffId: string): Promise<string[]> {
  const res = await request(app).get(
    `/api/book/${slug}/slots?serviceId=${serviceId}&staffId=${staffId}`,
  );
  expect(res.status).toBe(200);
  return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
}

/** A concrete UTC instant at `hour:min` on the shop's day `days` out. */
function at(days: number, hour: number, min = 0): Date {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, min, 0, 0);
  return d;
}

async function bookRaw(opts: {
  staffId: string;
  startsAt: Date;
  minutes: number;
  status?: "BOOKED" | "PENDING";
  holdExpiresAt?: Date | null;
}) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: opts.staffId,
      serviceId: shortId,
      firstName: "Existing",
      lastName: "Booking",
      status: opts.status ?? "BOOKED",
      holdExpiresAt: opts.holdExpiresAt ?? null,
      startsAt: opts.startsAt,
      endsAt: new Date(opts.startsAt.getTime() + opts.minutes * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  const email = `avail-${randomToken(6)}@test.local`;
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Avail Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: "Availability Cuts",
      bookingUrl: "https://avail.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  slug = shopRes.body.slug;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      timezone: "UTC",
      bookingMode: "native",
      publicPageEnabled: true,
      // A real turnover gap, so "the buffer is included" is a live property
      // rather than a zero that would pass either way.
      bookingBufferMin: 10,
    },
  });

  chairA = (await prisma.staff.create({ data: { shopId, name: "Ada" }, select: { id: true } })).id;
  chairB = (await prisma.staff.create({ data: { shopId, name: "Ben" }, select: { id: true } })).id;
  shortId = (
    await prisma.service.create({
      data: { shopId, name: "Line-up", durationMin: 30, price: 20 },
      select: { id: true },
    })
  ).id;
  longId = (
    await prisma.service.create({
      data: { shopId, name: "Locs", durationMin: 90, price: 120 },
      select: { id: true },
    })
  ).id;
  for (const staffId of [chairA, chairB]) {
    for (const serviceId of [shortId, longId]) {
      await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
    }
    for (let weekday = 0; weekday < 7; weekday++) {
      await prisma.availabilityRule.create({
        data: { shopId, staffId, weekday, startMin: 9 * 60, endMin: 17 * 60 },
      });
    }
  }
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.externalBlock.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await noteAvailabilityChanged(shopId);
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

describe("the grid never offers a time that is already gone", () => {
  it("removes a booked slot before the list is rendered", async () => {
    const start = at(3, 12);
    const before = await slotsFor(shortId, chairA);
    expect(before).toContain(start.toISOString());
    await bookRaw({ staffId: chairA, startsAt: start, minutes: 30 });
    await noteAvailabilityChanged(shopId);
    expect(await slotsFor(shortId, chairA)).not.toContain(start.toISOString());
  });

  it("removes an ACTIVE hold, and frees it again the moment it lapses", async () => {
    const start = at(4, 12);
    const live = await bookRaw({
      staffId: chairA,
      startsAt: start,
      minutes: 30,
      status: "PENDING",
      holdExpiresAt: new Date(Date.now() + 5 * 60_000),
    });
    await noteAvailabilityChanged(shopId);
    expect(await slotsFor(shortId, chairA)).not.toContain(start.toISOString());

    // An EXPIRED hold releases instantly - the sweep's CANCELED flip is
    // hygiene, not what frees the chair.
    await prisma.appointment.update({
      where: { id: live.id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });
    await noteAvailabilityChanged(shopId);
    expect(await slotsFor(shortId, chairA)).toContain(start.toISOString());
  });

  it("removes a known Acuity external block", async () => {
    const start = at(5, 12);
    expect(await slotsFor(shortId, chairA)).toContain(start.toISOString());
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: start,
        endsAt: new Date(start.getTime() + 60 * 60_000),
        reason: "Dentist",
      },
    });
    await noteAvailabilityChanged(shopId);
    const after = await slotsFor(shortId, chairA);
    expect(after).not.toContain(start.toISOString());
    // A block carries no barber, so it closes the whole shop for its span.
    expect(await slotsFor(shortId, chairB)).not.toContain(start.toISOString());
  });

  it("removes a synced Acuity appointment", async () => {
    const start = at(6, 12);
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `tel:+1555${randomToken(4)}`, magicToken: randomToken() },
      select: { id: true },
    });
    await prisma.visit.create({
      data: {
        shopId,
        clientId: client.id,
        acuityAppointmentId: `av-${randomToken(6)}`,
        status: "SCHEDULED",
        scheduledAt: start,
        endAt: new Date(start.getTime() + 45 * 60_000),
        serviceName: "Acuity cut",
      },
    });
    await noteAvailabilityChanged(shopId);
    expect(await slotsFor(shortId, chairA)).not.toContain(start.toISOString());
  });

  it("gives the time back when a booking is canceled", async () => {
    const start = at(7, 12);
    const appt = await bookRaw({ staffId: chairA, startsAt: start, minutes: 30 });
    await noteAvailabilityChanged(shopId);
    expect(await slotsFor(shortId, chairA)).not.toContain(start.toISOString());
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    await noteAvailabilityChanged(shopId);
    expect(await slotsFor(shortId, chairA)).toContain(start.toISOString());
  });

  it("keeps the other barber bookable", async () => {
    const start = at(8, 12);
    await bookRaw({ staffId: chairA, startsAt: start, minutes: 30 });
    await noteAvailabilityChanged(shopId);
    expect(await slotsFor(shortId, chairA)).not.toContain(start.toISOString());
    expect(await slotsFor(shortId, chairB)).toContain(start.toISOString());
  });

  it("blocks a PARTIAL overlap: 90 minutes cannot start in a 30-minute gap", async () => {
    // Two bookings leaving a gap from 12:00 to 12:30 on chair A. With a 10-min
    // buffer either side, the usable gap is smaller still - and nowhere near
    // the 90 minutes the Locs service needs.
    const gapStart = at(9, 12);
    await bookRaw({ staffId: chairA, startsAt: at(9, 11), minutes: 60 }); // 11:00-12:00
    await bookRaw({ staffId: chairA, startsAt: at(9, 12, 30), minutes: 60 }); // 12:30-13:30
    await noteAvailabilityChanged(shopId);

    const long = await slotsFor(longId, chairA);
    expect(long).not.toContain(gapStart.toISOString());
    // The short service does not fit either - 30 minutes of work needs 30
    // minutes of gap PLUS the shop's turnover buffer on both sides.
    const short = await slotsFor(shortId, chairA);
    expect(short).not.toContain(gapStart.toISOString());
    // And the day is not simply empty: later times are still on offer.
    expect(short.length).toBeGreaterThan(0);
  });

  it("counts the turnover buffer as occupied time", async () => {
    // A 30-minute cut at 12:00 with a 10-minute buffer makes 11:50-12:40
    // unusable, so the 12:30 start that would otherwise fit is gone.
    const start = at(10, 12);
    await bookRaw({ staffId: chairA, startsAt: start, minutes: 30 });
    await noteAvailabilityChanged(shopId);
    const after = await slotsFor(shortId, chairA);
    expect(after).not.toContain(at(10, 12, 30).toISOString());
    expect(after).not.toContain(at(10, 11, 30).toISOString());
  });
});

describe("the cached page cannot outlive the truth", () => {
  it("🔴 a NON-booking writer advances the shop's generation, so a cached day is no longer current", async () => {
    // The reported defect: the slot engine excluded these correctly, but the
    // public page served a body built before they existed - so the time stayed
    // tappable until the TTL lapsed, and the customer found out by being
    // refused. Only booking.public and the dashboard could invalidate; every
    // engine and webhook could not, because importing a route is a cycle. Now
    // every writer advances a number in the DATABASE, and a cached body is
    // served only while that number still matches.
    const gen = async () =>
      (await prisma.shop.findUniqueOrThrow({
        where: { id: shopId },
        select: { availabilityGeneration: true },
      })).availabilityGeneration;
    const before = await gen();
    dayAvailabilityCache.setTtlForTests(60_000);
    try {
      const date = dayString(11);
      const warm = await request(app).get(`/api/book/${slug}/day?date=${date}`);
      expect(warm.status).toBe(200);
      expect(dayAvailabilityCache.peek(`${shopId}|${date}`)?.generation).toBe(before);

      await noteAvailabilityChanged(shopId);
      expect(await gen()).toBe(before + 1);
      // Dropped locally - and, the part that matters across processes, a body
      // under the old generation could not be served by anyone anyway.
      expect(dayAvailabilityCache.peek(`${shopId}|${date}`)).toBeUndefined();
    } finally {
      dayAvailabilityCache.setTtlForTests(0);
    }
  });

  it("is reachable from an engine without importing a route", async () => {
    // The whole point of services/availabilityCache.ts. If this module ever
    // grows an import of routes/* or engines/*, the cycle comes back and the
    // engines lose their ability to advance the generation.
    const mod = await import("../services/availabilityCache.js");
    expect(typeof mod.noteAvailabilityChanged).toBe("function");
    const { fileURLToPath } = await import("node:url");
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        fileURLToPath(new URL("../services/availabilityCache.ts", import.meta.url)),
        "utf8",
      ),
    );
    expect(src).not.toMatch(/from\s+"\.\.\/routes\//);
    expect(src).not.toMatch(/from\s+"\.\.\/engines\//);
  });

  it("every writer that can take a chair drops the cache", async () => {
    // A source-level invariant, in the spirit of the booking-refusal canary:
    // the 18th writer someone adds later is caught by this, not by a customer.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const writers = [
      "engines/waitlistOffer.ts",
      "engines/walkInStart.ts",
      "engines/recurringSeries.ts",
      "engines/holdSweep.ts",
      "services/appointmentPaymentHold.ts",
      "receptionist/tools.ts",
      "acuity/blocks.ts",
      "ingest.ts",
      "routes/booking.public.ts",
      "routes/booking.dashboard.ts",
    ];
    for (const rel of writers) {
      const text = await fs.readFile(path.join(src, rel), "utf8");
      expect(text, `${rel} must advance the availability generation`).toMatch(
        /noteAvailabilityChanged(For)?\(/,
      );
    }
  });
});

describe("the guard, not the grid, is what makes double-booking impossible", () => {
  it("🔴 twenty attempts on one chair and time produce exactly ONE appointment", async () => {
    const start = at(12, 12);
    const attempt = (n: number) =>
      request(app)
        .post(`/api/book/${slug}`)
        .send({
          staffId: chairA,
          serviceId: shortId,
          startsAt: start.toISOString(),
          firstName: `Racer${n}`,
          lastName: "Contender",
          email: `racer${n}@example.com`,
        });

    // ── The contended wave ───────────────────────────────────────────────
    // The barrier takes the SAME advisory lock the write path takes
    // (`appt:<staffId>`, byte-identical - see engines/bookingWrite.ts), on its
    // own connection. The racers pile up behind it and CANNOT proceed;
    // `settledEarly === 0` is the assertion that fails when the guard is
    // removed, because without it nobody waits for anything.
    //
    // 🔑 TWELVE, not twenty, IN THE CONTENDED WAVE - and that is a property of
    // the CONNECTION POOL, not of the guard. Each waiting racer is parked
    // inside `prisma.$transaction`, holding a pooled connection; the local
    // pool is 17 and the barrier itself holds one, so twenty at once simply
    // time out fetching a connection and never reach the lock at all. That
    // would be a test measuring Prisma, not the guard. The remaining eight
    // attempts follow below, so the claim under test is still twenty
    // attempts, one appointment.
    const CONTENDED = 12;
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${chairA}`,
      Array.from({ length: CONTENDED }, (_, n) => async () => attempt(n)),
      600,
    );
    expect(settledEarly).toBe(0);

    const responses = winners(results);
    expect(responses).toHaveLength(CONTENDED); // nobody crashed
    const created = responses.filter((r) => r.status === 201);
    const conflicted = responses.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(CONTENDED - 1);
    // Every loser is told the truth about WHY, in the stable vocabulary.
    for (const r of conflicted) expect(r.body.code).toBe("SLOT_UNAVAILABLE");

    // ── The rest of the twenty ───────────────────────────────────────────
    // The public write limiter is 20/minute per IP, so late attempts may be
    // turned away BEFORE the guard. That is real production behaviour; what
    // matters is that no status other than these three is ever possible, and
    // that not one of them creates a second row.
    for (let n = CONTENDED; n < 20; n++) {
      const res = await attempt(n);
      expect([409, 429]).toContain(res.status);
      expect(res.body.code).toBe(res.status === 409 ? "SLOT_UNAVAILABLE" : "RATE_LIMITED");
    }

    // And the database agrees: one row out of twenty attempts.
    const rows = await prisma.appointment.findMany({
      where: { shopId, staffId: chairA, startsAt: start, status: { in: ["BOOKED", "PENDING"] } },
      select: { id: true, firstName: true },
    });
    expect(rows).toHaveLength(1);
  });

  it("🔴 two OVERLAPPING bookings at different starts cannot both land", async () => {
    // 🔴 THE TEST THAT ACTUALLY FALSIFIES THE OVERLAP GUARD.
    //
    // The identical-start race above is also caught by the partial unique index
    // on (staffId, startsAt) - so it passes even with the advisory-lock overlap
    // check deleted, which is exactly the "concurrency test theatre" this repo
    // has been bitten by before (17 of 28 such tests once passed with their
    // guard removed).
    //
    // Overlapping bookings at DIFFERENT starts are the case no index can see:
    // a 90-minute service at 12:00 and a 30-minute one at 12:30 are two
    // distinct (staffId, startsAt) keys that occupy the same chair. Only the
    // advisory lock plus the overlap re-check can refuse the second, so this
    // is the test that goes red when that check is removed.
    const long = at(16, 12); // Locs, 90 min -> 12:00-13:30
    const short = at(16, 12, 30); // Line-up, 30 min -> 12:30-13:00, inside it

    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${chairA}`,
      [
        async () =>
          request(app)
            .post(`/api/book/${slug}`)
            .send({
              staffId: chairA,
              serviceId: longId,
              startsAt: long.toISOString(),
              firstName: "Long",
              lastName: "Booking",
              email: "long@example.com",
            }),
        async () =>
          request(app)
            .post(`/api/book/${slug}`)
            .send({
              staffId: chairA,
              serviceId: shortId,
              startsAt: short.toISOString(),
              firstName: "Short",
              lastName: "Booking",
              email: "short@example.com",
            }),
      ],
      600,
    );
    expect(settledEarly).toBe(0);

    const responses = winners(results);
    expect(responses).toHaveLength(2);
    const created = responses.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    const loser = responses.find((r) => r.status !== 201)!;
    expect(loser.status).toBe(409);
    expect(loser.body.code).toBe("SLOT_UNAVAILABLE");

    // One chair, one hour, one booking - whichever of them won.
    const rows = await prisma.appointment.findMany({
      where: {
        shopId,
        staffId: chairA,
        status: { in: ["BOOKED", "PENDING"] },
        startsAt: { lt: new Date(long.getTime() + 90 * 60_000) },
        endsAt: { gt: long },
      },
      select: { id: true },
    });
    expect(rows).toHaveLength(1);
  });

  it("🔴 only the WINNER gets a client row, a manage token or any durable record", async () => {
    const start = at(13, 12);
    const before = await prisma.client.count({ where: { shopId } });
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `appt:${chairA}`,
      Array.from({ length: 6 }, (_, n) => async () =>
        request(app)
          .post(`/api/book/${slug}`)
          .send({
            staffId: chairA,
            serviceId: shortId,
            startsAt: start.toISOString(),
            firstName: `Loser${n}`,
            lastName: "Contender",
            // A DISTINCT email each, so a client row per racer would show up.
            email: `loser${n}-${randomToken(4)}@example.com`,
          }),
      ),
      600,
    );
    expect(settledEarly).toBe(0);
    const responses = winners(results);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);

    // The whole transaction rolls back for a loser: no appointment, and no
    // Client either - which is what "creates no durable successful record"
    // has to mean, because the client upsert happens INSIDE the booking tx.
    const appts = await prisma.appointment.count({ where: { shopId, startsAt: start } });
    expect(appts).toBe(1);
    expect(await prisma.client.count({ where: { shopId } })).toBe(before + 1);
    // Nobody was charged and nothing was set up: this shop takes no payment.
    expect(await prisma.payment.count({ where: { shopId } })).toBe(0);
  });

  it("a stale browser is refused, and its refusal names the situation", async () => {
    const start = at(14, 12);
    // The customer's tab was rendered when this was free.
    const stale = start.toISOString();
    expect(await slotsFor(shortId, chairA)).toContain(stale);
    // Someone else takes it - through a path the tab could never have known
    // about, and which used not to invalidate anything.
    await bookRaw({ staffId: chairA, startsAt: start, minutes: 30 });
    await noteAvailabilityChanged(shopId);

    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId: chairA,
        serviceId: shortId,
        startsAt: stale,
        firstName: "Stale",
        lastName: "Tab",
        email: "stale@example.com",
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    // And the refreshed grid no longer offers it, so the retry has somewhere
    // to go.
    expect(await slotsFor(shortId, chairA)).not.toContain(stale);
    // The refusal says nothing about who took it.
    expect(JSON.stringify(res.body)).not.toContain("Existing");
  });

  it("🔴 refuses a write into blocked time even when the grid was never consulted", async () => {
    // Read/write parity. The grid has always hidden ExternalBlock rows, but
    // the atomic guard never checked them - so a stale tab, or any hand-rolled
    // POST, could book straight into the barber's day off.
    const start = at(15, 12);
    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: start,
        endsAt: new Date(start.getTime() + 60 * 60_000),
        reason: "Away",
      },
    });
    await noteAvailabilityChanged(shopId);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId: chairA,
        serviceId: shortId,
        startsAt: start.toISOString(),
        firstName: "Sneaky",
        lastName: "Poster",
        email: "sneaky@example.com",
      });
    expect([400, 409]).toContain(res.status);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    expect(await prisma.appointment.count({ where: { shopId, startsAt: start } })).toBe(0);
    // The barber's own calendar still lets HIM book over it (externalBlocks:
    // "ignore" on the dashboard paths) - the block is his to override.
  });
});
