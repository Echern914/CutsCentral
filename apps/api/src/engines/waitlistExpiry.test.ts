import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import {
  __lastSweepStatsForTests,
  expireDeadWaitlistEntries,
} from "./waitlistExpiry.js";
import { claimOffer, mintClaimToken } from "./waitlistOffer.js";
import { logger } from "../logger.js";

/**
 * Waitlist phase F2: the sweeper itself.
 *
 * waitlistExpiryRule.test.ts pins WHEN an entry is finished. This pins what
 * the worker does about it - which rows it will touch, which it refuses to,
 * and what survives two of them running at once.
 *
 * The load-bearing test here is the live-offer one. Everything else is
 * bookkeeping; that one is the difference between a tidy list and an
 * appointment nobody can explain.
 */

const TZ = "America/New_York";
let shopId: string;
let staffId: string;
let serviceId: string;
let seq = 0;

/** Both halves nullable: null means "any", and a null date is a legacy row. */
type Win = {
  startDate: string | null;
  endDate: string | null;
  startMin?: number | null;
  endMin?: number | null;
};

/** A window that closed yesterday, in the shop's own zone. */
function deadWindow(): Win {
  const y = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
  return { startDate: y, endDate: y, startMin: null, endMin: null };
}
/** A window well beyond any horizon this suite reaches. */
function liveWindow(): Win {
  const d = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  return { startDate: d, endDate: d, startMin: null, endMin: null };
}

async function makeEntry(windows: Win[], over: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.waitlistEntry.create({
    data: {
      shopId,
      firstName: `Exp${seq}`,
      email: `wl-f2-${seq}-${randomToken(4)}@test.local`,
      status: "WAITING",
      windows: { create: windows.map((w) => ({ shopId, ...w })) },
      ...over,
    },
    select: { id: true },
  });
}

const statusOf = async (id: string) =>
  (await prisma.waitlistEntry.findUnique({ where: { id }, select: { status: true } }))!.status;

const auditFor = (entryId: string, type = "entry.expired_auto") =>
  prisma.waitlistEvent.findMany({ where: { entryId, type } });

/** Run the real sweep with writes on, regardless of the (off) feature flag. */
const sweep = (now = new Date(), o: { budgetMs?: number } = {}) =>
  expireDeadWaitlistEntries(now, { dryRun: false, ...o });

let slotSeq = 0;
function futureSlot() {
  const base = Math.ceil((Date.now() + 72 * 3600_000) / 1800_000) * 1800_000;
  const startsAt = new Date(base + slotSeq++ * 2 * 3600_000);
  return { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wl-f2-${randomToken(6)}@test.local`, name: "F2" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Expiry Cuts",
      slug: `wl-f2-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: TZ,
      bookingMode: "native",
      waitlistEnabled: true,
      slotOpenedTextsEnabled: true,
      bookingBufferMin: 0,
      bookingLeadHours: 0,
      trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30 },
    select: { id: true },
  });
  serviceId = svc.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  await prisma.availabilityRule.createMany({
    data: Array.from({ length: 7 }, (_, weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 0,
      endMin: 1440,
    })),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.waitlistOffer.updateMany({
    where: { shopId, status: "OFFERED" },
    data: { status: "RELEASED" },
  });
  await prisma.waitlistEntry.updateMany({
    where: { shopId, status: { in: ["WAITING", "CONTACTED"] } },
    data: { status: "REMOVED" },
  });
});

// ───────────────────────────────────────── what it retires

