import { afterEach, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests } from "@chairback/config";
import { tipPresets } from "@chairback/config";
import { tipClosedReason, tipViewFor, type TipAppointmentFacts, type TipShopFacts } from "./tips.js";

/**
 * The one check behind the tip card, the tip route and the tip email. The
 * route tests (routes/tipsFlow.test.ts) walk most rules end to end; these pin
 * the two that need conditions a route test cannot cheaply build: another
 * platform's booking, and a shop whose subscription has lapsed.
 */

const now = new Date("2026-10-05T18:00:00.000Z");

const appt = (over: Partial<TipAppointmentFacts> = {}): TipAppointmentFacts => ({
  status: "COMPLETED",
  endsAt: new Date("2026-10-05T17:00:00.000Z"),
  clientId: "client_1",
  groupId: null,
  priceAtBooking: 40,
  visit: null,
  ...over,
});

const shop = (over: Partial<TipShopFacts> = {}): TipShopFacts => ({
  onlineTipsEnabled: true,
  tipPolicy: "not_included",
  connectChargesEnabled: true,
  stripeConnectAccountId: "acct_1",
  subscriptionStatus: "active",
  trialEndsAt: null,
  compAccess: false,
  ...over,
});

const saved = { ...process.env };
function billingOn() {
  // connectEnabled() and billingEnabled() read these.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy_2";
  __resetEnvCacheForTests();
}

afterEach(() => {
  for (const k of ["STRIPE_SECRET_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetEnvCacheForTests();
});

describe("may this visit be tipped", () => {
  it("a finished, priced, native visit at a ready shop: yes", () => {
    billingOn();
    expect(tipClosedReason(appt(), shop(), now)).toBeNull();
  });

  it("another platform's booking (Acuity owns it): no - ChairBack takes no money for it", () => {
    billingOn();
    expect(tipClosedReason(appt({ visit: { acuityAppointmentId: "1234567" } }), shop(), now)).toBe("external");
    // A ChairBack visit record linked by completion is still ChairBack's.
    expect(tipClosedReason(appt({ visit: { acuityAppointmentId: "booking:abc" } }), shop(), now)).toBeNull();
  });

  it("a shop whose subscription lapsed: no - it could neither see nor refund the tip", () => {
    billingOn();
    expect(
      tipClosedReason(appt(), shop({ subscriptionStatus: "canceled", trialEndsAt: new Date("2026-09-01") }), now),
    ).toBe("no_access");
    // A comped shop always has access.
    expect(
      tipClosedReason(appt(), shop({ subscriptionStatus: "canceled", trialEndsAt: null, compAccess: true }), now),
    ).toBeNull();
  });

  it("the window closes exactly seven days after the visit ended", () => {
    billingOn();
    const end = new Date("2026-10-05T17:00:00.000Z");
    const justBefore = new Date(end.getTime() + 7 * 24 * 60 * 60_000 - 1);
    const at = new Date(end.getTime() + 7 * 24 * 60 * 60_000);
    expect(tipClosedReason(appt({ endsAt: end }), shop(), justBefore)).toBeNull();
    expect(tipClosedReason(appt({ endsAt: end }), shop(), at)).toBe("window_closed");
  });

  it("a tip already given is shown whatever the shop has switched since", () => {
    billingOn();
    const paid = { status: "succeeded", amount: 800, capturedAmount: 800, refundedAmount: 0 };
    expect(tipViewFor(appt(), shop({ onlineTipsEnabled: false }), paid, now)).toEqual({
      state: "paid",
      amountCents: 800,
    });
    // Decided from amounts: a refunded tip whose status read back as succeeded is refunded.
    expect(
      tipViewFor(appt(), shop(), { status: "succeeded", amount: 800, capturedAmount: 800, refundedAmount: 800 }, now),
    ).toEqual({ state: "refunded", amountCents: 800 });
  });
});

describe("tip suggestions on a visit booked with an offer", () => {
  it("🔴 start from the price BEFORE the discount: a free $40 haircut suggests a $40 haircut's tips", () => {
    billingOn();
    const view = tipViewFor(appt({ priceAtBooking: 0, offerRedemption: { listPriceCents: 4000 } }), shop(), null, now);
    expect(view).toMatchObject({ state: "open", presets: tipPresets(4000) });
  });

  it("a half-price visit too", () => {
    billingOn();
    const view = tipViewFor(appt({ priceAtBooking: 20, offerRedemption: { listPriceCents: 4000 } }), shop(), null, now);
    expect(view).toMatchObject({ presets: tipPresets(4000) });
  });
});
