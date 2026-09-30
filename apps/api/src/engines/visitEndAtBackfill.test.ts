import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { promoteCompletedVisits } from "./statusPromotion.js";

/**
 * FOUR YEARS OF IMPORTED HISTORY THAT NEVER COMPLETED.
 *
 * A live shop's Acuity import stored 19,920 past visits with no end time. The
 * promotion job completes a visit once `endAt < now`, which never matches
 * NULL - so none of them ever completed, and 2,315 of 2,316 clients had no
 * last visit and no tier. Migration 20261037000000 gives each its start + 30
 * minutes (the ingest's own default since 2026-08-05); the promotion job then
 * completes them in bounded batches, newest first.
 *
 * The migration's SQL is read from the migration file and run here, so the
 * test proves the statement that ships, not a copy of it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, "../../../../packages/db/prisma/migrations/20261037000000_visit_endat_backfill/migration.sql"),
  "utf8",
);
/**
 * The shipped statement, scoped to THIS test's shop: the test database is
 * shared, and another file's deliberately endless visit must not change under
 * it mid-run. The scope is appended to the exact WHERE the migration ships.
 */
const SHIPPED_WHERE = `WHERE "endAt" IS NULL;`;
const scopedMigration = () => {
  expect(MIGRATION_SQL).toContain(SHIPPED_WHERE);
  return MIGRATION_SQL.replace(SHIPPED_WHERE, `WHERE "endAt" IS NULL AND "shopId" = '${shopId}';`);
};

let userId = "";
let shopId = "";
let clientId = "";
const NOW = new Date();
const H = 3_600_000;
const DAY = 24 * H;

async function visit(opts: { id?: string; endAgoMs?: number; nullEnd?: boolean; startAgoMs?: number }) {
  const start = new Date(NOW.getTime() - (opts.startAgoMs ?? (opts.endAgoMs ?? 0) + 30 * 60_000));
  return prisma.visit.create({
    data: {
      shopId,
      clientId,
      // Not numeric and not "square:" = ChairBack's own, always verifiable.
      acuityAppointmentId: opts.id ?? `own-${randomToken(8)}`,
      status: "SCHEDULED",
      scheduledAt: start,
      endAt: opts.nullEnd ? null : new Date(NOW.getTime() - (opts.endAgoMs ?? 0)),
    },
    select: { id: true, scheduledAt: true },
  });
}

const statusOf = async (id: string) =>
  (await prisma.visit.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `endat-${randomToken(6)}@test.chairback`, name: "E" } });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "History End Cuts",
      slug: `endat-${randomToken(5)}`,
      webhookSecret: randomToken(),
      timezone: "America/New_York",
      compAccess: true,
    },
  });
  shopId = shop.id;
});

beforeEach(async () => {
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  const c = await prisma.client.create({
    data: { shopId, acuityClientKey: `tel:+1302555${randomToken(4)}`, magicToken: randomToken(), firstName: "Hist" },
  });
  clientId = c.id;
});

afterAll(async () => {
  if (userId) {
    await prisma.shop.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

describe("🔴 the migration gives a missing end time, and the history completes", () => {
  it("a past visit with no end gets start + 30 min, then completes and stamps the client", async () => {
    const v = await visit({ nullEnd: true, startAgoMs: 400 * DAY });
    // Before: the promotion job cannot see it.
    expect(await promoteCompletedVisits(NOW, { shopId })).toBe(0);

    await prisma.$executeRawUnsafe(scopedMigration());
    const row = await prisma.visit.findUniqueOrThrow({ where: { id: v.id }, select: { endAt: true } });
    expect(row.endAt!.getTime()).toBe(v.scheduledAt.getTime() + 30 * 60_000);

    expect(await promoteCompletedVisits(NOW, { shopId })).toBe(1);
    expect(await statusOf(v.id)).toBe("COMPLETED");
    const client = await prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      select: { lastVisitAt: true, loyaltyTier: true },
    });
    expect(client.lastVisitAt!.getTime()).toBe(v.scheduledAt.getTime());
    expect(client.loyaltyTier).toBe("BRONZE");
  });

  it("running it again changes nothing", async () => {
    const v = await visit({ endAgoMs: 2 * DAY });
    const before = await prisma.visit.findUniqueOrThrow({ where: { id: v.id }, select: { endAt: true } });
    await prisma.$executeRawUnsafe(scopedMigration());
    const after = await prisma.visit.findUniqueOrThrow({ where: { id: v.id }, select: { endAt: true } });
    expect(after.endAt).toEqual(before.endAt);
  });
});

describe("🔴 a big backlog completes in bounded batches, newest first", () => {
  it("at most `limit` a run, the most recently ended first, then the rest", async () => {
    const old = await visit({ endAgoMs: 300 * DAY });
    const older = await visit({ endAgoMs: 600 * DAY });
    const fresh = await visit({ endAgoMs: 1 * H });

    expect(await promoteCompletedVisits(NOW, { shopId, limit: 2 })).toBe(2);
    expect(await statusOf(fresh.id)).toBe("COMPLETED");
    expect(await statusOf(old.id)).toBe("COMPLETED");
    expect(await statusOf(older.id)).toBe("SCHEDULED");

    expect(await promoteCompletedVisits(NOW, { shopId, limit: 2 })).toBe(1);
    expect(await statusOf(older.id)).toBe("COMPLETED");
  });

  it("🔴 visits that can't be verified never take up the batch", async () => {
    // Numeric ids = Acuity visits; this shop has no Acuity connection, so they
    // are unverifiable and must be skipped - without starving the rest.
    await visit({ id: String(9_000_000 + Math.floor(Math.random() * 999_999)), endAgoMs: 1 * H });
    await visit({ id: String(9_000_000 + Math.floor(Math.random() * 999_999)), endAgoMs: 2 * H });
    const own = await visit({ endAgoMs: 30 * DAY });
    expect(await promoteCompletedVisits(NOW, { shopId, limit: 1 })).toBe(1);
    expect(await statusOf(own.id)).toBe("COMPLETED");
  });
});