describe("what the sweep retires", () => {
  it("a WAITING entry whose only window has closed", async () => {
    const e = await makeEntry([deadWindow()]);
    await sweep();
    expect(await statusOf(e.id)).toBe("EXPIRED");
  });

  it("a CONTACTED entry too - a barber reaching out does not extend the window", async () => {
    const e = await makeEntry([deadWindow()], { status: "CONTACTED" });
    await sweep();
    expect(await statusOf(e.id)).toBe("EXPIRED");
  });

  it("stamps expiresAt and writes one audit event with an honest actor", async () => {
    const now = new Date();
    const e = await makeEntry([deadWindow()]);
    await sweep(now);

    const row = await prisma.waitlistEntry.findUnique({
      where: { id: e.id },
      select: { expiresAt: true },
    });
    expect(row!.expiresAt?.getTime()).toBe(now.getTime());

    const [ev] = await auditFor(e.id);
    expect(ev!.actorType).toBe("system");
    expect(ev!.actorUserId).toBeNull();
    expect(ev!.metadata).toMatchObject({
      fromStatus: "WAITING",
      toStatus: "EXPIRED",
      windowCount: 1,
      tzSource: "shop",
    });
  });

  it("records whose clock decided it", async () => {
    const e = await makeEntry([deadWindow()], { timezone: "Asia/Tokyo" });
    await sweep();
    const [ev] = await auditFor(e.id);
    expect(ev!.metadata).toMatchObject({ tzSource: "entry" });
  });
});

// ───────────────────────────────────────── what it refuses

