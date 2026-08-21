import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * Waitlist phase A: the SHAPE, and the guarantees the database itself makes.
 *
 * Nothing reads these columns yet - the client flow, the offer/hold and the
 * matcher land in later PRs. What is worth pinning now is the part that is
 * hard to change later: the constraints, and the promise that existing entries
 * came through the migration behaving exactly as before.
 *
 * 🔑 The headline is WaitlistOffer_no_overlapping_hold. Today a cancellation
 * emails the same booking link to up to five people and lets them race. That
 * constraint makes "one live hold per barber per span" impossible to violate,
 * rather than something the matcher has to remember - which is the only
 * version of that rule worth having.
 *
 * It replaced a partial UNIQUE index on (shopId, staffId, startsAt), which
 * only ever caught holds starting at the same INSTANT. 10:00-11:00 alongside
 * 10:30-11:30 sailed through it and is the same double-book.
 */

let shopId: string;
let otherShopId: string;
let userId: string;
let staffId: string;
let otherStaffId: string;
let serviceId: string;

async function makeEntry(over: Record<string, unknown> = {}) {
  return prisma.waitlistEntry.create({
    data: { shopId, firstName: "Wait", phone: "+15550000001", ...over },
    select: { id: true },
  });
}

/** An offer on a given physical slot. Token is a hash, never the raw value. */
function offerData(entryId: string, startsAt: Date, over: Record<string, unknown> = {}) {
  return {
    shopId,
    entryId,
    staffId,
    serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    tokenHash: `hash-${randomToken(12)}`,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    ...over,
  };
}

/** An offer with an explicit span, for the overlap cases. */
function offerSpan(
  entryId: string,
  startsAt: Date,
  endsAt: Date,
  over: Record<string, unknown> = {},
) {
  return offerData(entryId, startsAt, { endsAt, ...over });
}

