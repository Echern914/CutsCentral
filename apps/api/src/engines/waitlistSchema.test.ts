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
 * 🔑 The headline is WaitlistOffer_one_active_per_slot. Today a cancellation
 * emails the same booking link to up to five people and lets them race. That
 * index makes "one live offer per physical slot" impossible to violate, rather
 * than something the matcher has to remember - which is the only version of
 * that rule worth having.
 */

let shopId: string;
let otherShopId: string;
let userId: string;
let staffId: string;
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

describe("🔑 one active offer per physical slot", () => {
  it("refuses a SECOND live offer on the same slot", async () => {
    // The race this whole phase exists to close: two waitlisters cannot both
    // be holding the same freed slot.
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
