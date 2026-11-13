import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  __setPersonalEmailForTests,
  personalEmailDispatchMode,
  sendPersonalEmail,
  type PersonalEmailFn,
  type PersonalEmailInput,
} from "../messaging/personalEmail.js";
import { buildTrialCheckInEmail, greetingName } from "../messaging/trialCheckInEmail.js";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";
import { CHECK_IN_MAX_DAYS, runTrialCheckIns } from "./trialCheckIn.js";

/**
 * The founder's personal trial check-in: who gets it (a day after a trial ends,
 * no plan, never comped, not already sent), once per shop under a race, and
 * dark - spending no shop's once-only mark - while billing, the mailbox or
 * DRY_RUN says a send would not really leave.
 *
 * The sweep reads every shop in the test DB, so assertions filter to this
 * suite's shops (by meta.shopId); another suite's shop that the sweep happens
 * to touch must not fail us.
 */

const NOW = new Date("2026-07-02T15:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let sent: PersonalEmailInput[] = [];
let userId: string;
let ownerEmail: string;
const shopIds: string[] = [];

const capture: PersonalEmailFn = async (input) => {
  sent.push(input);
  return { status: "sent" };
};

async function makeShop(overrides: Record<string, unknown> = {}) {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Check-in Shop",
      webhookSecret: randomToken(),
      createdAt: new Date(NOW.getTime() - 60 * DAY),
      ...overrides,
    },
  });
  shopIds.push(shop.id);
  return shop;
}

/** A shop whose trial ended `hoursAgo` before NOW, otherwise eligible. */
const endedAgo = (hoursAgo: number, overrides: Record<string, unknown> = {}) =>
  makeShop({ trialEndsAt: new Date(NOW.getTime() - hoursAgo * HOUR), ...overrides });

async function run(now = NOW, billingOn = true) {
  const out = await runTrialCheckIns(now, { billingOn });
  return out.filter((s) => shopIds.includes(s.shopId)).map((s) => s.shopId);
}

/** Notes captured for one shop. */
const notesFor = (shopId: string) => sent.filter((e) => e.meta.shopId === shopId);

async function stampOf(shopId: string): Promise<Date | null> {
  const s = await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { trialCheckInSentAt: true } });
  return s.trialCheckInSentAt;
}

const ENV_KEYS = ["GMAIL_SMTP_USER", "GMAIL_SMTP_APP_PASSWORD", "DRY_RUN"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  __setPersonalEmailForTests(capture);
  ownerEmail = `checkin-${randomToken(6)}@test.local`;
  const user = await prisma.user.create({
    data: { email: ownerEmail, passwordHash: "x", name: "Avery Lee" },
  });
  userId = user.id;
});

afterEach(async () => {
  // Each test's shops go with it: one left eligible (billing off, DRY_RUN)
  // would be picked up by the next test's sweep.
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  shopIds.length = 0;
  sent = [];
  __setPersonalEmailForTests(capture);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetEnvCacheForTests();
});

