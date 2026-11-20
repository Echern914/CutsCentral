import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { hasActiveAccess } from "../billing/stripe.js";
import { buildTrialEmail } from "../messaging/trialEmails.js";
import { trialStageAt } from "./trialReminder.js";

/**
 * SHOPS THAT SIGNED UP ON THE 7-DAY TRIAL GET 14.
 *
 * The trial was 7 days from 2026-11-08 (#740) until the owner put it back to
 * 14 on 2026-11-20. Signup saves the end date on the shop, so migration
 * 20261096000000 gives the shops caught in between their other 7 days.
 *
 * The migration's SQL is read from the migration file and run here, so the
 * test proves the statement that ships, not a copy of it.
 *
 * Every fixture date is relative to the real clock (the statement reads the
 * database's now()). "Created N days ago" is always after the 2026-11-09
 * cutover, so nothing here expires.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, "../../../../packages/db/prisma/migrations/20261096000000_extend_seven_day_trials/migration.sql"),
  "utf8",
);
/**
 * The shipped statement, scoped to THIS test's shops: the test database is
 * shared, and another file's shop must not change under it mid-run. The scope
 * is appended to the exact last condition the migration ships.
 */
const SHIPPED_TAIL = "BETWEEN 601200 AND 608400;";
const SHIPPED_NOW = "(now() AT TIME ZONE 'UTC')";
/** `asOf` stands in for the database clock, for the one case the real clock cannot reach. */
const scopedMigration = (asOf?: string) => {
  expect(MIGRATION_SQL).toContain(SHIPPED_TAIL);
  expect(MIGRATION_SQL).toContain(SHIPPED_NOW);
  const scoped = MIGRATION_SQL.replace(
    SHIPPED_TAIL,
    `BETWEEN 601200 AND 608400 AND "ownerId" IN (${userIds.map((id) => `'${id}'`).join(", ")});`,
  );
  return asOf ? scoped.replace(SHIPPED_NOW, `TIMESTAMP '${asOf}'`) : scoped;
};

const DAY = 86_400_000;
const NOW = new Date();
const userIds: string[] = [];

async function shop(opts: {
  createdAt: Date;
  trialEndsAt: Date | null;
  stage?: number;
  subscriptionStatus?: string;
}) {
  const user = await prisma.user.create({
    data: { email: `trial14-${randomToken(6)}@test.chairback`, name: "T" },
  });
  userIds.push(user.id);
  return prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Fourteen Day Cuts",
      slug: `trial14-${randomToken(5)}`,
      webhookSecret: randomToken(),
      createdAt: opts.createdAt,
      trialEndsAt: opts.trialEndsAt,
      trialReminderStage: opts.stage ?? 0,
      subscriptionStatus: opts.subscriptionStatus ?? "none",
    },
  });
}
/** A shop that signed up `ageDays` ago on a trial `trialDays` long. */
const signedUp = (ageDays: number, trialDays: number, rest: { stage?: number; subscriptionStatus?: string } = {}) => {
  const createdAt = new Date(NOW.getTime() - ageDays * DAY);
  return shop({ createdAt, trialEndsAt: new Date(createdAt.getTime() + trialDays * DAY), ...rest });
};
const reread = (id: string) =>
  prisma.shop.findUniqueOrThrow({
    where: { id },
    select: { trialEndsAt: true, trialReminderStage: true },
  });
const run = (asOf?: string) => prisma.$executeRawUnsafe(scopedMigration(asOf));

