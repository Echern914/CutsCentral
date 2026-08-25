import { describe, expect, it } from "vitest";
import {
  appointmentPaymentSnapshot,
  stripeAuthorizedCents,
  stripeCollectedCents,
  type PaymentRowFacts,
} from "./appointmentPayment.js";

/**
 * These assert the HONESTY RULE, not arithmetic: the states ChairBack is
 * allowed to claim, and the ones it must refuse to claim. Every case here maps
 * to a sentence the appointment sheet puts in front of a barber.
 */

function pay(over: Partial<PaymentRowFacts> = {}): PaymentRowFacts {
  return {
    status: "succeeded",
    amount: 4000,
    capturedAmount: null,
    refundedAmount: 0,
    ...over,
  };
}

const base = {
  price: 40,
  payment: null as PaymentRowFacts | null,
  chairPaid: null as number | null,
  chairMethod: null as string | null,
  chairCheckedOut: false,
  external: false,
};

describe("what ChairBack refuses to claim", () => {
  it("an Acuity-owned booking is EXTERNAL, never unpaid", () => {
    const snap = appointmentPaymentSnapshot({ ...base, external: true });
    expect(snap.state).toBe("external");
    // Saying "$40 still owed" about money we cannot see is the exact lie this
    // guards: the remaining balance is UNKNOWN, not forty dollars.
    expect(snap.remainingCents).toBeNull();
    expect(snap.collectedCents).toBe(0);
  });

  it("an external booking discloses NOTHING from a stray local payment row", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      external: true,
      payment: pay(),
      chairPaid: 40,
      chairMethod: "cash",
    });
    expect(snap.state).toBe("external");
    expect(snap.onlineCents).toBe(0);
    expect(snap.inPersonCents).toBe(0);
    expect(snap.method).toBeNull();
  });

  it("never returns card data, on any path", () => {
    for (const external of [true, false]) {
      const snap = appointmentPaymentSnapshot({
        ...base,
        external,
        payment: pay(),
        chairPaid: 40,
        chairMethod: "card",
      });
      expect(snap.card).toBeNull();
      expect(snap.receiptUrl).toBeNull();
    }
  });
});

describe("collected money", () => {
  it("unpaid when nothing has come in", () => {
    const snap = appointmentPaymentSnapshot(base);
    expect(snap.state).toBe("unpaid");
    expect(snap.remainingCents).toBe(4000);
  });

  it("paid in full from the chair alone", () => {
    const snap = appointmentPaymentSnapshot({ ...base, chairPaid: 40, chairMethod: "cash" });
    expect(snap.state).toBe("paid");
    expect(snap.remainingCents).toBe(0);
    expect(snap.inPersonCents).toBe(4000);
    expect(snap.method).toBe("cash");
  });

  it("a deposit online leaves the rest owed at the chair", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      payment: pay({ amount: 1500 }),
      price: 40,
    });
    expect(snap.state).toBe("deposit");
    expect(snap.onlineCents).toBe(1500);
    expect(snap.remainingCents).toBe(2500);
  });

  it("online + chair money ADD (they never overlap)", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      payment: pay({ amount: 1500 }),
      chairPaid: 25,
      chairMethod: "cash",
    });
    expect(snap.collectedCents).toBe(4000);
    expect(snap.state).toBe("paid");
    expect(snap.remainingCents).toBe(0);
  });

  it("over-collection owes zero, never a negative balance", () => {
    const snap = appointmentPaymentSnapshot({ ...base, price: 15, chairPaid: 40 });
    expect(snap.remainingCents).toBe(0);
    expect(snap.state).toBe("paid");
  });

  it("collected money on an UNPRICED booking still reads as paid", () => {
    const snap = appointmentPaymentSnapshot({ ...base, price: null, chairPaid: 30 });
    expect(snap.totalCents).toBeNull();
    expect(snap.remainingCents).toBeNull();
    expect(snap.state).toBe("paid");
  });
});

describe("holds are not collected money", () => {
  it("requires_capture keeps the balance owed and surfaces the hold separately", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      payment: pay({ status: "requires_capture", amount: 4000 }),
    });
    expect(snap.state).toBe("unpaid");
    expect(snap.collectedCents).toBe(0);
    expect(snap.remainingCents).toBe(4000);
    expect(snap.authorizedCents).toBe(4000);
  });

  it("a captured hold counts only the captured cents", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      payment: pay({ status: "succeeded", amount: 4000, capturedAmount: 3000 }),
    });
    expect(snap.onlineCents).toBe(3000);
    expect(snap.authorizedCents).toBe(0);
    expect(snap.state).toBe("deposit");
  });

  it("statuses with no money behind them collect nothing", () => {
    for (const status of ["requires_payment_method", "requires_action", "processing", "canceled", "failed"]) {
      expect(stripeCollectedCents(pay({ status }))).toBe(0);
      expect(stripeAuthorizedCents(pay({ status }))).toBe(0);
    }
  });
});

describe("refunds", () => {
  it("a FULL refund is its own state, not 'unpaid'", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      payment: pay({ status: "refunded", amount: 4000, refundedAmount: 4000 }),
    });
    expect(snap.state).toBe("refunded");
    expect(snap.refundedCents).toBe(4000);
    expect(snap.collectedCents).toBe(0);
  });

  it("a PARTIAL refund leaves what is still held as the collected figure", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      payment: pay({ status: "partially_refunded", amount: 4000, refundedAmount: 1000 }),
    });
    expect(snap.onlineCents).toBe(3000);
    expect(snap.refundedCents).toBe(1000);
    expect(snap.state).toBe("deposit");
    expect(snap.remainingCents).toBe(1000);
  });

  it("a refund larger than the charge can never read as negative money", () => {
    expect(
      stripeCollectedCents(pay({ status: "refunded", amount: 4000, refundedAmount: 9999 })),
    ).toBe(0);
  });
});

describe("a closed chair moment", () => {
  it("a COMPED cut owes nothing, even at $0", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      price: 40,
      chairPaid: 0,
      chairMethod: "other",
      chairCheckedOut: true,
    });
    // Saying "$40 remaining" about a cut the barber deliberately gave away is
    // the same class of lie as guessing at an Acuity payment.
    expect(snap.remainingCents).toBe(0);
    expect(snap.state).toBe("paid");
    expect(snap.collectedCents).toBe(0);
    expect(snap.method).toBe("other");
  });

  it("a short chair collection still closes the balance", () => {
    const snap = appointmentPaymentSnapshot({
      ...base,
      price: 40,
      chairPaid: 35,
      chairMethod: "cash",
      chairCheckedOut: true,
    });
    expect(snap.remainingCents).toBe(0);
    expect(snap.state).toBe("paid");
    expect(snap.inPersonCents).toBe(3500);
  });
});
