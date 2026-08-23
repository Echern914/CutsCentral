import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { hasActiveAccess } from "../billing/stripe.js";

/**
 * Removing the free plan: the 30-day grace backfill.
 *
 * The risk this covers is not "does the UPDATE run" - it is who it touches.
 * Too wide and it hands 30 free days to shops that are paying or that already
 * cancelled; too narrow and a barber who has been on the free tier for months
 * loses their shop the morning this deploys, with no email.
 *
 * The migration SQL is read off disk and executed here rather than retyped, so
 * this cannot drift away from what actually ships.
 */

const MIGRATION = path.resolve(
  process.cwd(),
  "../../packages/db/prisma/migrations/20260823120000_end_free_plan_grace/migration.sql",
);

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY);
const ahead = (d: number) => new Date(Date.now() + d * DAY);

let userId: string;
const ids: Record<string, string> = {};

async function makeShop(
  key: string,
  data: {
    trialEndsAt: Date | null;
    subscriptionStatus?: string;
    compAccess?: boolean;
    trialReminderStage?: number;
  },
) {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: `Grace ${key}`,
      slug: `grace-${randomToken(6)}`,
      webhookSecret: randomToken(),
      trialReminderStage: 3,
      ...data,
    },
    select: { id: true },
  });
  ids[key] = shop.id;
  return shop.id;
}

const reload = (key: string) =>
  prisma.shop.findUniqueOrThrow({
    where: { id: ids[key] },
    select: {
      trialEndsAt: true,
      trialReminderStage: true,
      subscriptionStatus: true,
      compAccess: true,
    },
  });

async function runMigration() {
  await prisma.$executeRawUnsafe(readFileSync(MIGRATION, "utf8"));
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `grace-${randomToken(6)}@test.local`, name: "G" },
    select: { id: true },
  });
  userId = user.id;

  // The population this exists for: signed up, trialled, never paid, still
  // using ChairBack for nothing.
  await makeShop("lapsedFree", { trialEndsAt: ago(60) });
  // Predates trials entirely.
  await makeShop("neverHadTrial", { trialEndsAt: null });
  // Must NOT be touched.
  await makeShop("paying", { trialEndsAt: ago(60), subscriptionStatus: "active" });
  await makeShop("cancelled", { trialEndsAt: ago(60), subscriptionStatus: "canceled" });
  await makeShop("comped", { trialEndsAt: ago(60), compAccess: true });
  await makeShop("stillInTrial", { trialEndsAt: ahead(9), trialReminderStage: 1 });

  await runMigration();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("who gets the grace window", () => {
  it("a lapsed free shop gets 30 more days", async () => {
    const s = await reload("lapsedFree");
    expect(s.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(s.trialEndsAt!.getTime()).toBeLessThan(Date.now() + 31 * DAY);
  });

  it("so does a shop old enough to have no trial at all", async () => {
    const s = await reload("neverHadTrial");
    expect(s.trialEndsAt).not.toBeNull();
    expect(s.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it("🔑 resets the reminder stage, or they are warned by NOTHING", async () => {
    // runTrialReminders filters trialReminderStage < 3. Every shop in this
    // population is already sitting at 3, so without the reset the grace
    // window passes in total silence and the wall is a surprise.
    expect((await reload("lapsedFree")).trialReminderStage).toBe(0);
    expect((await reload("neverHadTrial")).trialReminderStage).toBe(0);
  });

  it("grants access for the length of the window", async () => {
    const s = await reload("lapsedFree");
    expect(hasActiveAccess(s, { enabled: true })).toBe(true);
  });
});

describe("who it must leave alone", () => {
  it("a paying shop keeps its own dates", async () => {
    const s = await reload("paying");
    expect(s.trialEndsAt!.getTime()).toBeLessThan(Date.now());
    expect(s.trialReminderStage).toBe(3);
  });

  it("a CANCELLED shop gets nothing - it chose to leave and already knows", async () => {
    const s = await reload("cancelled");
    expect(s.trialEndsAt!.getTime()).toBeLessThan(Date.now());
  });

  it("a comped shop is untouched", async () => {
    const s = await reload("comped");
    expect(s.trialEndsAt!.getTime()).toBeLessThan(Date.now());
    expect(s.compAccess).toBe(true);
  });

  it("a shop MID-trial keeps the end date it was promised", async () => {
    // Its trial is in the future, so the WHERE misses it. Extending here would
    // silently hand a nine-days-left shop a fresh 30.
    const s = await reload("stillInTrial");
    expect(s.trialEndsAt!.getTime()).toBeLessThan(Date.now() + 10 * DAY);
    expect(s.trialReminderStage).toBe(1);
  });
});

describe("idempotency", () => {
  it("a second run cannot stack another 30 days", async () => {
    // No NOT EXISTS guard: after the first pass trialEndsAt is in the future,
    // so the WHERE stops matching. Worth pinning, because a re-run is exactly
    // what a migration replay or a manual re-apply would do.
    const before = (await reload("lapsedFree")).trialEndsAt!.getTime();
    await runMigration();
    const after = (await reload("lapsedFree")).trialEndsAt!.getTime();
    expect(after).toBe(before);
  });
});
