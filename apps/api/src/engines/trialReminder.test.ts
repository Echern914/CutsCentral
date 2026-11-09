import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BILLING, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import {
  FOLLOW_UP_MAX_DAYS,
  followUpStageAt,
  lockedSince,
  notifyCompEnded,
  runTrialReminders,
  trialStageAt,
} from "./trialReminder.js";

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
      // Old enough for every email unless a test says otherwise: the default
      // would be the real clock, which is years after NOW.
      createdAt: new Date(NOW.getTime() - 60 * MS_PER_DAY),
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

afterEach(async () => {
  sent = [];
  // Each test starts with no shops of ours: a shop left locked by one test
  // would otherwise be due a follow-up in the next test's sweep.
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  shopIds.length = 0;
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
    // The ended email goes out on the first sweep AT or after expiry - the
    // day the booking page stops, not the day after.
    expect(trialStageAt(end, end)).toBe(3);
    expect(trialStageAt(end, new Date(end.getTime() + 60 * 60 * 1000))).toBe(3); // just expired
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
    expect(mine()[0]!.subject).toContain("ends in 6 days");
    expect(mine()[0]!.html).toContain("6 days left on your free trial");
    // The email says what pauses, quotes the price, and links to billing.
    expect(mine()[0]!.text).toContain("$34.99");
    expect(mine()[0]!.text).toContain("/dashboard/billing");
    expect(mine()[0]!.text).toContain("— ChairBack");

    // Same day again: nothing new (monotonic stage already at 1).
    summaries = await runFiltered(NOW);
    expect(summaries).toEqual([]);
    expect(mine().length).toBe(1);

    // ~19 hours before expiry -> stage 2.
    //
    // 🔴 NOT 12 HOURS, AND THE HALF-DAY WAS THE BUG. The stage-2 copy says
    // "today" when the trial ends on the same CALENDAR day as now, and
    // friendlyDate formats in the AMBIENT timezone. NOW+5.5d is 02:00 UTC on
    // the same date the trial ends, so under UTC - which is what Railway runs -
    // this scenario is genuinely "ends today", and the assertion below was
    // describing behaviour production does not have. It only passed because
    // the author's machine is America/New_York, where 02:00 UTC is the
    // previous evening.
    //
    // 19.2 hours lands on the previous calendar day in UTC and in ET, so the
    // scenario really is "ends tomorrow" in both, and it is still inside the
    // 24-hour stage-2 window. Found when CI first ran the suite in UTC.
    const dayBefore = new Date(NOW.getTime() + 5.2 * MS_PER_DAY);
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

    // Nothing more until the first follow-up is due, 3 days after it locked.
    expect(await runFiltered(after)).toEqual([]);
    expect(mine().length).toBe(3);

    const row = await prisma.shop.findUnique({ where: { id: shop.id } });
    expect(row?.trialReminderStage).toBe(3);

    // The ended email is a REAL email: branded HTML with one button that says
    // the thing, the plan list with prices, on the owner-lifecycle stream, and
    // keyed so a retried send can never land twice.
    const ended = mine()[2]!;
    expect(ended.subject).toBe("Your ChairBack trial has ended - upgrade to keep everything");
    expect(ended.html).toContain("Upgrade to keep everything");
    expect(ended.html).toContain("Your free trial has ended");
    expect(ended.html).toContain("/dashboard/billing");
    expect(ended.html).toContain("$34.99/mo");
    expect(ended.html).toContain("Nothing is lost.");
    expect(ended.text).toContain("Nothing is lost.");
    expect(ended.stream).toBe("lifecycle");
    expect(ended.idempotencyKey).toBe(`trial-reminder:${shop.id}:3`);
    // Every stage carries HTML now, not just the last.
    expect(mine()[0]!.html).toContain("Choose a plan");
    expect(mine()[1]!.html).toContain("Keep everything running");
  });

  it("the ended email goes out on the first sweep AT expiry, not a day later", async () => {
    // Trial ended an hour before this sweep: stage 3 straight away.
    const shop = await makeShop({ trialEndsAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    const summaries = await runFiltered(NOW);
    expect(summaries).toEqual([{ shopId: shop.id, stage: 3, ownerEmail }]);
    expect(mine()[0]!.subject).toContain("trial has ended");
  });

  it("names only the plans that are actually for sale", async () => {
    // Under the test seam only Premium is configured (no STRIPE_STARTER_PRICE_ID,
    // no STRIPE_PREMIUM_AI_PRICE_ID), so the email must not offer Starter or
    // Premium AI - the billing page would refuse to sell them.
    const shop = await makeShop({ trialEndsAt: new Date(NOW.getTime() + 2 * MS_PER_DAY) });
    await runFiltered(NOW);
    const email = mine().find((e) => e.to === ownerEmail)!;
    expect(email.text).toContain("Premium, $34.99/mo");
    expect(email.text).not.toContain("Starter");
    expect(email.text).not.toContain("Premium AI");
    expect(shop.id).toBeTruthy();
  });

  it("a shop discovered already-expired gets ONE ended email (stage jump), not three", async () => {
    const shop = await makeShop({ trialEndsAt: new Date(NOW.getTime() - 5 * MS_PER_DAY) });
    const summaries = await runFiltered(NOW);
    expect(summaries).toEqual([{ shopId: shop.id, stage: 3, ownerEmail }]);
    expect(mine().length).toBe(1);
    expect(mine()[0]!.subject).toContain("trial has ended");
  });

  describe("a shop on the standard trial, from the day it signs up", () => {
    const signedUp = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const newShop = () =>
      makeShop({
        createdAt: signedUp,
        trialEndsAt: new Date(signedUp.getTime() + BILLING.trialDays * MS_PER_DAY),
      });
    const day = (n: number) => new Date(NOW.getTime() + n * MS_PER_DAY);

    it("hears nothing on signup day, or until the first reminder is due", async () => {
      await newShop();
      for (const n of [0, 1, 2, 3]) expect(await runFiltered(day(n))).toEqual([]);
      expect(mine().length).toBe(0);
    });

    it("gets each email once, with the right number of days", async () => {
      const shop = await newShop();
      // The 14:00 sweep 4 days on is 4 days and 2 hours after signup, with 2
      // days and 22 hours left.
      expect(await runFiltered(day(4))).toEqual([{ shopId: shop.id, stage: 1, ownerEmail }]);
      expect(mine()[0]!.subject).toContain("ends in 3 days");
      expect(await runFiltered(day(5))).toEqual([]);
      expect(await runFiltered(day(6))).toEqual([{ shopId: shop.id, stage: 2, ownerEmail }]);
      expect(await runFiltered(day(7))).toEqual([{ shopId: shop.id, stage: 3, ownerEmail }]);
      expect(mine().map((e) => e.subject).at(-1)).toContain("trial has ended");
    });
  });

  it("the wait is only for the first reminder: a new shop still hears its trial is ending or over", async () => {
    const createdAt = new Date(NOW.getTime() - MS_PER_DAY);
    const ending = await makeShop({
      createdAt,
      trialEndsAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    });
    const over = await makeShop({ createdAt, trialEndsAt: new Date(NOW.getTime() - 60 * 1000) });
    const summaries = await runFiltered(NOW);
    expect(summaries.find((s) => s.shopId === ending.id)?.stage).toBe(2);
    expect(summaries.find((s) => s.shopId === over.id)?.stage).toBe(3);
  });

  it("a shop already on a 14-day trial still gets its first reminder with 7 days left", async () => {
    const shop = await makeShop({
      createdAt: new Date(NOW.getTime() - 7 * MS_PER_DAY),
      trialEndsAt: new Date(NOW.getTime() + 7 * MS_PER_DAY),
    });
    expect(await runFiltered(NOW)).toEqual([{ shopId: shop.id, stage: 1, ownerEmail }]);
    expect(mine()[0]!.subject).toContain("ends in 7 days");
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

/**
 * Follow-ups to a shop that is STILL locked: 3 days and 10 days after it
 * locked, one email each, only after the email that said why it paused, and
 * never to a shop that has access again.
 */
describe("locked-shop follow-ups", () => {
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY);
  const daysOn = (n: number) => new Date(NOW.getTime() + n * MS_PER_DAY);
  const aboutShop = (id: string) =>
    mine().filter((e) => (e.meta as { shopId?: string } | undefined)?.shopId === id);

  it("followUpStageAt: 4 from day 3, 5 from day 10, nothing past the cap", () => {
    expect(followUpStageAt(NOW, NOW)).toBe(0);
    expect(followUpStageAt(daysAgo(2.9), NOW)).toBe(0);
    expect(followUpStageAt(daysAgo(3), NOW)).toBe(4);
    expect(followUpStageAt(daysAgo(9.9), NOW)).toBe(4);
    expect(followUpStageAt(daysAgo(10), NOW)).toBe(5);
    expect(followUpStageAt(daysAgo(FOLLOW_UP_MAX_DAYS), NOW)).toBe(5);
    expect(followUpStageAt(daysAgo(FOLLOW_UP_MAX_DAYS + 1), NOW)).toBe(0);
  });

  it("lockedSince is the LATER of the trial end and the uncomp", () => {
    expect(lockedSince({ trialEndsAt: daysAgo(60), compEndedAt: daysAgo(4) })).toEqual(daysAgo(4));
    expect(lockedSince({ trialEndsAt: daysAgo(4), compEndedAt: daysAgo(60) })).toEqual(daysAgo(4));
    expect(lockedSince({ trialEndsAt: null, compEndedAt: daysAgo(4) })).toEqual(daysAgo(4));
    expect(lockedSince({ trialEndsAt: null, compEndedAt: null })).toBeNull();
  });

  it("a locked shop gets day 3 then day 10, once each, then nothing ever again", async () => {
    // Trial ended today and the ended email went out (stage 3).
    const shop = await makeShop({ trialEndsAt: NOW, trialReminderStage: 3 });

    expect(await runFiltered(daysOn(2))).toEqual([]);

    expect(await runFiltered(daysOn(3))).toEqual([{ shopId: shop.id, stage: 4, ownerEmail }]);
    expect(await runFiltered(daysOn(3))).toEqual([]);
    const day3 = aboutShop(shop.id)[0]!;
    expect(day3.subject).toBe("Your Trial Shop booking page is still paused");
    expect(day3.html).toContain("Turn my booking page back on");
    expect(day3.text).toContain("$34.99/mo");
    expect(day3.text).toContain("/dashboard/billing");
    expect(day3.stream).toBe("lifecycle");
    expect(day3.idempotencyKey).toBe(`trial-reminder:${shop.id}:4`);

    expect(await runFiltered(daysOn(9))).toEqual([]);
    expect(await runFiltered(daysOn(10))).toEqual([{ shopId: shop.id, stage: 5, ownerEmail }]);
    const day10 = aboutShop(shop.id)[1]!;
    expect(day10.subject).toBe("Trial Shop is still paused on ChairBack");
    expect(day10.idempotencyKey).toBe(`trial-reminder:${shop.id}:5`);

    expect(await runFiltered(daysOn(30))).toEqual([]);
    expect(aboutShop(shop.id)).toHaveLength(2);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).trialReminderStage).toBe(5);
  });

  it("the follow-ups never say 'trial': they also go to shops that were comped", async () => {
    // Not the suite's default "Trial Shop" name, or the shop's own name matches.
    const shop = await makeShop({ name: "Fade Room", trialEndsAt: daysAgo(12), trialReminderStage: 3 });
    await runFiltered(NOW);
    const [email] = aboutShop(shop.id);
    // The shared template's leading HTML comment is never shown to anyone, and
    // the suite's owner is literally named "Trial Owner".
    const shown = (email!.subject + email!.text + (email!.html ?? "").replace(/<!--[\s\S]*?-->/g, "")).replaceAll(
      "Trial Owner",
      "",
    );
    expect(shown).not.toMatch(/trial/i);
  });

  it("a shop found already 20 days locked gets ONE follow-up (the day-10 one), not two", async () => {
    const shop = await makeShop({ trialEndsAt: daysAgo(20), trialReminderStage: 3 });
    expect(await runFiltered(NOW)).toEqual([{ shopId: shop.id, stage: 5, ownerEmail }]);
    expect(aboutShop(shop.id)).toHaveLength(1);
  });

  it("a shop never told its trial ended gets THAT email first, not a follow-up", async () => {
    const shop = await makeShop({ trialEndsAt: daysAgo(20), trialReminderStage: 1 });
    expect(await runFiltered(NOW)).toEqual([{ shopId: shop.id, stage: 3, ownerEmail }]);
    expect(aboutShop(shop.id)[0]!.subject).toContain("trial has ended");
    // The day-10 follow-up comes on the next sweep: it has been locked 20 days.
    expect(await runFiltered(daysOn(1))).toEqual([{ shopId: shop.id, stage: 5, ownerEmail }]);
  });

  it("an uncomped shop counts from the UNCOMP, not from a trial that ended long before", async () => {
    // Trial ended 60 days ago, comp switched off 4 days ago: day-3 follow-up, not day-10.
    const shop = await makeShop({ trialEndsAt: daysAgo(60), compEndedAt: daysAgo(4), trialReminderStage: 3 });
    expect(await runFiltered(NOW)).toEqual([{ shopId: shop.id, stage: 4, ownerEmail }]);
  });

  it("an uncomped shop with no trial date still gets the follow-ups", async () => {
    // Nothing else will ever email it: it has no trial ladder.
    const shop = await makeShop({ trialEndsAt: null, compEndedAt: daysAgo(4) });
    expect(await runFiltered(NOW)).toEqual([{ shopId: shop.id, stage: 4, ownerEmail }]);
  });

  it.each([
    ["picked a plan", { subscriptionStatus: "active" }],
    ["was comped again", { compAccess: true }],
    ["had its trial extended", { trialEndsAt: daysOn(5) }],
    ["locked longer ago than the cap", { trialEndsAt: daysAgo(FOLLOW_UP_MAX_DAYS + 5) }],
  ])("a shop that %s gets no follow-up", async (_why, data) => {
    await makeShop({ trialEndsAt: daysAgo(5), trialReminderStage: 3, ...data });
    expect(await runFiltered(NOW)).toEqual([]);
    expect(mine()).toHaveLength(0);
  });
});

/**
 * 🔴 COMP SWITCHED OFF: the owner hears it the moment it leaves them with no
 * plan - and hears it ONCE, in the right words (never "your trial ended" for a
 * shop that was comped).
 */
describe("notifyCompEnded", () => {
  it("no subscription and no trial left: emails the owner to choose a plan, and closes the trial ladder", async () => {
    // compEndedAt as the admin route stamps it, just before it calls notifyCompEnded.
    const shop = await makeShop({
      compAccess: false,
      compEndedAt: NOW,
      trialEndsAt: new Date(NOW.getTime() - 30 * MS_PER_DAY),
    });
    expect(await notifyCompEnded(shop.id, NOW, { billingOn: true })).toBe("sent");
    const emails = mine();
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toMatch(/free .* access has ended - choose a plan/i);
    expect(emails[0]!.text).toContain("Your complimentary");
    expect(emails[0]!.text).not.toMatch(/free trial|trial (has )?ended/i);
    expect(emails[0]!.idempotencyKey).toBe(`comp-ended:${shop.id}:${NOW.toISOString().slice(0, 10)}`);
    // The next daily sweep must not follow up with a "trial ended" email.
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).trialReminderStage).toBe(3);
    await runFiltered(NOW);
    // (Other shops in this file share the owner - count only emails about THIS shop.)
    expect(mine().filter((e) => (e.meta as { shopId?: string } | undefined)?.shopId === shop.id)).toHaveLength(1);
  });

  it("never had a trial date (comped from the start): still told", async () => {
    const shop = await makeShop({ compAccess: false, trialEndsAt: null });
    expect(await notifyCompEnded(shop.id, NOW, { billingOn: true })).toBe("sent");
    expect(mine()).toHaveLength(1);
  });

  it.each([
    ["trial days left", { trialEndsAt: new Date(NOW.getTime() + 10 * MS_PER_DAY) }],
    ["a live subscription", { subscriptionStatus: "active", trialEndsAt: null }],
  ])("still has access (%s): nothing to say yet", async (_why, data) => {
    const shop = await makeShop({ compAccess: false, ...data });
    expect(await notifyCompEnded(shop.id, NOW, { billingOn: true })).toBe("still_has_access");
    expect(mine()).toHaveLength(0);
  });

  it("billing off: switching comp off locks nothing, so no email", async () => {
    const shop = await makeShop({ compAccess: false, trialEndsAt: null });
    expect(await notifyCompEnded(shop.id, NOW, { billingOn: false })).toBe("billing_off");
    expect(mine()).toHaveLength(0);
  });
});