describe("what the sweep refuses to touch", () => {
  it("🔴 a legacy NULL-date entry, however old", async () => {
    const e = await makeEntry([{ startDate: null, endDate: null, startMin: null, endMin: null }], {
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    await sweep();
    expect(await statusOf(e.id)).toBe("WAITING");
    expect(await auditFor(e.id)).toHaveLength(0);
  });

  it("🔴 an entry with no windows at all", async () => {
    const e = await makeEntry([]);
    await sweep();
    expect(await statusOf(e.id)).toBe("WAITING");
  });

  it("an entry with one window still to come", async () => {
    const e = await makeEntry([deadWindow(), liveWindow()]);
    await sweep();
    expect(await statusOf(e.id)).toBe("WAITING");
  });

  it("🔴 BOOKED, REMOVED and EXPIRED are never re-touched", async () => {
    const booked = await makeEntry([deadWindow()], { status: "BOOKED" });
    const removed = await makeEntry([deadWindow()], { status: "REMOVED" });
    const already = await makeEntry([deadWindow()], { status: "EXPIRED" });
    await sweep();
    expect(await statusOf(booked.id)).toBe("BOOKED");
    expect(await statusOf(removed.id)).toBe("REMOVED");
    expect(await statusOf(already.id)).toBe("EXPIRED");
    for (const e of [booked, removed, already]) expect(await auditFor(e.id)).toHaveLength(0);
  });

  it("🔴 ships DARK: called the way the cron calls it, it writes nothing", async () => {
    // No opts at all - exactly how scheduler.ts invokes it. The flag defaults
    // to false, so a deploy of this PR changes no customer's status.
    expect(apiEnv().WAITLIST_ENTRY_EXPIRY_ENABLED).toBe(false);
    const e = await makeEntry([deadWindow()]);
    const res = await expireDeadWaitlistEntries();
    expect(res.expired).toBe(0);
    expect(await statusOf(e.id)).toBe("WAITING");
    expect(await auditFor(e.id)).toHaveLength(0);
  });

  it("writes nothing at all in preview mode - which is also what the flag being off does", async () => {
    const e = await makeEntry([deadWindow()]);
    const res = await expireDeadWaitlistEntries(new Date(), { dryRun: true });
    expect(res.expired).toBe(0);
    expect(res.eligible).toBeGreaterThanOrEqual(1);
    expect(await statusOf(e.id)).toBe("WAITING");
    expect(await auditFor(e.id)).toHaveLength(0);
  });
});

// ───────────────────────────────────────── the race that matters

describe("a live hold outranks the sweep", () => {
  /**
   * The real sequence: an offer is minted at 17:45 for an 18:00 slot against
   * a window that closes at 18:00, and the hold runs to 18:15. Between 18:00
   * and 18:15 the entry satisfies the expiry rule while its claim link is
   * already in the customer's inbox. The hold is created directly here for
   * exactly that reason - the matcher would not mint one against a window
   * that has already closed, which is the whole point.
   */
  async function entryWithLiveHold() {
    const e = await makeEntry([deadWindow()]);
    const { startsAt, endsAt } = futureSlot();
    const { token, hash } = mintClaimToken();
    await prisma.waitlistOffer.create({
      data: {
        shopId,
        entryId: e.id,
        staffId,
        serviceId,
        startsAt,
        endsAt,
        tokenHash: hash,
        status: "OFFERED",
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    return { entryId: e.id, token };
  }

  it("🔴 the entry is skipped while its claim link is still valid", async () => {
    // Remove the live-offer skip from the worker and this test fails: the
    // entry expires, and the claim below then leaves a real appointment with
    // bookedAppointmentId null - the exact lie #265 was built to prevent.
    const { entryId } = await entryWithLiveHold();

    const res = await sweep();
    expect(await statusOf(entryId)).toBe("WAITING");
    expect(await auditFor(entryId)).toHaveLength(0);
    expect(res.heldBack).toBeGreaterThanOrEqual(1);
  });

  it("🔴 the claim then WINS: BOOKED, with a real appointment attached", async () => {
    const { entryId, token } = await entryWithLiveHold();
    await sweep(); // the tick that must not have interfered

    const claimed = await claimOffer({ token, now: new Date() });
    expect(claimed.outcome).toBe("claimed");

    const entry = await prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: { status: true, bookedAppointmentId: true },
    });
    expect(entry!.status).toBe("BOOKED");
    // The assertion that would fail if the sweep had expired the entry first:
    // the claim's `status IN ('WAITING','CONTACTED')` guard would have matched
    // nothing and left this null beside a real appointment.
    expect(entry!.bookedAppointmentId).not.toBeNull();
  });

  it("once the hold lapses, the next tick retires the entry", async () => {
    const { entryId } = await entryWithLiveHold();
    await sweep();
    expect(await statusOf(entryId)).toBe("WAITING");

    // Nothing is lost - the hold expires and the very next sweep settles it.
    await prisma.waitlistOffer.updateMany({
      where: { entryId, status: "OFFERED" },
      data: { status: "EXPIRED" },
    });
    await sweep();
    expect(await statusOf(entryId)).toBe("EXPIRED");
  });
});

// ───────────────────────────────────────── running it twice

describe("running it more than once", () => {
  it("🔴 two workers racing produce exactly ONE audit event", async () => {
    const e = await makeEntry([deadWindow()]);
    // The job_lease makes this single-flight in production; the CAS is what
    // makes a double-run harmless anyway.
    await Promise.all([sweep(), sweep()]);
    expect(await statusOf(e.id)).toBe("EXPIRED");
    expect(await auditFor(e.id)).toHaveLength(1);
  });

  it("a second sweep is a no-op, not a second expiry", async () => {
    const e = await makeEntry([deadWindow()]);
    await sweep();
    const again = await sweep();
    expect(await auditFor(e.id)).toHaveLength(1);
    expect(again.expired).toBe(0);
  });
});

// ───────────────────────────────────────── bounded, never silently

describe("the time budget", () => {
  it("🔑 reports budget_exhausted rather than truncating quietly", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => {}) as never);
    const e = await makeEntry([deadWindow()]);

    const res = await expireDeadWaitlistEntries(new Date(), { dryRun: false, budgetMs: -1 });
    expect(res.budgetExhausted).toBe(true);
    expect(res.expired).toBe(0);
    expect(
      warn.mock.calls.some((c) => (c[0] as { code?: string })?.code === "budget_exhausted"),
    ).toBe(true);

    // 🔑 And nothing was LOST: the row is untouched and the next full tick
    // finishes the job. Expiring a row removes it from the scan's own WHERE
    // clause, so restarting from the beginning always makes progress.
    expect(await statusOf(e.id)).toBe("WAITING");
    const done = await sweep();
    expect(done.budgetExhausted).toBe(false);
    expect(await statusOf(e.id)).toBe("EXPIRED");
  });
});

// ───────────────────────────────────────── one bad row

