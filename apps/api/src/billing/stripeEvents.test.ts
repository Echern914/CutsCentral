import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import {
  claimStripeEvent,
  expectedLivemode,
  finishStripeEvent,
  livemodeMismatch,
} from "./stripeEvents.js";

/**
 * The webhook receipt, on its own: one row per Stripe event id, claimed
 * before the handlers and settled after them.
 *
 * The property that matters is the unique index - a second claim of the same
 * id is a count of 0, not a second row - and the state machine around it:
 * processed is final (duplicate), failed re-arms (retry), and a claim another
 * replica still holds is neither (inflight).
 */

const created: string[] = [];
function evt(overrides: Partial<{ id: string; type: string; livemode: boolean; account: string | null }> = {}) {
  const id = overrides.id ?? `evt_${randomToken(8)}`;
  created.push(id);
  return { id, type: overrides.type ?? "invoice.paid", livemode: overrides.livemode ?? false, account: overrides.account ?? null };
}

const originalKey = process.env.STRIPE_SECRET_KEY;

afterAll(async () => {
  await prisma.stripeEventReceipt.deleteMany({ where: { eventId: { in: created } } });
  process.env.STRIPE_SECRET_KEY = originalKey;
  __resetEnvCacheForTests();
  await prisma.$disconnect();
});

describe("claimStripeEvent", () => {
  it("claims an unseen id once; the same id again is a duplicate after it was processed", async () => {
    const e = evt();
    expect(await claimStripeEvent(e)).toBe("new");
    // Mid-flight, the same id from another replica is neither new nor done.
    expect(await claimStripeEvent(e)).toBe("inflight");
    await finishStripeEvent(e.id, { ok: true });
    expect(await claimStripeEvent(e)).toBe("duplicate");
    expect(await claimStripeEvent(e)).toBe("duplicate");
    const row = await prisma.stripeEventReceipt.findUnique({ where: { eventId: e.id } });
    expect(row?.status).toBe("processed");
    expect(row?.processedAt).not.toBeNull();
    expect(row?.attempts).toBe(1);
  });

  it("a failed delivery re-arms exactly once for the redelivery, and counts the attempt", async () => {
    const e = evt();
    expect(await claimStripeEvent(e)).toBe("new");
    await finishStripeEvent(e.id, { ok: false, error: "handler_threw" });
    const failed = await prisma.stripeEventReceipt.findUnique({ where: { eventId: e.id } });
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("handler_threw");
    expect(await claimStripeEvent(e)).toBe("retry");
    // The re-arm is a compare-and-set on `failed`: a second racer sees `received`.
    expect(await claimStripeEvent(e)).toBe("inflight");
    const rearmed = await prisma.stripeEventReceipt.findUnique({ where: { eventId: e.id } });
    expect(rearmed?.status).toBe("received");
    expect(rearmed?.attempts).toBe(2);
    await finishStripeEvent(e.id, { ok: true });
    expect(await claimStripeEvent(e)).toBe("duplicate");
  });

  it("a claim abandoned by a dead replica is reclaimable after the in-flight TTL", async () => {
    const e = evt();
    const longAgo = new Date(Date.now() - 6 * 60 * 1000);
    expect(await claimStripeEvent(e, longAgo)).toBe("new");
    // Same wall-clock now: still inside the TTL from the claim's own timestamp? No -
    // the claim was stamped six minutes ago, so a fresh `now` sees it as stale.
    expect(await claimStripeEvent(e)).toBe("retry");
  });

  it("the unique index is the guard: a second row for one event id cannot exist", async () => {
    const e = evt();
    await prisma.stripeEventReceipt.create({ data: { eventId: e.id, type: e.type, livemode: false } });
    await expect(
      prisma.stripeEventReceipt.create({ data: { eventId: e.id, type: e.type, livemode: false } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("the settle only lands on a row still marked received", async () => {
    const e = evt();
    await claimStripeEvent(e);
    await finishStripeEvent(e.id, { ok: true });
    // A late "failed" from a slower path cannot undo a processed receipt.
    await finishStripeEvent(e.id, { ok: false, error: "late" });
    const row = await prisma.stripeEventReceipt.findUnique({ where: { eventId: e.id } });
    expect(row?.status).toBe("processed");
    expect(row?.lastError).toBeNull();
  });
});

describe("livemode", () => {
  beforeAll(() => {
    __resetEnvCacheForTests();
  });
  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = originalKey;
    __resetEnvCacheForTests();
  });

  it("reads the process's mode from the shape of its own key", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    __resetEnvCacheForTests();
    expect(expectedLivemode()).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_live_abc";
    __resetEnvCacheForTests();
    expect(expectedLivemode()).toBe(true);
    process.env.STRIPE_SECRET_KEY = "rk_live_abc";
    __resetEnvCacheForTests();
    expect(expectedLivemode()).toBe(true);
  });

  it("a test-mode event is refused by a live key, and a live one by a test key", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_abc";
    __resetEnvCacheForTests();
    expect(livemodeMismatch({ livemode: false })).toBe(true);
    expect(livemodeMismatch({ livemode: true })).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_test_abc";
    __resetEnvCacheForTests();
    expect(livemodeMismatch({ livemode: true })).toBe(true);
    expect(livemodeMismatch({ livemode: false })).toBe(false);
  });

  it("asserts nothing it cannot know: no key, an odd key, or an event with no mode", () => {
    process.env.STRIPE_SECRET_KEY = "sk_weird_abc";
    __resetEnvCacheForTests();
    expect(expectedLivemode()).toBeNull();
    expect(livemodeMismatch({ livemode: true })).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_live_abc";
    __resetEnvCacheForTests();
    expect(livemodeMismatch({})).toBe(false);
    expect(livemodeMismatch({ livemode: "true" })).toBe(false);
  });
});