const SLOT = new Date("2026-07-06T14:00:00.000Z");

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wl-${randomToken(6)}@test.local`, name: "W" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Waitlist Cuts",
      slug: `wl-${randomToken(5)}`,
      webhookSecret: randomToken(),
    },
    select: { id: true },
  });
  shopId = shop.id;
  const other = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Other",
      slug: `wl2-${randomToken(5)}`,
      webhookSecret: randomToken(),
    },
    select: { id: true },
  });
  otherShopId = other.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  staffId = staff.id;
  const staff2 = await prisma.staff.create({ data: { shopId, name: "Ana" } });
  otherStaffId = staff2.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
  });
  serviceId = svc.id;
});

afterAll(async () => {
  await prisma.waitlistOffer.deleteMany({ where: { shopId } });
  await prisma.waitlistWindow.deleteMany({ where: { shopId } });
  await prisma.waitlistEntry.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

/* ------------------------------------------------------------------ */

describe("nothing changed for an existing entry", () => {
  it("a plain join still works with none of the new fields set", async () => {
    // The public join route was not touched. An entry created the old way must
    // still insert, with every new column null and the default status.
    const e = await prisma.waitlistEntry.create({
      data: { shopId, firstName: "Old", phone: "+15550000009" },
      select: {
        status: true, timezone: true, minHoursNotice: true,
        smsConsentAt: true, cancelTokenHash: true,
        bookedAppointmentId: true, expiresAt: true,
      },
    });
    expect(e.status).toBe("WAITING");
    expect(e.timezone).toBeNull();
    expect(e.minHoursNotice).toBeNull();
    // 🔴 No consent is invented for someone who was never asked.
    expect(e.smsConsentAt).toBeNull();
    expect(e.cancelTokenHash).toBeNull();
    expect(e.bookedAppointmentId).toBeNull();
    expect(e.expiresAt).toBeNull();
  });

  it("the migration's backfill gave every pre-existing entry one Any/Any window", async () => {
    // Re-run the migration's exact INSERT. It is NOT EXISTS-guarded, so a
    // re-applied migration must not hand anyone a second window.
    const before = await prisma.waitlistWindow.count();
    await prisma.$executeRawUnsafe(`
      INSERT INTO "WaitlistWindow" ("id", "shopId", "entryId", "createdAt")
      SELECT gen_random_uuid()::text, w."shopId", w."id", now()
      FROM "WaitlistEntry" w
      WHERE NOT EXISTS (SELECT 1 FROM "WaitlistWindow" x WHERE x."entryId" = w."id");
    `);
    const after = await prisma.waitlistWindow.count();
    // The only new rows are for entries THIS suite created after the migration.
    const orphans = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`
      SELECT count(*) AS n FROM "WaitlistEntry" w
      WHERE NOT EXISTS (SELECT 1 FROM "WaitlistWindow" x WHERE x."entryId" = w."id")
    `);
    expect(Number(orphans[0]!.n)).toBe(0);
    expect(after).toBeGreaterThanOrEqual(before);

    // And a second run adds nothing at all.
    const stable = await prisma.waitlistWindow.count();
    await prisma.$executeRawUnsafe(`
      INSERT INTO "WaitlistWindow" ("id", "shopId", "entryId", "createdAt")
      SELECT gen_random_uuid()::text, w."shopId", w."id", now()
      FROM "WaitlistEntry" w
      WHERE NOT EXISTS (SELECT 1 FROM "WaitlistWindow" x WHERE x."entryId" = w."id");
    `);
    expect(await prisma.waitlistWindow.count()).toBe(stable);
  });
});

describe("status vocabulary", () => {
  it("accepts every value in use plus EXPIRED", async () => {
    for (const status of ["WAITING", "CONTACTED", "BOOKED", "REMOVED", "EXPIRED"]) {
      const e = await makeEntry({ status });
      expect(e.id).toBeTruthy();
    }
  });

  it("refuses a status outside the set", async () => {
    await expect(makeEntry({ status: "SOMETHING_ELSE" })).rejects.toThrow();
  });
});

describe("windows", () => {
  it("stores a single date, a range, and a time window", async () => {
    const e = await makeEntry();
    const w = await prisma.waitlistWindow.create({
      data: {
        shopId,
        entryId: e.id,
        startDate: "2026-07-06",
        endDate: "2026-07-10",
        startMin: 9 * 60,
        endMin: 12 * 60,
      },
      select: { startDate: true, endDate: true, startMin: true, endMin: true },
    });
    expect(w).toEqual({
      startDate: "2026-07-06",
      endDate: "2026-07-10",
      startMin: 540,
      endMin: 720,
    });
  });

  it("refuses a backwards date range", async () => {
    const e = await makeEntry();
    await expect(
      prisma.waitlistWindow.create({
        data: { shopId, entryId: e.id, startDate: "2026-07-10", endDate: "2026-07-06" },
      }),
    ).rejects.toThrow();
  });

  it("refuses a backwards or half-set time range", async () => {
    const e = await makeEntry();
    await expect(
      prisma.waitlistWindow.create({
        data: { shopId, entryId: e.id, startMin: 720, endMin: 540 },
      }),
    ).rejects.toThrow();
    // Half a time window is meaningless - "from 9am until unspecified" would
    // silently match all afternoon.
    await expect(
      prisma.waitlistWindow.create({ data: { shopId, entryId: e.id, startMin: 540 } }),
    ).rejects.toThrow();
  });

  it("cascades away with its entry", async () => {
    const e = await makeEntry();
    await prisma.waitlistWindow.create({ data: { shopId, entryId: e.id } });
    await prisma.waitlistEntry.delete({ where: { id: e.id } });
    expect(await prisma.waitlistWindow.count({ where: { entryId: e.id } })).toBe(0);
  });
});

describe("🔑 a hold is on ONE real barber", () => {
  it("refuses an offer with no staffId at all", async () => {
    // Why this matters: a partial UNIQUE index treats nulls as distinct, so if
    // staffId were nullable, N holds with a null barber on one slot would ALL
    // insert and the guarantee would quietly be nothing. An ENTRY may say "any
    // barber"; a HOLD is on someone's actual calendar, so there is no null to
    // slip through. Raw SQL because the generated types refuse to express it.
    const a = await makeEntry();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "WaitlistOffer"
           ("id","shopId","entryId","staffId","serviceId","startsAt","endsAt",
            "tokenHash","status","expiresAt","updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, NULL, $3,
                 '2026-07-20T09:00:00'::timestamp, '2026-07-20T10:00:00'::timestamp,
                 $4, 'OFFERED', now() + interval '30 minutes', now())`,
        shopId,
        a.id,
        serviceId,
        "hash-" + randomToken(12),
      ),
      // 23502 = not_null_violation. Asserted by code, because Prisma wraps raw
      // errors and does not pass the "null value in column" text through.
    ).rejects.toThrow(/23502/);
  });
});

