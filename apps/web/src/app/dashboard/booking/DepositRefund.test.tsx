import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * THE REFUND DEPOSIT BUTTON - what stops a shop refunding the wrong figure,
 * or twice, or believing a refund happened when it did not.
 *
 *  - nothing moves on the first tap: open, then confirm the exact figure;
 *  - the figure sent is the server's kept amount, never a typed one;
 *  - success is handed to the sheet (its footer), never a toast a phone
 *    cannot see;
 *  - every refusal says what happened to the money, and a figure that moved
 *    is re-read.
 */

const refundDepositAction = vi.fn();
vi.mock("./actions", () => ({
  refundDepositAction: (...a: unknown[]) => refundDepositAction(...a),
}));

const { DepositRefund, explainDepositRefund } = await import("./DepositRefund");

const onRefunded = vi.fn();
const onStale = vi.fn();

function mount(over: { status?: string; amountCents?: number; nonRefundable?: boolean } = {}) {
  return render(
    <DepositRefund
      appointmentId="appt_1"
      status={over.status ?? "canceled"}
      kept={{ amountCents: over.amountCents ?? 1000, nonRefundable: over.nonRefundable ?? false }}
      onRefunded={onRefunded}
      onStale={onStale}
    />,
  );
}

beforeEach(() => {
  cleanup();
  refundDepositAction.mockReset();
  onRefunded.mockReset();
  onStale.mockReset();
});

describe("the refund deposit button", () => {
  it("says what was kept and why, in the booking's own terms", () => {
    mount({ nonRefundable: true });
    expect(
      screen.getByText(/\$10\.00 paid at booking wasn't refunded when this was cancelled\. It was booked as non-refundable\./),
    ).toBeTruthy();
    cleanup();
    mount({ status: "no_show" });
    expect(screen.getByText("$10.00 paid at booking was kept for the no-show.")).toBeTruthy();
    expect(screen.queryByText(/non-refundable/)).toBeNull();
  });

  it("🔴 the first tap moves nothing; the confirm restates the figure and says the client is not messaged", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    expect(refundDepositAction).not.toHaveBeenCalled();
    expect(screen.getByText("Refund $10.00 to the card they paid with?")).toBeTruthy();
    expect(screen.getByText(/ChairBack doesn.t message them about it/)).toBeTruthy();
    // Keep it closes the confirm without a call.
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText("Refund $10.00 to the card they paid with?")).toBeNull();
    expect(refundDepositAction).not.toHaveBeenCalled();
  });

  it("sends the SERVER's figure and the note, and hands success to the sheet", async () => {
    refundDepositAction.mockResolvedValue({ ok: true, result: "refunded", amountCents: 1000, status: "succeeded" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.change(screen.getByLabelText("Reason (optional, for your records)"), {
      target: { value: "  was sick " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith("Refunded $10.00 to their card."));
    expect(refundDepositAction).toHaveBeenCalledWith("appt_1", { amountCents: 1000, note: "was sick" });
  });

  it("an empty note is not sent", async () => {
    refundDepositAction.mockResolvedValue({ ok: true, result: "refunded", amountCents: 1000 });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalled());
    expect(refundDepositAction).toHaveBeenCalledWith("appt_1", { amountCents: 1000 });
  });

  it("already refunded and still-processing each say so", async () => {
    refundDepositAction.mockResolvedValueOnce({ ok: true, result: "already_refunded", amountCents: 1000 });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith("This deposit had already been refunded."));

    cleanup();
    onRefunded.mockReset();
    refundDepositAction.mockResolvedValueOnce({ ok: true, result: "refunded", amountCents: 1000, status: "pending" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    await waitFor(() =>
      expect(onRefunded).toHaveBeenCalledWith("Refund of $10.00 sent. Stripe is still processing it."),
    );
  });

  it("🔴 'unconfirmed' says pressing again is safe, and does NOT claim success", async () => {
    refundDepositAction.mockResolvedValue({ ok: false, result: "unconfirmed", error: "unconfirmed" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Pressing Refund again is safe/);
    expect(onRefunded).not.toHaveBeenCalled();
    // The confirm stays open so the second press is one tap away.
    expect(screen.getByText("Refund $10.00 to the card they paid with?")).toBeTruthy();
  });

  it("a figure that moved is re-read, and the shop is told to check it", async () => {
    refundDepositAction.mockResolvedValue({ ok: false, error: "amount_changed" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/amount changed/);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onRefunded).not.toHaveBeenCalled();
  });

  it("a refusal that needs a person names ChairBack support and warns off the shop's own Stripe", async () => {
    refundDepositAction.mockResolvedValue({ ok: false, error: "needs_support", reason: "transfer_partially_reversed" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Contact ChairBack support/);
    expect(alert.textContent).toMatch(/won't reach the client/);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("every refusal says nothing was refunded, or why there was nothing to refund", () => {
    expect(explainDepositRefund("refund_refused", undefined)).toBe("Stripe refused the refund. Nothing was refunded.");
    expect(explainDepositRefund("stripe_unavailable", undefined)).toMatch(/Nothing was refunded - try again/);
    expect(explainDepositRefund("network_error", undefined)).toMatch(/Nothing was refunded - try again/);
    expect(explainDepositRefund("nothing_to_refund", undefined)).toMatch(/already been refunded/);
    expect(explainDepositRefund("not_refundable", "booking_open")).toMatch(/cancelled or no-show/);
    expect(explainDepositRefund("not_refundable", "not_collected")).toMatch(/never collected/);
    // The subscription wall and anything unforeseen: still no false success.
    expect(explainDepositRefund("subscription_required", undefined)).toBe("That didn't work. Nothing was refunded.");
  });

  it("the confirm button is disabled while the refund is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    refundDepositAction.mockImplementation(() => new Promise((r) => (resolve = r)));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));
    const busy = await screen.findByRole("button", { name: "Refunding…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(refundDepositAction).toHaveBeenCalledTimes(1);
    resolve({ ok: true, result: "refunded", amountCents: 1000 });
    await waitFor(() => expect(onRefunded).toHaveBeenCalledTimes(1));
  });
});