afterAll(async () => {
  if (userIds.length) {
    await prisma.shop.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

describe("🔴 the migration gives a 7-day shop its other 7 days", () => {
  it("a shop mid-trial ends a week later than it did", async () => {
    const s = await signedUp(3, 7);
    await run();
    const after = await reread(s.id);
    expect(after.trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime() + 7 * DAY);
    expect(after.trialReminderStage).toBe(0);
  });

  it("a shop already told 'ends in 3 days' starts its reminders over", async () => {
    const s = await signedUp(5, 7, { stage: 1 });
    await run();
    const after = await reread(s.id);
    expect(after.trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime() + 7 * DAY);
    expect(after.trialReminderStage).toBe(0);
  });

  it("🔴 a shop whose 7 days ran out is unlocked, and hears how long it has", async () => {
    const s = await signedUp(9, 7, { stage: 3 });
    const before = await prisma.shop.findUniqueOrThrow({ where: { id: s.id } });
    expect(hasActiveAccess(before, { now: NOW, enabled: true })).toBe(false);

    await run();
    const after = await prisma.shop.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime() + 7 * DAY);
    expect(hasActiveAccess(after, { now: NOW, enabled: true })).toBe(true);

    // The mark is back below what the clock says, so the next sweep sends the
    // first reminder, with the real number of days: 14 - 9 = 5. (The sweep
    // itself is not run here: on the real clock it would advance other files'
    // shops in the shared test database.)
    expect(after.trialReminderStage).toBe(0);
    expect(trialStageAt(after.trialEndsAt!, NOW)).toBe(1);
    const email = buildTrialEmail(1, {
      shopName: after.name,
      ownerName: "T",
      trialEndsAt: after.trialEndsAt!,
      now: NOW,
      plans: [],
    });
    expect(email.subject).toContain("ends in 5 days");
  });

  it("a referred shop (7 days + a 30-day month) gets its 7 days too", async () => {
    const s = await signedUp(2, 37);
    await run();
    expect((await reread(s.id)).trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime() + 7 * DAY);
  });

  it("a shop still locked after the extra week keeps its reminder mark", async () => {
    // Cannot exist until 2026-11-23, but a late deploy must not re-send
    // "your trial has ended" to a shop that already heard it. Fixed dates, and
    // a stand-in clock a month on: the real one cannot produce this shop yet.
    const createdAt = new Date("2026-11-10T15:00:00.000Z");
    const s = await shop({ createdAt, trialEndsAt: new Date(createdAt.getTime() + 7 * DAY), stage: 4 });
    await run("2026-12-15 00:00:00");
    const after = await reread(s.id);
    expect(after.trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime() + 7 * DAY);
    expect(after.trialReminderStage).toBe(4);
  });
});

describe("🔴 the migration leaves every other shop alone", () => {
  it("a shop that signed up on 14 days", async () => {
    const s = await signedUp(1, 14);
    await run();
    expect((await reread(s.id)).trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime());
  });

  it("a shop that already subscribed", async () => {
    const s = await signedUp(3, 7, { subscriptionStatus: "active", stage: 1 });
    await run();
    const after = await reread(s.id);
    expect(after.trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime());
    expect(after.trialReminderStage).toBe(1);
  });

  it("a shop from before the trial was 7 days, whatever its dates look like", async () => {
    const createdAt = new Date("2026-11-01T15:00:00.000Z");
    const s = await shop({ createdAt, trialEndsAt: new Date(createdAt.getTime() + 7 * DAY), stage: 3 });
    await run();
    const after = await reread(s.id);
    expect(after.trialEndsAt!.getTime()).toBe(s.trialEndsAt!.getTime());
    expect(after.trialReminderStage).toBe(3);
  });

  it("a shop with a trial date set by hand, or none", async () => {
    const odd = await signedUp(3, 10);
    const none = await shop({ createdAt: new Date(NOW.getTime() - 3 * DAY), trialEndsAt: null });
    await run();
    expect((await reread(odd.id)).trialEndsAt!.getTime()).toBe(odd.trialEndsAt!.getTime());
    expect((await reread(none.id)).trialEndsAt).toBeNull();
  });

  it("a second run changes nothing", async () => {
    const s = await signedUp(3, 7);
    await run();
    const once = await reread(s.id);
    await run();
    expect((await reread(s.id)).trialEndsAt!.getTime()).toBe(once.trialEndsAt!.getTime());
  });
});
