import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * REFUND TIP on the appointment sheet. The same two presses and honesty as
 * Refund deposit (DepositRefund.test.tsx), plus the one thing only a tip has
 * to say: Stripe's fee is not given back, so it comes out of the shop's
 * balance. That is said BEFORE the press, not discovered on a statement.
 */

const refundTipAction = vi.fn();
vi.mock("./actions", () => ({
  refundTipAction: (...a: unknown[]) => refundTipAction(...a),
  refundDepositAction: vi.fn(),
}));

const { TipRefund } = await import("./TipRefund");

const onRefunded = vi.fn();
const onStale = vi.fn();

const mount = () =>
  render(
    <TipRefund
      appointmentId="appt_1"
      tip={{ refundableCents: 800, feeCents: 53 }}
      onRefunded={onRefunded}
      onStale={onStale}
    />,
  );

beforeEach(() => {
  cleanup();
  refundTipAction.mockReset();
  onRefunded.mockReset();
  onStale.mockReset();
});

describe("the refund tip button", () => {
  it("🔴 the first tap moves nothing; the confirm states the figure AND that the fee stays with the shop", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund tip $8.00" }));
    expect(refundTipAction).not.toHaveBeenCalled();
    expect(screen.getByText("Refund the $8.00 tip to the client?")).toBeTruthy();
    expect(screen.getByText(/Stripe.s \$0\.53 fee isn.t returned, so it comes out of your balance/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByText("Refund the $8.00 tip to the client?")).toBeNull();
    expect(refundTipAction).not.toHaveBeenCalled();
  });

  it("sends the SERVER's figure, and hands success to the sheet's footer", async () => {
    refundTipAction.mockResolvedValue({ ok: true, result: "refunded", amountCents: 800, status: "succeeded" });
    const { container } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund tip $8.00" }));
    fireEvent.change(screen.getByLabelText("Reason (optional, for your records)"), {
      target: { value: " tipped twice " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refund $8.00" }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith("Refunded the $8.00 tip to the client."));
    expect(refundTipAction).toHaveBeenCalledWith("appt_1", { amountCents: 800, note: "tipped twice" });
    // Stops offering at once.
    expect(container.innerHTML).toBe("");
  });

  it("already refunded, and still processing, each say so", async () => {
    refundTipAction.mockResolvedValueOnce({ ok: false, error: "nothing_to_refund" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund tip $8.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $8.00" }));
    await waitFor(() => expect(onRefunded).toHaveBeenCalledWith("This tip had already been refunded."));

    cleanup();
    onRefunded.mockReset();
    refundTipAction.mockResolvedValueOnce({ ok: true, result: "refunded", amountCents: 800, status: "pending" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund tip $8.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $8.00" }));
    await waitFor(() =>
      expect(onRefunded).toHaveBeenCalledWith("Refund of the $8.00 tip sent. Stripe is still processing it."),
    );
  });

  it("🔴 no answer is UNKNOWN: pressing again is safe, and nothing is claimed", async () => {
    refundTipAction.mockRejectedValue(new Error("Failed to fetch"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund tip $8.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $8.00" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Pressing Refund again is safe/);
    expect(alert.textContent).not.toMatch(/Nothing was refunded/);
    expect(onRefunded).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Refund $8.00" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a figure that moved is re-read", async () => {
    refundTipAction.mockResolvedValue({ ok: false, error: "amount_changed" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Refund tip $8.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $8.00" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/amount changed/);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("a refusal never mentions a deposit", async () => {
    for (const answer of [
      { ok: false, error: "refund_refused" },
      { ok: false, error: "needs_support", reason: "transfer_partially_reversed" },
      { ok: false, error: "not_refundable", reason: "not_collected" },
      { ok: false, error: "stripe_unavailable" },
    ]) {
      cleanup();
      refundTipAction.mockResolvedValueOnce(answer);
      mount();
      fireEvent.click(screen.getByRole("button", { name: "Refund tip $8.00" }));
      fireEvent.click(screen.getByRole("button", { name: "Refund $8.00" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, answer.error).not.toMatch(/deposit/i);
    }
  });
});
