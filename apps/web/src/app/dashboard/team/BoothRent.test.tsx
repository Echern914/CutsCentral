import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RentSummary } from "@/lib/boothRent";

/**
 * Booth rent on the owner's team card. Money, so: nothing says "saved" or
 * "recorded" before the server does, a failure keeps what was typed, and a
 * retried payment carries the same id (so it's recorded once).
 */

const setRentAction = vi.fn();
const recordRentPaymentAction = vi.fn();
const toast = vi.fn();

vi.mock("./actions", () => ({
  setRentAction: (...a: unknown[]) => setRentAction(...a),
  recordRentPaymentAction: (...a: unknown[]) => recordRentPaymentAction(...a),
  deleteRentPaymentAction: vi.fn(),
  rentHistoryAction: vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { OwnerRent } = await import("./BoothRent");

const none: RentSummary = { amountCents: null, period: null, paidThisPeriodCents: 0, dueCents: 0, lastPayment: null };
const weekly: RentSummary = { amountCents: 15000, period: "WEEKLY", paidThisPeriodCents: 10000, dueCents: 5000, lastPayment: null };

const view = (rent: RentSummary, onRent = vi.fn()) =>
  render(<OwnerRent linkId="tl1" businessName="Joe's Cuts" rent={rent} onRent={onRent} />);
const amountInput = () => screen.getByLabelText("Amount") as HTMLInputElement;

beforeEach(() => {
  setRentAction.mockReset();
  recordRentPaymentAction.mockReset();
  toast.mockReset();
});

describe("the rent line", () => {
  it("with no rent: says so, and offers to set it", () => {
    view(none);
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(document.querySelector('[data-qa="record-payment"]')).toBeNull();
    expect(document.querySelector('[data-qa="set-rent"]')!.textContent).toBe("Set rent");
  });

  it("shows the amount and what's still owed this week", () => {
    view(weekly);
    expect(screen.getByText("$150 / week")).toBeTruthy();
    expect(document.querySelector('[data-qa="rent-status"]')!.textContent).toBe("Owes $50 this week");
  });

  it("paid up reads as paid", () => {
    view({ ...weekly, paidThisPeriodCents: 15000, dueCents: 0 });
    expect(document.querySelector('[data-qa="rent-status"]')!.textContent).toBe("Paid this week");
  });
});

describe("setting rent", () => {
  it("🔴 a bad amount never reaches the server", () => {
    view(none);
    fireEvent.click(document.querySelector('[data-qa="set-rent"]')!);
    fireEvent.change(amountInput(), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Enter an amount above $0")).toBeTruthy();
    expect(setRentAction).not.toHaveBeenCalled();
  });

  it("saves the amount and period, then shows the server's answer", async () => {
    const onRent = vi.fn();
    setRentAction.mockResolvedValue({ ok: true, rent: { ...none, amountCents: 60000, period: "MONTHLY", dueCents: 60000 } });
    view(none, onRent);
    fireEvent.click(document.querySelector('[data-qa="set-rent"]')!);
    fireEvent.change(amountInput(), { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Every month" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRent).toHaveBeenCalled());
    expect(setRentAction).toHaveBeenCalledWith("tl1", { amountCents: 60000, period: "MONTHLY" });
    expect(toast).toHaveBeenCalledWith("Rent saved", "success");
  });

  it("🔴 a failed save keeps what was typed and says nothing changed", async () => {
    setRentAction.mockResolvedValue({ ok: false, error: "network_error" });
    view(none);
    fireEvent.click(document.querySelector('[data-qa="set-rent"]')!);
    fireEvent.change(amountInput(), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Couldn't save that - nothing changed. Try again.")).toBeTruthy());
    expect(amountInput().value).toBe("150");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("recording a payment", () => {
  it("starts from what's owed", () => {
    view(weekly);
    fireEvent.click(document.querySelector('[data-qa="record-payment"]')!);
    expect(amountInput().value).toBe("50");
  });

  it("🔴 'recorded' only after the server has it; a retry sends the SAME id", async () => {
    const onRent = vi.fn();
    recordRentPaymentAction
      .mockResolvedValueOnce({ ok: false, error: "network_error" })
      .mockResolvedValueOnce({ ok: true, rent: { ...weekly, paidThisPeriodCents: 15000, dueCents: 0 } });
    view(weekly, onRent);
    fireEvent.click(document.querySelector('[data-qa="record-payment"]')!);
    fireEvent.click(document.querySelector('[data-qa="save-payment"]')!);
    await waitFor(() =>
      expect(screen.getByText("Couldn't record that - nothing was saved. Try again.")).toBeTruthy(),
    );
    expect(onRent).not.toHaveBeenCalled();
    expect(amountInput().value).toBe("50");

    fireEvent.click(document.querySelector('[data-qa="save-payment"]')!);
    await waitFor(() => expect(onRent).toHaveBeenCalled());
    const [first, second] = recordRentPaymentAction.mock.calls.map((c) => c[1] as { clientRef: string });
    expect(first!.clientRef).toBe(second!.clientRef);
    expect(toast).toHaveBeenCalledWith("$50 recorded", "success");
  });
});
