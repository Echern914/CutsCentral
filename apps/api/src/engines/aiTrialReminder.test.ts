import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { runAiTrialReminders } from "./aiTrialReminder.js";
import {
  AI_TRIAL_DAYS,
  aiTrialActive,
  aiTrialAvailability,
  aiTrialDaysLeft,
  hasReceptionistEntitlement,
} from "../receptionist/config.js";

/**
 * The 14-day Premium AI trial.
 *
 * Two things are worth pinning hard. First: the entitlement must come from the
 * dated window and NOT from writing "pro_ai" into `plan` - the shop is still
 * paying for Premium and Stripe still says so. Second: the trial ENDING must
 * be warned about, because the shop is a paying customer who would otherwise
 * read a silent switch-off as the product breaking.
 *
 * 🔴 Time is frozen. The stage ladder is pure clock arithmetic, and the last
 * flake in this repo (barberReminders, #252) was exactly this shape.
 */

const FROZEN_NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;
/** Billing is OFF in the suite's env; every gate here needs it ON to bite. */
const ON = { enabled: true } as const;
let sent: SendEmailInput[] = [];

const base = {
  plan: "pro",
  subscriptionStatus: "active",
  stripeSubscriptionId: "sub_x",
  receptionistSubscriptionStatus: "none",
  receptionistCompAccess: false,
  aiTrialStartedAt: null as Date | null,
  aiTrialEndsAt: null as Date | null,
};

describe("who may start an AI trial", () => {
  it("a paying Premium shop may", () => {
    expect(aiTrialAvailability(base, ON)).toBeNull();
  });

  it("🔑 a shop on its FREE signup trial may not", () => {
    // It has access but no subscription. Stacking a free AI trial on a free
    // base trial hands the entire product to someone who has paid nothing.
    expect(
      aiTrialAvailability({
        ...base,
        stripeSubscriptionId: null,
        subscriptionStatus: "none",
      }, ON),
    ).toBe("no_subscription");
  });

  it("a lapsed shop may not", () => {
    expect(aiTrialAvailability({ ...base, subscriptionStatus: "canceled" }, ON)).toBe(
      "no_subscription",
    );
  });

  it("a pro_ai shop has nothing to try", () => {
    expect(aiTrialAvailability({ ...base, plan: "pro_ai" }, ON)).toBe("already_entitled");
  });

  it("nor does one already paying the add-on, or comped", () => {
    expect(
      aiTrialAvailability({ ...base, receptionistSubscriptionStatus: "active" }, ON),
    ).toBe("already_entitled");
    expect(aiTrialAvailability({ ...base, receptionistCompAccess: true }, ON)).toBe(
      "already_entitled",
    );
  });

  it("🔑 once only - and letting it LAPSE does not buy another", () => {
    // aiTrialStartedAt is never cleared, which is the whole reason it exists
    // as a second column rather than being inferred from aiTrialEndsAt.
    expect(
      aiTrialAvailability({
        ...base,
        aiTrialStartedAt: new Date(FROZEN_NOW.getTime() - 90 * DAY),
        aiTrialEndsAt: new Date(FROZEN_NOW.getTime() - 76 * DAY),
      }, ON),
    ).toBe("ai_trial_used");
  });
});

describe("the entitlement comes from the window, not the plan", () => {
  const shop = (endsAt: Date | null) => ({
    plan: "pro",
    receptionistCompAccess: false,
    receptionistSubscriptionStatus: "none",
    aiTrialEndsAt: endsAt,
  });

  it("a live trial entitles the receptionist while plan stays 'pro'", () => {
    const s = shop(new Date(FROZEN_NOW.getTime() + 5 * DAY));
    expect(hasReceptionistEntitlement(s, { now: FROZEN_NOW, enabled: true })).toBe(true);
    // The point of the whole design: Stripe and the DB still agree.
    expect(s.plan).toBe("pro");
  });

  it("an expired one does not", () => {
    expect(
      hasReceptionistEntitlement(shop(new Date(FROZEN_NOW.getTime() - DAY)), {
        now: FROZEN_NOW,
        enabled: true,
      }),
    ).toBe(false);
  });

  it("expiry is a boundary, not a grace period", () => {
    expect(aiTrialActive(shop(FROZEN_NOW), { now: FROZEN_NOW })).toBe(false);
    expect(
      aiTrialActive(shop(new Date(FROZEN_NOW.getTime() + 1)), { now: FROZEN_NOW }),
    ).toBe(true);
  });

  it("counts whole days left, floored at zero", () => {
    expect(
      aiTrialDaysLeft(shop(new Date(FROZEN_NOW.getTime() + 14 * DAY)), FROZEN_NOW),
    ).toBe(AI_TRIAL_DAYS);
    expect(
      aiTrialDaysLeft(shop(new Date(FROZEN_NOW.getTime() - 5 * DAY)), FROZEN_NOW),
    ).toBe(0);
    expect(aiTrialDaysLeft(shop(null), FROZEN_NOW)).toBeNull();
  });
});

/* -------------------- the reminder ladder (DB) -------------------- */

let userId: string;
type ShopKey =
  | "week"
  | "tomorrow"
  | "ended"
  | "early"
  | "converted"
  | "dark"
  | "offWeek"
  | "offTomorrow"
  | "offEnded"
  | "onWeek"
  | "onTomorrow"
  | "onEnded";
const ids = {} as Record<ShopKey, string>;

