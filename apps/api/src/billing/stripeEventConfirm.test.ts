import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/**
 * The REAL lookup (not the test stand-in the route suites use): only the id,
 * on the right account; "no such event" is a forgery, anything else is Stripe
 * being unreachable and must be retried, never read as "forged".
 */

const retrieve = vi.hoisted(() => vi.fn());
vi.mock("./stripe.js", () => ({
  stripeClient: () => ({ events: { retrieve } }),
}));

const { confirmEventWithStripe, __setStripeEventFetcherForTests } = await import("./stripeEventConfirm.js");

const signed = (over: Partial<Stripe.Event> = {}) =>
  ({
    id: "evt_1",
    type: "payment_intent.succeeded",
    livemode: false,
    data: { object: { id: "pi_doctored" } },
    ...over,
  }) as unknown as Stripe.Event;

beforeEach(() => {
  retrieve.mockReset();
  __setStripeEventFetcherForTests(null); // the real fetcher
});

describe("asking Stripe", () => {
  it("asks for the delivery's id - and returns Stripe's copy, not the delivery", async () => {
    const real = signed({ data: { object: { id: "pi_real" } } as never });
    retrieve.mockResolvedValue(real);
    const out = await confirmEventWithStripe(signed());
    expect(retrieve).toHaveBeenCalledWith("evt_1", undefined, undefined);
    expect(out).toEqual({ ok: true, event: real });
  });

  it("a connected account's event is looked up on that account", async () => {
    retrieve.mockResolvedValue(signed({ account: "acct_9" }));
    await confirmEventWithStripe(signed({ account: "acct_9" }));
    expect(retrieve).toHaveBeenCalledWith("evt_1", undefined, { stripeAccount: "acct_9" });
  });

  it("🔴 Stripe has no such event: a forgery", async () => {
    retrieve.mockRejectedValue(Object.assign(new Error("No such event"), { statusCode: 404, code: "resource_missing" }));
    expect(await confirmEventWithStripe(signed())).toEqual({ ok: false, reason: "unknown_event" });
  });

  it("🔴 Stripe unreachable or erroring is NOT a forgery - it throws, so the delivery is retried", async () => {
    retrieve.mockRejectedValue(Object.assign(new Error("rate limited"), { statusCode: 429 }));
    await expect(confirmEventWithStripe(signed())).rejects.toThrow("rate limited");
  });

  it("a different type under the same id is refused", async () => {
    retrieve.mockResolvedValue(signed({ type: "charge.refunded" } as never));
    expect(await confirmEventWithStripe(signed())).toEqual({ ok: false, reason: "type_mismatch" });
  });
});
