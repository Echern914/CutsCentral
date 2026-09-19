import { describe, expect, it, vi } from "vitest";
import { collectTapToPay, type TerminalLike } from "./collect";
import type { TapToPayRequest } from "./protocol";

/**
 * 🔴 THIS FILE DOES NOT PROVE TAP TO PAY WORKS, and cannot. There is no NFC
 * hardware here, no Apple entitlement and no card. What it pins is the part
 * that is decidable without any of those: the ORDER of the SDK calls, what
 * each failure is reported as, and - most importantly - that a device is never
 * the thing that decides money arrived.
 */

const request: TapToPayRequest = {
  requestId: "req_1",
  clientSecret: "pi_1_secret_2",
  connectAccountId: "acct_1ABC",
  locationId: "tml_1ABC",
  amountCents: 4000,
};

function terminal(over: Partial<TerminalLike> = {}): TerminalLike {
  return {
    discoverTapToPayReader: vi.fn(async () => ({ reader: { id: "tap" } })),
    connect: vi.fn(async () => ({ ok: true as const })),
    retrieve: vi.fn(async () => ({ paymentIntent: { id: "pi_1" } })),
    collect: vi.fn(async () => ({ paymentIntent: { id: "pi_1", collected: true } })),
    confirm: vi.fn(async () => ({ status: "succeeded" })),
    ...over,
  };
}

describe("collectTapToPay", () => {
  it("walks discover -> connect -> retrieve -> collect -> confirm, in that order", async () => {
    const order: string[] = [];
    const t = terminal({
      discoverTapToPayReader: vi.fn(async () => {
        order.push("discover");
        return { reader: {} };
      }),
      connect: vi.fn(async () => {
        order.push("connect");
        return { ok: true as const };
      }),
      retrieve: vi.fn(async () => {
        order.push("retrieve");
        return { paymentIntent: {} };
      }),
      collect: vi.fn(async () => {
        order.push("collect");
        return { paymentIntent: {} };
      }),
      confirm: vi.fn(async () => {
        order.push("confirm");
        return { status: "succeeded" };
      }),
    });

    const res = await collectTapToPay(t, request);
    expect(res.outcome).toBe("collected");
    expect(order).toEqual(["discover", "connect", "retrieve", "collect", "confirm"]);
  });

  it("🔴 connects with onBehalfOf and the location - destination charges, not a Stripe-Account header", async () => {
    const connect = vi.fn(async () => ({ ok: true as const }));
    await collectTapToPay(terminal({ connect }), request);
    expect(connect).toHaveBeenCalledWith({
      reader: { id: "tap" },
      locationId: "tml_1ABC",
      onBehalfOf: "acct_1ABC",
    });
  });

  it("reports a device that cannot do it as UNAVAILABLE, not as a failed card", async () => {
    // A barber told "declined" would ask the customer for another card. The
    // truth is this phone cannot take contactless payments at all.
    const noReader = terminal({
      discoverTapToPayReader: vi.fn(async () => ({ error: "no reader" })),
    });
    expect(await collectTapToPay(noReader, request)).toEqual({
      outcome: "unavailable",
      message: "no reader",
    });

    const noConnect = terminal({ connect: vi.fn(async () => ({ error: "entitlement missing" })) });
    expect((await collectTapToPay(noConnect, request)).outcome).toBe("unavailable");
  });

  it("tells a cancellation apart from a decline", async () => {
    const canceled = terminal({
      collect: vi.fn(async () => ({ error: "cancelled", code: "Canceled" })),
    });
    expect((await collectTapToPay(canceled, request)).outcome).toBe("canceled");

    const declined = terminal({
      confirm: vi.fn(async () => ({ error: "card declined", code: "DeclinedByStripeAPI" })),
    });
    expect((await collectTapToPay(declined, request)).outcome).toBe("declined");
  });

  it("anything it does not recognise is FAILED, never quietly collected", async () => {
    const odd = terminal({ confirm: vi.fn(async () => ({ error: "boom", code: "WhoKnows" })) });
    expect((await collectTapToPay(odd, request)).outcome).toBe("failed");
  });

  it("🔴 a confirm that did not succeed is NOT reported as collected", async () => {
    // The one mistake in this file that would cost real money: treating
    // "the SDK returned" as "the customer paid".
    const pending = terminal({ confirm: vi.fn(async () => ({ status: "requires_action" })) });
    const res = await collectTapToPay(pending, request);
    expect(res.outcome).toBe("failed");
    expect(res.message).toContain("requires_action");
  });

  it("stops at the first failure and does not go on collecting", async () => {
    const collect = vi.fn(async () => ({ paymentIntent: {} }));
    const t = terminal({ retrieve: vi.fn(async () => ({ error: "no such intent" })), collect });
    expect((await collectTapToPay(t, request)).outcome).toBe("failed");
    expect(collect).not.toHaveBeenCalled();
  });
});
