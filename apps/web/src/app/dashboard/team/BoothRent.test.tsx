import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RentHistory, RentSummary } from "@/lib/boothRent";

/**
 * Booth rent on the owner's team card. Money, so: this period never reads as
 * "settled" while an older one is unpaid, nothing says "saved" or "recorded"
 * before the server does, a failure keeps what was typed, a retried payment
 * carries the same id (so it's recorded once), and a void is confirmed first.
 */

const setRentAction = vi.fn();
const recordRentPaymentAction = vi.fn();
const voidRentPaymentAction = vi.fn();
const rentHistoryAction = vi.fn();
const toast = vi.fn();

vi.mock("./actions", () => ({
  setRentAction: (...a: unknown[]) => setRentAction(...a),
  recordRentPaymentAction: (...a: unknown[]) => recordRentPaymentAction(...a),
  voidRentPaymentAction: (...a: unknown[]) => voidRentPaymentAction(...a),
  voidRentRateAction: vi.fn(),
  rentHistoryAction: (...a: unknown[]) => rentHistoryAction(...a),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { OwnerRent } = await import("./BoothRent");

const none: RentSummary = {
  current: null,
  balanceCents: 0,
  creditCents: 0,
  unpaid: [],
  rate: null,
  scheduled: null,
  nextChangeOn: null,
  earliestStart: null,
  lastPayment: null,
};
/** $150 a week since Sep 14; last week was missed, nothing paid this week. */
const behind: RentSummary = {
  ...none,
  rate: { amountCents: 15000, period: "WEEKLY", since: "2026-09-14" },
  current: { start: "2026-09-21", end: "2026-09-27", amountCents: 15000, paidCents: 0, dueCents: 15000 },
  balanceCents: 30000,
  unpaid: [
    { start: "2026-09-14", end: "2026-09-20", amountCents: 15000, dueCents: 15000 },
    { start: "2026-09-21", end: "2026-09-27", amountCents: 15000, dueCents: 15000 },
  ],
  nextChangeOn: "2026-09-28",
};

const view = (rent: RentSummary, onRent = vi.fn()) =>
  render(<OwnerRent linkId="tl1" businessName="Joe's Shop" rent={rent} onRent={onRent} />);
const qa = (key: string) => document.querySelector(`[data-qa="${key}"]`);
const amountInput = () => screen.getByLabelText("Amount") as HTMLInputElement;

beforeEach(() => {
  for (const fn of [setRentAction, recordRentPaymentAction, voidRentPaymentAction, rentHistoryAction, toast]) {
    fn.mockReset();
  }
});

describe("the rent card", () => {
  it("with no rent: says so, and offers to set it", () => {
    view(none);
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(qa("record-payment")).toBeNull();
    expect(qa("set-rent")!.textContent).toBe("Set rent");
  });

  it("🔴 shows this week AND the whole balance, with the oldest unpaid week", () => {
    view(behind);
    expect(screen.getByText("$150 / week")).toBeTruthy();
    expect(qa("rent-current")!.textContent).toBe("This week (Mon Sep 21 – Sun Sep 27): $150 due");
    expect(qa("rent-total")!.textContent).toBe("Owes $300 in total · unpaid since Sep 14");
  });

  it("a partly paid week says what's left of it", () => {
    view({ ...behind, current: { ...behind.current!, paidCents: 5000, dueCents: 10000 } });
    expect(qa("rent-current")!.textContent).toBe("This week (Mon Sep 21 – Sun Sep 27): $100 of $150 due");
  });

  it("paid ahead shows a credit; fully paid says so", () => {
    const paid = { ...behind, balanceCents: 0, unpaid: [], current: { ...behind.current!, paidCents: 15000, dueCents: 0 } };
    view({ ...paid, creditCents: 10000 });
    expect(qa("rent-total")!.textContent).toBe("$100 credit (paid ahead)");
    view(paid);
    expect(screen.getAllByText("All paid up")).toHaveLength(1);
  });

  it("🔴 a period reads as the rent's own days, not the calendar's", () => {
    // Rent that started on a Thursday: its week is Thursday to Wednesday...
    view({
      ...behind,
      current: { start: "2026-09-24", end: "2026-09-30", amountCents: 15000, paidCents: 0, dueCents: 15000 },
      scheduled: { amountCents: null, period: null, startsOn: "2026-10-01" },
    });
    expect(qa("rent-current")!.textContent).toBe("This week (Thu Sep 24 – Wed Sep 30): $150 due");
    // ...and a stop names the first day with no rent.
    expect(qa("rent-next")!.textContent).toBe("No rent from Thu, Oct 1");
  });

  it("a month from the 15th reads as the 15th to the 14th", () => {
    view({
      ...behind,
      rate: { amountCents: 60000, period: "MONTHLY", since: "2026-08-15" },
      current: { start: "2026-09-15", end: "2026-10-14", amountCents: 60000, paidCents: 0, dueCents: 60000 },
    });
    expect(qa("rent-current")!.textContent).toBe("This month (Sep 15 – Oct 14): $600 due");
  });

  it("a change that hasn't started yet is shown with its date", () => {
    view({ ...behind, scheduled: { amountCents: 20000, period: "WEEKLY", startsOn: "2026-09-28" } });
    expect(qa("rent-next")!.textContent).toBe("Changes to $200 / week on Mon, Sep 28");
  });
});

describe("setting rent", () => {
  it("🔴 a bad amount never reaches the server", () => {
    view(none);
    fireEvent.click(qa("set-rent")!);
    fireEvent.change(amountInput(), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Enter an amount above $0")).toBeTruthy();
    expect(setRentAction).not.toHaveBeenCalled();
  });

  it("🔴 new rent sends the start day the owner picked", async () => {
    const onRent = vi.fn();
    setRentAction.mockResolvedValue({ ok: true, rent: behind });
    view(none, onRent);
    fireEvent.click(qa("set-rent")!);
    fireEvent.change(amountInput(), { target: { value: "600" } });
    fireEvent.click(screen.getByRole("button", { name: "Every month" }));
    fireEvent.change(qa("rent-starts-on")!, { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRent).toHaveBeenCalledWith(behind));
    expect(setRentAction).toHaveBeenCalledWith("tl1", { amountCents: 60000, period: "MONTHLY", startsOn: "2026-09-01" });
  });

  it("🔴 a change says when it takes effect, and sends no start day", async () => {
    setRentAction.mockResolvedValue({
      ok: true,
      rent: { ...behind, scheduled: { amountCents: 20000, period: "WEEKLY", startsOn: "2026-09-28" } },
    });
    view(behind);
    fireEvent.click(qa("set-rent")!);
    expect(qa("takes-effect")!.textContent).toBe("A change or a stop takes effect Mon, Sep 28. This week stays $150.");
    expect(qa("rent-starts-on")).toBeNull();
    fireEvent.change(amountInput(), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Takes effect Mon, Sep 28", "success"));
    expect(setRentAction).toHaveBeenCalledWith("tl1", { amountCents: 20000, period: "WEEKLY" });
  });

  it("🔴 a refused or failed save keeps what was typed and never claims success", async () => {
    setRentAction.mockResolvedValueOnce({ ok: false, error: "start_too_early" });
    setRentAction.mockResolvedValueOnce({ ok: false, error: "network_error" });
    view({ ...none, earliestStart: "2026-01-01" });
    fireEvent.click(qa("set-rent")!);
    fireEvent.change(amountInput(), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(/^Pick Thu, Jan 1 or later/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Couldn't confirm the change. Try again.")).toBeTruthy());
    expect(amountInput().value).toBe("150");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("recording a payment", () => {
  it("starts from one week's rent, and says where it goes", () => {
    view(behind);
    fireEvent.click(qa("record-payment")!);
    expect(amountInput().value).toBe("150");
    expect(screen.getByText("Payments go to the oldest unpaid period first.")).toBeTruthy();
  });

  it("🔴 'recorded' only after the server has it; a retry sends the SAME id", async () => {
    const onRent = vi.fn();
    recordRentPaymentAction
      .mockResolvedValueOnce({ ok: false, error: "network_error" })
      .mockResolvedValueOnce({ ok: true, rent: { ...behind, balanceCents: 15000 } });
    view(behind, onRent);
    fireEvent.click(qa("record-payment")!);
    fireEvent.click(qa("save-payment")!);
    await waitFor(() =>
      expect(
        screen.getByText("Couldn't confirm it was recorded. Try again - retrying here won't record it twice."),
      ).toBeTruthy(),
    );
    expect(onRent).not.toHaveBeenCalled();
    expect(amountInput().value).toBe("150");

    fireEvent.click(qa("save-payment")!);
    await waitFor(() => expect(onRent).toHaveBeenCalled());
    const [first, second] = recordRentPaymentAction.mock.calls.map((c) => c[1] as { clientRef: string });
    expect(first!.clientRef).toBe(second!.clientRef);
    expect(toast).toHaveBeenCalledWith("$150 recorded", "success");
  });
});

describe("history and voids", () => {
  const history = (voided: boolean): RentHistory => ({
    summary: behind,
    payments: [
      {
        id: "p1",
        amountCents: 15000,
        paidOn: "2026-09-21",
        method: "cash",
        note: null,
        voided,
        voidedOn: voided ? "2026-09-24" : null,
      },
    ],
    rates: [{ id: "r1", amountCents: 15000, period: "WEEKLY", startsOn: "2026-09-14", status: "active", voidedOn: null }],
  });

  it("🔴 lists every unpaid week; a void asks first, and the payment stays, marked", async () => {
    const onRent = vi.fn();
    rentHistoryAction.mockResolvedValueOnce(history(false)).mockResolvedValueOnce(history(true));
    voidRentPaymentAction.mockResolvedValue({ ok: true, rent: behind });
    view(behind, onRent);
    fireEvent.click(qa("rent-history")!);
    await waitFor(() => expect(document.querySelectorAll('[data-qa="rent-unpaid"]')).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "Void the $150 payment from Mon, Sep 21" }));
    expect(voidRentPaymentAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Void it" }));
    await waitFor(() => expect(screen.getByText("Voided Sep 24")).toBeTruthy());
    expect(voidRentPaymentAction).toHaveBeenCalledWith("tl1", "p1");
    expect(onRent).toHaveBeenCalledWith(behind);
    expect(toast).toHaveBeenCalledWith("Payment voided", "success");
  });

  it("🔴 a failed void changes nothing on screen", async () => {
    rentHistoryAction.mockResolvedValue(history(false));
    voidRentPaymentAction.mockResolvedValue({ ok: false, error: "network_error" });
    view(behind);
    fireEvent.click(qa("rent-history")!);
    await waitFor(() => screen.getByRole("button", { name: "Void the $150 payment from Mon, Sep 21" }));
    fireEvent.click(screen.getByRole("button", { name: "Void the $150 payment from Mon, Sep 21" }));
    fireEvent.click(screen.getByRole("button", { name: "Void it" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't void it - try again", "error"));
    expect(screen.queryByText(/^Voided/)).toBeNull();
    expect(screen.getByRole("button", { name: "Void it" })).toBeTruthy();
  });
});

describe("the rules a correction can't break", () => {
  it("🔴 a stop is never offered for voiding; a replaced or voided entry says so, with when", async () => {
    rentHistoryAction.mockResolvedValue({
      summary: { ...behind, rate: null, current: null, earliestStart: "2026-10-01" },
      payments: [],
      rates: [
        { id: "a", amountCents: 15000, period: "WEEKLY", startsOn: "2026-09-10", status: "active", voidedOn: null },
        { id: "b", amountCents: 1500, period: "WEEKLY", startsOn: "2026-09-17", status: "voided", voidedOn: "2026-09-18" },
        { id: "c", amountCents: 20000, period: "WEEKLY", startsOn: "2026-10-01", status: "replaced", voidedOn: null },
        { id: "d", amountCents: null, period: null, startsOn: "2026-10-01", status: "active", voidedOn: null },
      ],
    } satisfies RentHistory);
    view({ ...behind, rate: null, current: null, earliestStart: "2026-10-01" });
    fireEvent.click(qa("rent-history")!);
    await waitFor(() => expect(document.querySelectorAll('[data-qa="rent-rate"]')).toHaveLength(4));
    expect(screen.queryByRole("button", { name: /^Void the rent entry/ })).toBeNull();
    expect(screen.getByText("Voided Sep 18")).toBeTruthy();
    expect(screen.getByText("Replaced")).toBeTruthy();
  });

  it("🔴 a start before the earliest allowed day is refused before it reaches the server", () => {
    view({ ...none, balanceCents: 5000, earliestStart: "2026-10-01" });
    fireEvent.click(qa("set-rent")!);
    fireEvent.change(amountInput(), { target: { value: "150" } });
    fireEvent.change(qa("rent-starts-on")!, { target: { value: "2026-09-24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/Pick Thu, Oct 1 or later/)).toBeTruthy();
    expect(setRentAction).not.toHaveBeenCalled();
  });
});

describe("a member who left (owner's side)", () => {
  it("🔴 can be settled - a late payment, History with Void - but rent can't be set or changed", async () => {
    rentHistoryAction.mockResolvedValue({
      summary: { ...behind, rate: null, current: null },
      payments: [{ id: "p1", amountCents: 15000, paidOn: "2026-09-21", method: "cash", note: null, voided: false, voidedOn: null }],
      rates: [
        { id: "r1", amountCents: 15000, period: "WEEKLY", startsOn: "2026-09-14", status: "active", voidedOn: null },
        { id: "r2", amountCents: null, period: null, startsOn: "2026-10-01", status: "active", voidedOn: null },
      ],
    } satisfies RentHistory);
    const departed = { ...behind, rate: null, current: null };
    render(<OwnerRent linkId="tl1" businessName="Joe's Shop" rent={departed} onRent={vi.fn()} ended />);
    expect(qa("set-rent")).toBeNull();
    expect(qa("record-payment")).toBeTruthy();
    fireEvent.click(qa("rent-history")!);
    await waitFor(() => expect(document.querySelectorAll('[data-qa="rent-payment"]')).toHaveLength(1));
    // A payment can be voided; the stop that ended the rent can't.
    expect(screen.getByRole("button", { name: "Void the $150 payment from Mon, Sep 21" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Void the rent entry/ })).toBeNull();
  });
});

describe("a past relationship", () => {
  it("🔴 is read-only: the lines and History, nothing to record, change or void", async () => {
    const { ReadOnlyRent } = await import("./BoothRent");
    rentHistoryAction.mockResolvedValue({
      summary: behind,
      payments: [{ id: "p1", amountCents: 15000, paidOn: "2026-09-21", method: "cash", note: null, voided: false, voidedOn: null }],
      rates: [{ id: "r1", amountCents: 15000, period: "WEEKLY", startsOn: "2026-09-14", status: "active", voidedOn: null }],
    } satisfies RentHistory);
    render(
      <ReadOnlyRent title="Booth rent · Joe's Shop" who="owner" rent={behind} loadHistory={() => rentHistoryAction("tl1")} />,
    );
    expect(qa("record-payment")).toBeNull();
    expect(qa("set-rent")).toBeNull();
    expect(qa("rent-total")!.textContent).toBe("Owes $300 in total · unpaid since Sep 14");
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(document.querySelectorAll('[data-qa="rent-payment"]')).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /^Void/ })).toBeNull();
  });
});