afterAll(async () => {
  __setPersonalEmailForTests(undefined);
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("trial check-in: who gets it", () => {
  it("sends one note a day after the trial ends: to the owner, from Eric, greeting them by first name", async () => {
    const shop = await endedAgo(25);

    expect(await run()).toEqual([shop.id]);
    expect(notesFor(shop.id)).toHaveLength(1);
    const note = notesFor(shop.id)[0]!;
    expect(note.to).toBe(ownerEmail);
    expect(note.fromName).toBe("Eric");
    expect(note.subject).toBe("Your experience on ChairBack");
    expect(note.text.startsWith("Hey Avery,\n\nThis is Eric, the developer of ChairBack.")).toBe(true);
    expect(note.text).toMatch(/whether you're going to continue with us/);
    expect(await stampOf(shop.id)).toEqual(NOW);
  });

  it("once per shop: the next day's sweep, with the trial still inside the window, sends nothing", async () => {
    const shop = await endedAgo(30);
    expect(await run()).toEqual([shop.id]);
    expect(await run(new Date(NOW.getTime() + DAY))).toEqual([]);
    expect(notesFor(shop.id)).toHaveLength(1);
  });

  it("not before a full day has passed, and never while the trial is still running", async () => {
    const tooSoon = await endedAgo(23);
    const running = await makeShop({ trialEndsAt: new Date(NOW.getTime() + 2 * DAY) });
    expect(await run()).toEqual([]);
    expect(await stampOf(tooSoon.id)).toBeNull();
    expect(await stampOf(running.id)).toBeNull();
  });

  it(`never a cold note: a trial that ended ${CHECK_IN_MAX_DAYS}+ days ago gets nothing, one just inside does`, async () => {
    const stale = await endedAgo(CHECK_IN_MAX_DAYS * 24 + 1);
    const inside = await endedAgo(CHECK_IN_MAX_DAYS * 24 - 2);
    expect(await run()).toEqual([inside.id]);
    expect(await stampOf(stale.id)).toBeNull();
  });

  it("a shop that picked a plan, is comped, or was comped and then uncomped gets nothing", async () => {
    const paid = await endedAgo(30, { subscriptionStatus: "active" });
    const lapsedPaid = await endedAgo(30, { subscriptionStatus: "canceled" });
    const comped = await endedAgo(30, { compAccess: true });
    const uncomped = await endedAgo(30, { compEndedAt: new Date(NOW.getTime() - 2 * DAY) });
    expect(await run()).toEqual([]);
    for (const s of [paid, lapsedPaid, comped, uncomped]) expect(await stampOf(s.id)).toBeNull();
  });
});

describe("trial check-in: dark, and spending no shop's mark", () => {
  it("billing off: nothing sent, the shop is still owed its note", async () => {
    const shop = await endedAgo(30);
    expect(await run(NOW, false)).toEqual([]);
    expect(await stampOf(shop.id)).toBeNull();
  });

  it("mailbox not configured: nothing sent, the shop is still owed its note", async () => {
    __setPersonalEmailForTests(undefined);
    delete process.env.GMAIL_SMTP_USER;
    delete process.env.GMAIL_SMTP_APP_PASSWORD;
    __resetEnvCacheForTests();
    expect(personalEmailDispatchMode()).toBe("unconfigured");

    const shop = await endedAgo(30);
    expect(await run()).toEqual([]);
    expect(await stampOf(shop.id)).toBeNull();
  });

  it("DRY_RUN on: the sweep does not run at all, so no shop's once-only mark is spent on a swallowed note", async () => {
    __setPersonalEmailForTests(undefined);
    process.env.GMAIL_SMTP_USER = "founder@test.local";
    process.env.GMAIL_SMTP_APP_PASSWORD = "abcd efgh ijkl mnop";
    process.env.DRY_RUN = "true";
    __resetEnvCacheForTests();
    expect(personalEmailDispatchMode()).toBe("dry_run");

    const shop = await endedAgo(30);
    expect(await run()).toEqual([]);
    expect(await stampOf(shop.id)).toBeNull();
    // And a direct send is swallowed before any connection is attempted.
    await expect(
      sendPersonalEmail({ to: "x@test.local", subject: "s", text: "t", fromName: "Eric", meta: {} }),
    ).resolves.toEqual({ status: "dry_run" });
  });
});

describe("trial check-in: failures and races", () => {
  it("a send that throws keeps that shop's mark (never retried) and does not stop the next shop", async () => {
    const bad = await endedAgo(30);
    const good = await endedAgo(31);
    __setPersonalEmailForTests(async (input) => {
      if (input.meta.shopId === bad.id) throw new Error("smtp refused");
      return capture(input);
    });

    expect(await run()).toEqual([good.id]);
    expect(notesFor(good.id)).toHaveLength(1);
    expect(await stampOf(bad.id)).toEqual(NOW);
    expect(await run()).toEqual([]);
  });

  it("two sweeps at once (two replicas) send ONE note: the compare-and-set on the shop row decides", async () => {
    const shop = await endedAgo(30);
    const { results, settledEarly } = await raceBehindRowLock("Shop", shop.id, [() => run(), () => run()]);
    expect(settledEarly).toBe(0); // both really queued on the shop row
    expect(winners(results).flat()).toEqual([shop.id]);
    expect(notesFor(shop.id)).toHaveLength(1);
  });
});

describe("trial check-in copy", () => {
  it("greets by the first word of the owner's name, or 'there' when there is no usable name", () => {
    expect(greetingName("Avery Lee")).toBe("Avery");
    expect(greetingName("  Blake  ")).toBe("Blake");
    expect(greetingName("")).toBeNull();
    expect(greetingName(null)).toBeNull();
    expect(greetingName("owner@example.com")).toBeNull();
    expect(buildTrialCheckInEmail({ ownerName: null }).text.startsWith("Hey there,\n")).toBe(true);
  });

  it("is plain text signed by a person, with no link, price or plan in it", () => {
    const { text } = buildTrialCheckInEmail({ ownerName: "Avery" });
    expect(text.endsWith("Best,\nEric")).toBe(true);
    expect(text).not.toMatch(/https?:|\$|<[a-z]/i);
  });
});
