import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CheckoutRefundable } from "./actions";

/**
 * THE REFUND BUTTON - what stops a barber refunding the wrong way, or twice.
 *
 *  - nothing is refunded on the first tap: open, then confirm the exact figure;
 *  - the figure sent is the server's refundable amount, never a typed one;
 *  - every refusal says what happened to the money, because each one leads to
 *    a different next step (and "refund it in Stripe" must name the right
 *    dashboard, since the wrong one is how the first live refund went astray);
 *  - a payment that cannot be refunded here offers no button at all.
 */

const getCheckoutRefundsAction = vi.fn();
const refundCheckoutPaymentAction = vi.fn();

vi.mock("./actions", () => ({
  getCheckoutRefundsAction: (...a: unknown[]) => getCheckoutRefundsAction(...a),
  refundCheckoutPaymentAction: (...a: unknown[]) => refundCheckoutPaymentAction(...a),
}));

const { CheckoutRefund } = await import("./CheckoutRefund");

const payment = (over: Partial<CheckoutRefundable> = {}): CheckoutRefundable => ({
  paymentId: "pay_1",
  method: "tap_to_pay",
  collectedCents: 100,
  refundedCents: 0,
  refundableCents: 100,
  refundBlocker: null,
  card: { brand: "discover", last4: "1416" },
  paidAt: "2026-09-23T02:04:44.000Z",
  ...over,
});

function withRefunds(refunds: CheckoutRefundable[]) {
  getCheckoutRefundsAction.mockResolvedValue({ ok: true, refunds });
}

const onRefunded = vi.fn();
const mount = () => render(<CheckoutRefund appointmentId="appt_1" onRefunded={onRefunded} />);

beforeEach(() => {
  getCheckoutRefundsAction.mockReset();
  refundCheckoutPaymentAction.mockReset();
  onRefunded.mockReset();
});

describe("the refund button", () => {
  it("renders nothing when this checkout took no card payment", async () => {
    withRefunds([]);
    const { container } = mount();
    await waitFor(() => expect(getCheckoutRefundsAction).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("🔴 reads the refunds read, which answers for a CANCELLED appointment too", async () => {
    // The checkout read refuses a cancelled appointment, and borrowing it is
    // how cancelling a paid cut hid this button. The mock above offers no
    // `getCheckoutAction` at all, so reaching for it again fails this suite.
    withRefunds([payment()]);
    mount();
    expect(await screen.findByText("Refund $1.00")).toBeTruthy();
    expect(getCheckoutRefundsAction).toHaveBeenCalledWith("appt_1");
  });

  it("🔴 the first tap refunds NOTHING - it only asks, with the figure and the card", async () => {
    withRefunds([payment()]);
    mount();
    fireEvent.click(await screen.findByText("Refund $1.00"));
    expect(refundCheckoutPaymentAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Refund \$1\.00 to discover ···· 1416\?/)).toBeTruthy();
    expect(screen.getByText(/can't be undone/)).toBeTruthy();
  });

  it("confirming sends the SERVER's refundable figure and the reason, then re-reads", async () => {
    withRefunds([payment()]);
    refundCheckoutPaymentAction.mockResolvedValue({ ok: true, result: "refunded", amountCents: 100 });
    mount();
    fireEvent.click(await screen.findByText("Refund $1.00"));
    fireEvent.change(document.querySelector('[data-qa="refund-note"]')!, {
      target: { value: "Test payment" },
    });
    fireEvent.click(document.querySelector('[data-qa="refund-confirm"]')!);

    await waitFor(() => expect(refundCheckoutPaymentAction).toHaveBeenCalledTimes(1));
    expect(refundCheckoutPaymentAction).toHaveBeenCalledWith("appt_1", {
      paymentId: "pay_1",
      amountCents: 100,
      note: "Test payment",
    });
    // Said in the sheet's footer, not a toast (which draws beneath the sheet).
    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith("Refunded $1.00 to the client."));
    expect(getCheckoutRefundsAction).toHaveBeenCalledTimes(2);
  });

  it("an unconfirmed refund says pressing again is safe", async () => {
    withRefunds([payment()]);
    refundCheckoutPaymentAction.mockResolvedValue({ ok: false, result: "unconfirmed", error: "unconfirmed" });
    mount();
    fireEvent.click(await screen.findByText("Refund $1.00"));
    fireEvent.click(document.querySelector('[data-qa="refund-confirm"]')!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Pressing Refund again is safe/);
    expect(onRefunded).not.toHaveBeenCalled();
  });

  it("🔴 a lost answer is UNKNOWN, never 'Nothing was refunded'", async () => {
    // The 12s web-to-API timeout, or a 5xx after Stripe acted: the refund may
    // have gone through, and "Nothing was refunded" sends the barber to hand
    // back cash as well.
    for (const error of ["network_error", "http_500", "internal"]) {
      withRefunds([payment()]);
      refundCheckoutPaymentAction.mockResolvedValue({ ok: false, error });
      const { unmount } = mount();
      fireEvent.click(await screen.findByText("Refund $1.00"));
      fireEvent.click(document.querySelector('[data-qa="refund-confirm"]')!);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, error).not.toMatch(/Nothing was refunded/);
      expect(alert.textContent, error).toMatch(/couldn't confirm the refund/);
      unmount();
    }
  });

  it("🔴 no answer at all (the call throws) says so, instead of nothing", async () => {
    withRefunds([payment()]);
    refundCheckoutPaymentAction.mockRejectedValue(new Error("offline"));
    mount();
    fireEvent.click(await screen.findByText("Refund $1.00"));
    fireEvent.click(document.querySelector('[data-qa="refund-confirm"]')!);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't confirm the refund/);
  });

  it("Stripe saying no, before anything moved, still says nothing was refunded", async () => {
    withRefunds([payment()]);
    refundCheckoutPaymentAction.mockResolvedValue({ ok: false, error: "stripe_unavailable" });
    mount();
    fireEvent.click(await screen.findByText("Refund $1.00"));
    fireEvent.click(document.querySelector('[data-qa="refund-confirm"]')!);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nothing was refunded/);
  });

  it("🔴 a refund it cannot finish sends the shop to SUPPORT, and warns off its own Stripe", async () => {
    // The shop cannot open the platform dashboard, and "Refund" in its OWN
    // Stripe account takes the money back from the shop while the customer
    // gets nothing - the exact mistake on the first live payment.
    withRefunds([payment()]);
    refundCheckoutPaymentAction.mockResolvedValue({
      ok: false,
      error: "refund_in_stripe",
      reason: "partially_refunded",
    });
    mount();
    fireEvent.click(await screen.findByText("Refund $1.00"));
    fireEvent.click(document.querySelector('[data-qa="refund-confirm"]')!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Contact ChairBack support/);
    expect(alert.textContent).toMatch(/your own Stripe account won't reach the customer/);
  });

  it("an already-refunded payment offers no button", async () => {
    withRefunds([payment({ refundedCents: 100, refundableCents: 0, refundBlocker: "refunded" })]);
    mount();
    expect(await screen.findByText(/refunded \$1\.00/)).toBeTruthy();
    expect(document.querySelector('[data-qa="refund-open"]')).toBeNull();
  });

  it("a payment whose charge is still being confirmed offers no button and says why", async () => {
    withRefunds([payment({ refundBlocker: "unconfirmed_charge" })]);
    mount();
    expect(await screen.findByText(/still being confirmed/)).toBeTruthy();
    expect(document.querySelector('[data-qa="refund-open"]')).toBeNull();
  });
});