describe("🔑 one live hold per barber per span", () => {
  it("refuses a second live hold that OVERLAPS an existing one", async () => {
    // The case the old partial-unique index waved through: different start,
    // same barber, colliding spans. 10:00-11:00 then 10:30-11:30.
    const a = await makeEntry();
    const b = await makeEntry();
    await prisma.waitlistOffer.create({
      data: offerSpan(
        a.id,
        new Date("2026-07-21T10:00:00.000Z"),
        new Date("2026-07-21T11:00:00.000Z"),
      ),
    });
    await expect(
      prisma.waitlistOffer.create({
        data: offerSpan(
          b.id,
          new Date("2026-07-21T10:30:00.000Z"),
          new Date("2026-07-21T11:30:00.000Z"),
        ),
      }),
    ).rejects.toThrow(/exclusion constraint|WaitlistOffer_no_overlapping_hold/i);
  });

  it("refuses one wholly CONTAINED by another", async () => {
    // A short service offered inside a long one's span is still the same chair
    // at the same moment.
    const a = await makeEntry();
    const b = await makeEntry();
    await prisma.waitlistOffer.create({
      data: offerSpan(
        a.id,
        new Date("2026-07-22T10:00:00.000Z"),
        new Date("2026-07-22T12:00:00.000Z"),
      ),
    });
    await expect(
      prisma.waitlistOffer.create({
        data: offerSpan(
          b.id,
          new Date("2026-07-22T10:15:00.000Z"),
          new Date("2026-07-22T10:45:00.000Z"),
        ),
      }),
    ).rejects.toThrow();
  });

  it("refuses a SECOND live offer starting at the same instant", async () => {
    // The original case still holds - a non-empty range always overlaps
    // itself, so the exclusion constraint subsumes the unique index it
    // replaced. This is the race the whole phase exists to close.
    const a = await makeEntry();
    const b = await makeEntry();
    await prisma.waitlistOffer.create({ data: offerData(a.id, SLOT) });
    await expect(
      prisma.waitlistOffer.create({ data: offerData(b.id, SLOT) }),
    ).rejects.toThrow();
  });

  it("frees the slot once the first offer EXPIRES", async () => {
    // Partial on status='OFFERED': a lapsed hold must not block the slot being
    // passed to the next eligible client, which is the release path.
    const slot = new Date("2026-07-06T15:00:00.000Z");
    const a = await makeEntry();
    const b = await makeEntry();
    const first = await prisma.waitlistOffer.create({ data: offerData(a.id, slot) });

    await prisma.waitlistOffer.update({
      where: { id: first.id },
      data: { status: "EXPIRED" },
    });
    const second = await prisma.waitlistOffer.create({ data: offerData(b.id, slot) });
    expect(second.id).not.toBe(first.id);
  });

  it("frees it on RELEASED too, and after a CLAIM", async () => {
    for (const terminal of ["RELEASED", "CLAIMED"]) {
      const slot = new Date(`2026-07-07T1${terminal === "RELEASED" ? 0 : 1}:00:00.000Z`);
      const a = await makeEntry();
      const b = await makeEntry();
      const first = await prisma.waitlistOffer.create({ data: offerData(a.id, slot) });
      await prisma.waitlistOffer.update({
        where: { id: first.id },
        data: { status: terminal },
      });
      await expect(
        prisma.waitlistOffer.create({ data: offerData(b.id, slot) }),
      ).resolves.toBeTruthy();
    }
  });

  it("lets DIFFERENT slots be offered at once", async () => {
    const a = await makeEntry();
    await expect(
      prisma.waitlistOffer.create({
        data: offerData(a.id, new Date("2026-07-08T09:00:00.000Z")),
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.waitlistOffer.create({
        data: offerData(a.id, new Date("2026-07-08T10:00:00.000Z")),
      }),
    ).resolves.toBeTruthy();
  });

  it("ALLOWS back-to-back holds - 10:00-11:00 then 11:00-12:00", async () => {
    // The half-open range earning its keep. An over-eager constraint here
    // would refuse the next real slot on a busy day and cost the shop the
    // booking, which is a worse bug than the one being fixed.
    const a = await makeEntry();
    const b = await makeEntry();
    await prisma.waitlistOffer.create({
      data: offerSpan(
        a.id,
        new Date("2026-07-23T10:00:00.000Z"),
        new Date("2026-07-23T11:00:00.000Z"),
      ),
    });
    await expect(
      prisma.waitlistOffer.create({
        data: offerSpan(
          b.id,
          new Date("2026-07-23T11:00:00.000Z"),
          new Date("2026-07-23T12:00:00.000Z"),
        ),
      }),
    ).resolves.toBeTruthy();
  });

  it("lets ANOTHER barber hold the very same span", async () => {
    // Two chairs, two customers, one clock. Scoping the constraint to the
    // barber is what keeps a busy shop working.
    const a = await makeEntry();
    const b = await makeEntry();
    const span = [
      new Date("2026-07-24T10:00:00.000Z"),
      new Date("2026-07-24T11:00:00.000Z"),
    ] as const;
    await prisma.waitlistOffer.create({ data: offerSpan(a.id, span[0], span[1]) });
    await expect(
      prisma.waitlistOffer.create({
        data: offerSpan(b.id, span[0], span[1], { staffId: otherStaffId }),
      }),
    ).resolves.toBeTruthy();
  });

  it("frees an OVERLAPPING span too once the hold lapses", async () => {
    // The release path, on the overlap rule rather than the exact-start one:
    // a lapsed 10:00-11:00 must not keep blocking a 10:30 offer to the next
    // person in the queue.
    const a = await makeEntry();
    const b = await makeEntry();
    const first = await prisma.waitlistOffer.create({
      data: offerSpan(
        a.id,
        new Date("2026-07-25T10:00:00.000Z"),
        new Date("2026-07-25T11:00:00.000Z"),
      ),
    });
    await prisma.waitlistOffer.update({
      where: { id: first.id },
      data: { status: "EXPIRED" },
    });
    await expect(
      prisma.waitlistOffer.create({
        data: offerSpan(
          b.id,
          new Date("2026-07-25T10:30:00.000Z"),
          new Date("2026-07-25T11:30:00.000Z"),
        ),
      }),
    ).resolves.toBeTruthy();
  });
});

describe("offer integrity", () => {
  it("refuses a duplicate token hash", async () => {
    const a = await makeEntry();
    const shared = `hash-${randomToken(12)}`;
    await prisma.waitlistOffer.create({
      data: offerData(a.id, new Date("2026-07-09T09:00:00.000Z"), { tokenHash: shared }),
    });
    await expect(
      prisma.waitlistOffer.create({
        data: offerData(a.id, new Date("2026-07-09T10:00:00.000Z"), { tokenHash: shared }),
      }),
    ).rejects.toThrow();
  });

  it("refuses an offer that ends before it starts", async () => {
    const a = await makeEntry();
    await expect(
      prisma.waitlistOffer.create({
        data: offerData(a.id, new Date("2026-07-09T11:00:00.000Z"), {
          endsAt: new Date("2026-07-09T10:00:00.000Z"),
        }),
      }),
    ).rejects.toThrow();
  });

  it("refuses a status outside the set", async () => {
    const a = await makeEntry();
    await expect(
      prisma.waitlistOffer.create({
        data: offerData(a.id, new Date("2026-07-09T12:00:00.000Z"), { status: "PENDING" }),
      }),
    ).rejects.toThrow();
  });
});

describe("tenant isolation", () => {
  it("has RLS enabled and FORCED with a policy on both new tables", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { relname: string; rls: boolean; forced: boolean; pol: bigint }[]
    >(`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies WHERE tablename = c.relname) AS pol
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('WaitlistWindow', 'WaitlistOffer')
    `);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.rls, `${r.relname} RLS`).toBe(true);
      expect(r.forced, `${r.relname} FORCE`).toBe(true);
      expect(Number(r.pol), `${r.relname} policies`).toBeGreaterThanOrEqual(1);
    }
  });
});
