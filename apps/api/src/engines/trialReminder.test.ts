import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { runTrialReminders, trialStageAt } from "./trialReminder.js";

/**
 * Trial-expiry reminder sweep: the week/tomorrow/ended stage ladder, monotonic
 * idempotency (a second run sends nothing new), the late-discovery jump (an
 * already-expired stage-0 shop gets ONE email, not three), and the skip gates
 * (comped, subscribed, billing/email disabled). Emails are captured by the
 * injected test sender (which also flips emailEnabled() on).
 *
 * The sweep reads ALL shops in the test DB, so every assertion filters to THIS
 * suite's shops/owner - leftover shops from other suites may legitimately be
 * advanced by a run and must not fail us.
 */

const NOW = new Date("2026-07-02T14:00:00Z");
const MS_PER_DAY = 86_400_000;

let sent: SendEmailInput[] = [];
let userId: string;
let ownerEmail: string;

const shopIds: string[] = [];

async function makeShop(overrides: Record<string, unknown> = {}) {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Trial Shop",
      webhookSecret: randomToken(),
      ...overrides,
    },
  });
  shopIds.push(shop.id);
  return shop;
}

/** Run the sweep and keep only the summaries for shops this suite created. */
async function runFiltered(now: Date) {
  const summaries = await runTrialReminders(now, { billingOn: true });
  return summaries.filter((s) => shopIds.includes(s.shopId));
}

/** Emails captured for THIS suite's owner. */
function mine(): SendEmailInput[] {
  return sent.filter((e) => e.to === ownerEmail);
}

beforeAll(async () => {
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: `EM${sent.length}`, status: "sent" };
  });
  ownerEmail = `trial-${randomToken(6)}@test.local`;
  const user = await prisma.user.create({
    data: { email: ownerEmail, passwordHash: "x", name: "Trial Owner" },
  });
  userId = user.id;
});

afterEach(() => {
  sent = [];
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("trialStageAt", () => {
  const end = NOW;
  it("maps time-to-expiry onto the stage ladder", () => {
    expect(trialStageAt(end, new Date(end.getTime() - 30 * MS_PER_DAY))).toBe(0); // fresh trial
    expect(trialStageAt(end, new Date(end.getTime() - 8 * MS_PER_DAY))).toBe(0); // >7d left
    expect(trialStageAt(end, new Date(end.getTime() - 6 * MS_PER_DAY))).toBe(1); // ≤7d left
    expect(trialStageAt(end, new Date(end.getTime() - 12 * 60 * 60 * 1000))).toBe(2); // ≤1d left
    expect(trialStageAt(end, new Date(end.getTime() + 12 * 60 * 60 * 1000))).toBe(2); // just expired (<1d ago)
    expect(trialStageAt(end, new Date(end.getTime() + 2 * MS_PER_DAY))).toBe(3); // expired ≥1d ago
  });
});

describe("runTrialReminders", () => {
  it("walks a shop through all three stages, one email each, idempotently", async () => {
    const shop = await makeShop({ trialEndsAt: new Date(NOW.getTime() + 6 * MS_PER_DAY) });

    // 6 days left -> stage 1.
    let summaries = await runFiltered(NOW);
    expect(summaries).toEqual([{ shopId: shop.id, stage: 1, ownerEmail }]);
    expect(mine().length).toBe(1);
    expect(mine()[0]!.subject).toContain("ends in a week");
    // The email says what pauses, quotes the price, and links to billing.
    expect(mine()[0]!.text).toContain("$34.99");
    expect(mine()[0]!.text).toContain("/dashboard/billing");
    expect(mine()[0]!.text).toContain("— ChairBack");

    // Same day again: nothing new (monotonic stage already at 1).
    summaries = await runFiltered(NOW);
    expect(summaries).toEqual([]);
    expect(mine().length).toBe(1);

    // 12 hours before expiry -> stage 2.
    const dayBefore = new Date(NOW.getTime() + 5.5 * MS_PER_DAY);
    summaries = await runFiltered(dayBefore);
    expect(summaries).toEqual([{ shopId: shop.id, stage: 2, ownerEmail }]);
    expect(mine().length).toBe(2);
    expect(mine()[1]!.subject).toContain("ends tomorrow");
    // Idempotent at stage 2 too.
    expect(await runFiltered(dayBefore)).toEqual([]);

    // 2 days after expiry -> stage 3.
    const after = new Date(NOW.getTime() + 8 * MS_PER_DAY);
    summaries = await runFiltered(after);
    expect(summaries).toEqual([{ shopId: shop.id, stage: 3, ownerEmail }]);
    expect(mine().length).toBe(3);
    expect(mine()[2]!.subject).toContain("trial has ended");
    expect(mine()[2]!.text).toContain("paused");

    // Terminal: stage 3 shops leave the sweep entirely.
    expect(await runFiltered(after)).toEqual([]);
    expect(mine().length).toBe(3);

    const row = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(row?.trialReminderStage).toBe(3);
  });

  it("a shop discovered already-expired gets ONE ended email (stage jump), not three", async () => {
    const shop = await makeShop({ trialEndsAt: new Date(NOW.getTime() - 5 * MS_PER_DAY) });
    const summaries = await runFiltered(NOW);
    expect(summaries).toEqual([{ shopId: shop.id, stage: 3, ownerEmail }]);
    expect(mine().length).toBe(1);
    expect(mine()[0]!.subject).toContain("trial has ended");
  });

  it("skips shops with plenty of trial left", async () => {
    await makeShop({ trialEndsAt: new Date(NOW.getTime() + 30 * MS_PER_DAY) });
    expect(await runFiltered(NOW)).toEqual([]);
    expect(mine().length).toBe(0);
  });

  it("skips comped and subscribed shops even when their trial date has lapsed", async () => {
    await makeShop({
      trialEndsAt: new Date(NOW.getTime() - 5 * MS_PER_DAY),
      compAccess: true,
    });
    await makeShop({
      trialEndsAt: new Date(NOW.getTime() - 5 * MS_PER_DAY),
      subscriptionStatus: "active",
    });
    // A canceled subscription also isn't "none": Stripe owns that conversation.
    await makeShop({
      trialEndsAt: new Date(NOW.getTime() - 5 * MS_PER_DAY),
      subscriptionStatus: "canceled",
    });
    expect(await runFiltered(NOW)).toEqual([]);
    expect(mine().length).toBe(0);
  });

  it("skips shops with no trial set", async () => {
    await makeShop({ trialEndsAt: null });
    expect(await runFiltered(NOW)).toEqual([]);
    expect(mine().length).toBe(0);
  });

  it("is a hard no-op while billing is disabled", async () => {
    await makeShop({ trialEndsAt: new Date(NOW.getTime() - 5 * MS_PER_DAY) });
    // No billingOn override: tests run without STRIPE_* env, so the real gate trips.
    const summaries = await runTrialReminders(NOW);
    expect(summaries).toEqual([]);
    expect(mine().length).toBe(0);
  });

  it("is a hard no-op while email is disabled", async () => {
    await makeShop({ trialEndsAt: new Date(NOW.getTime() - 5 * MS_PER_DAY) });
    __setSendEmailForTests(undefined); // emailEnabled() falls back to env = off
    try {
      const summaries = await runTrialReminders(NOW, { billingOn: true });
      expect(summaries).toEqual([]);
    } finally {
      __setSendEmailForTests(async (input) => {
        sent.push(input);
        return { id: `EM${sent.length}`, status: "sent" };
      });
    }
    expect(mine().length).toBe(0);
  });
});