describe("one corrupt row cannot stop the sweep", () => {
  it("keeps going and still retires the others", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation((() => {}) as never);
    // A timezone no formatter can build. resolveMatchTimezone rejects it and
    // falls back, so this also proves bad data does not become an exception -
    // and the neighbours are retired either way.
    const bad = await makeEntry([deadWindow()], { timezone: "Not/AZone" });
    const good = await makeEntry([deadWindow()]);

    await expect(sweep()).resolves.toBeTruthy();
    expect(await statusOf(good.id)).toBe("EXPIRED");
    // Whatever happened to the bad row, it was not an unhandled throw.
    expect(["EXPIRED", "WAITING"]).toContain(await statusOf(bad.id));
    error.mockRestore();
  });
});

// ───────────────────────────────────────── log hygiene

describe("log hygiene", () => {
  it("🔴 no name, address, number, zone or window reaches a log line", async () => {
    const lines: unknown[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((o: unknown, m: unknown) => {
        lines.push(o, m);
      }) as never);
    }

    const dead = deadWindow();
    const e = await prisma.waitlistEntry.create({
      data: {
        shopId,
        firstName: "Marcus",
        lastName: "Reed",
        phone: "+12025550171",
        email: "marcus.reed@test.local",
        note: "prefers the chair by the window",
        timezone: "Asia/Tokyo",
        minHoursNotice: 48,
        status: "WAITING",
        windows: { create: [{ shopId, ...dead }] },
      },
      select: { id: true },
    });
    await sweep();

    const dump = JSON.stringify(lines);
    for (const needle of [
      "Marcus",
      "Reed",
      "marcus.reed@test.local",
      "+12025550171",
      "2025550171",
      "prefers the chair",
      "Asia/Tokyo",
      dead.startDate!,
    ]) {
      expect(dump, `leaked: ${needle}`).not.toContain(needle);
    }
    // Not a vacuous pass: the sweep really did log, and what it logged was
    // the entry id and a code - which is exactly what is allowed.
    expect(await statusOf(e.id)).toBe("EXPIRED");
    expect(dump).toContain(e.id);
    expect(dump).toContain('"code":"expired"');
  });
});

// ───────────────────────────────────────── scale

describe("scale", () => {
  it(
    "🔑 5,000 entries: the one that expires sits at the END and is still found",
    async () => {
      const N = 5_000;
      const base = Date.now() - 400 * 86_400_000; // deterministic keyset order
      const live = liveWindow();
      const dead = deadWindow();

      const entries = Array.from({ length: N }, (_, i) => ({
        id: `f2bench-${randomToken(6)}-${i}`,
        shopId,
        firstName: `Bench${i}`,
        status: "WAITING",
        createdAt: new Date(base + i * 1000),
      }));
      // The row that must be found: LAST in (createdAt, id) order, so a scan
      // that stops early - or pages with a shifting OFFSET - misses it.
      const target = {
        id: `f2bench-target-${randomToken(6)}`,
        shopId,
        firstName: "BenchTarget",
        status: "WAITING",
        createdAt: new Date(base + N * 1000),
      };

      await prisma.waitlistEntry.createMany({ data: [...entries, target] });
      await prisma.waitlistWindow.createMany({
        data: [
          ...entries.map((e) => ({ shopId, entryId: e.id, ...live })),
          { shopId, entryId: target.id, ...dead },
        ],
      });

      const t0 = Date.now();
      const res = await sweep();
      const elapsed = Date.now() - t0;

      expect(await statusOf(target.id)).toBe("EXPIRED");
      expect(await auditFor(target.id)).toHaveLength(1);
      expect(__lastSweepStatsForTests.scanned).toBeGreaterThanOrEqual(N + 1);
      // No correctness cap: the walk ran to exhaustion.
      expect(res.budgetExhausted).toBe(false);

      // eslint-disable-next-line no-console
      console.log(
        `[F2 benchmark] scanned=${__lastSweepStatsForTests.scanned} ` +
          `pages=${__lastSweepStatsForTests.pages} elapsed=${elapsed}ms ` +
          `queries≈${__lastSweepStatsForTests.pages + 1} expired=${res.expired}`,
      );

      await prisma.waitlistEntry.deleteMany({ where: { id: { startsWith: "f2bench-" } } });
    },
    120_000,
  );
});