async function makeShop(
  key: ShopKey,
  endsInDays: number,
  over: Record<string, unknown> = {},
) {
  const s = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: `AiTrial ${key}`,
      slug: `ait-${randomToken(6)}`,
      webhookSecret: randomToken(),
      plan: "pro",
      subscriptionStatus: "active",
      stripeSubscriptionId: `sub_${randomToken(6)}`,
      aiTrialStartedAt: new Date(
        FROZEN_NOW.getTime() - (AI_TRIAL_DAYS - endsInDays) * DAY,
      ),
      aiTrialEndsAt: new Date(FROZEN_NOW.getTime() + endsInDays * DAY),
      ...over,
    },
    select: { id: true },
  });
  ids[key] = s.id;
  return s.id;
}

async function stageOf(key: ShopKey) {
  const s = await prisma.shop.findUniqueOrThrow({
    where: { id: ids[key] },
    select: { aiTrialReminderStage: true },
  });
  return s.aiTrialReminderStage;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  // Also flips emailEnabled() on - without it the sweep no-ops.
  __setSendEmailForTests(async (input) => {
    sent.push(input);
    return { id: "TEST", status: "sent" as const };
  });
  const u = await prisma.user.create({
    data: { email: `ait-${randomToken(6)}@test.local`, name: "Ada" },
    select: { id: true },
  });
  userId = u.id;
});

afterAll(async () => {
  vi.useRealTimers();
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("the ending gets warned about", () => {
  it("fires 1 a week out, 2 a day out, 3 once ended - and never repeats", async () => {
    await makeShop("week", 6);
    await makeShop("tomorrow", 1);
    await makeShop("ended", -2);
    await makeShop("early", 12); // nothing to say yet

    const first = await runAiTrialReminders(FROZEN_NOW, { billingOn: true });
    const byShop = new Map(first.map((s) => [s.shopId, s.stage]));
    expect(byShop.get(ids.week)).toBe(1);
    expect(byShop.get(ids.tomorrow)).toBe(2);
    expect(byShop.get(ids.ended)).toBe(3);
    expect(byShop.has(ids.early)).toBe(false);
    expect(await stageOf("early")).toBe(0);

    // Monotonic: a second sweep at the same instant says nothing new.
    const second = await runAiTrialReminders(FROZEN_NOW, { billingOn: true });
    for (const key of ["week", "tomorrow", "ended"] as const) {
      expect(second.some((s) => s.shopId === ids[key])).toBe(false);
    }
  });

  it("🔑 never tells a shop that BOUGHT it that its AI stopped", async () => {
    // Upgraded mid-trial: plan is pro_ai and aiTrialEndsAt is still set. A
    // stage-3 "your AI has stopped answering" email would be flatly untrue,
    // sent to someone who just started paying the higher price.
    await makeShop("converted", -1, { plan: "pro_ai" });
    const out = await runAiTrialReminders(FROZEN_NOW, { billingOn: true });
    expect(out.some((s) => s.shopId === ids.converted)).toBe(false);
    expect(await stageOf("converted")).toBe(3); // closed out, silently
  });

  it("is a hard no-op while billing is off", async () => {
    await makeShop("dark", 1);
    expect(await runAiTrialReminders(FROZEN_NOW, { billingOn: false })).toEqual([]);
    expect(await stageOf("dark")).toBe(0);
  });
});

/**
 * 🔴 A shop can still be mid-trial on the day sales close. Every email it gets
 * after that must leave out the offer, because the billing page would refuse it.
 */
describe("what the emails offer", () => {
  const OFFER = /Premium AI is|keep it \(|Turn it back on|\/dashboard\/billing/;

  async function sweep(keys: { week: ShopKey; tomorrow: ShopKey; ended: ShopKey }) {
    await makeShop(keys.week, 6);
    await makeShop(keys.tomorrow, 1);
    await makeShop(keys.ended, -2);
    sent = [];
    const out = await runAiTrialReminders(FROZEN_NOW, { billingOn: true });
    // The sweep sees every shop in the database; only these three are ours.
    const mine = new Set([ids[keys.week], ids[keys.tomorrow], ids[keys.ended]]);
    expect(out.filter((s) => mine.has(s.shopId)).map((s) => s.stage).sort()).toEqual([1, 2, 3]);
    return sent.filter((e) => /AiTrial (off|on)/.test(`${e.subject} ${e.text}`));
  }

  it("off sale, which is the default: all three warn and none of them sell", async () => {
    delete process.env.AI_RECEPTIONIST_SALES_ENABLED;
    __resetEnvCacheForTests();
    const emails = await sweep({ week: "offWeek", tomorrow: "offTomorrow", ended: "offEnded" });
    expect(emails.length).toBe(3);
    for (const email of emails) {
      expect(email.text).not.toMatch(OFFER);
      expect(email.text).toContain("Premium");
    }
  });

  it("on sale: all three still make the offer", async () => {
    process.env.AI_RECEPTIONIST_SALES_ENABLED = "true";
    __resetEnvCacheForTests();
    try {
      const emails = await sweep({ week: "onWeek", tomorrow: "onTomorrow", ended: "onEnded" });
      expect(emails.length).toBe(3);
      for (const email of emails) expect(email.text).toMatch(OFFER);
    } finally {
      delete process.env.AI_RECEPTIONIST_SALES_ENABLED;
      __resetEnvCacheForTests();
    }
  });
});
