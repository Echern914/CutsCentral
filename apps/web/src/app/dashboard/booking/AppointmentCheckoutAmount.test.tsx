import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * CHECKOUT RECORDS THE AMOUNT IT SHOWS.
 *
 * A barber opened checkout on a $50 cut and saw $50.00 in the amount field,
 * "Enter an amount" under it, and a disabled "Mark paid · $—". The field shows
 * the balance due until it is edited, but the check read the untouched field
 * as blank, so the only way through was to retype the number already there.
 *
 * Fixture appointments only: every save here goes to a mocked action.
 */

const detailFor = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "upcoming",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Marcus Reed",
    serviceName: "Fade",
    staffName: "Dee",
    startsAt: "2026-09-18T14:00:00.000Z",
    endsAt: "2026-09-18T14:40:00.000Z",
    durationMin: 40,
    timezone: "America/New_York",
    price: 50,
    notes: null,
    addOns: [],
    intake: [],
    contact: { phone: null, phoneDisplay: null, email: null },
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: {
      state: "unpaid",
      totalCents: 5000,
      collectedCents: 0,
      onlineCents: 0,
      inPersonCents: 0,
      refundedCents: 0,
      authorizedCents: 0,
      remainingCents: 5000,
      method: null,
      card: null,
      receiptUrl: null,
    },
    checkedOutAt: null,
    // The ORIGINAL chair checkout - the screen the barber was on.
    serviceCheckoutEnabled: false,
    editable: true,
    readOnlyReason: null,
    externalManageUrl: null,
    ...over,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const checkout = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: checkout,
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const baseRow: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:40:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 50,
  status: "upcoming",
};

const toast = vi.fn();
const onClose = vi.fn();
const onChanged = vi.fn();

async function openCheckout(detail = detailFor(), row: AgendaRow = baseRow) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  const view = render(
    <AppointmentSheet
      row={row}
      toast={toast}
      onClose={onClose}
      onChanged={onChanged}
      initialView="pay"
    />,
  );
  // The detail load settles the balance the field shows.
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

const field = () => screen.getByLabelText("Amount collected") as HTMLInputElement;
const markPaid = () => screen.getByRole("button", { name: /^Mark paid/ });
/** The footer's main button whatever it says right now (Mark paid, or Saving…). */
const mainButton = () => screen.getByRole("button", { name: /^(Mark paid|Saving)/ }) as HTMLButtonElement;
const pick = (method: RegExp) => fireEvent.click(screen.getByRole("button", { name: method }));
const type = (value: string) => fireEvent.change(field(), { target: { value } });

beforeEach(() => {
  getDetail.mockReset();
  checkout.mockReset();
  checkout.mockResolvedValue({ ok: true });
  toast.mockClear();
  onClose.mockClear();
  onChanged.mockClear();
});

describe("the amount the field shows is the amount it saves", () => {
  it("🔴 an untouched $50.00 is a valid amount - no 'Enter an amount', Mark paid ready", async () => {
    await openCheckout();
    expect(field().value).toBe("50.00");
    expect(screen.queryByText("Enter an amount.")).toBeNull();

    pick(/^Cash/);
    expect(markPaid().textContent).toBe("Mark paid · $50.00");
    expect((markPaid() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(markPaid());
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith("appt1", { amount: 50, method: "cash" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
  });

  it("the card on the barber's own reader records the same amount, as 'card'", async () => {
    await openCheckout();
    pick(/^Card/);
    fireEvent.click(markPaid());
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith("appt1", { amount: 50, method: "card" }),
    );
  });

  it("what is left after an online deposit is what it shows and saves", async () => {
    await openCheckout(
      detailFor({
        payment: {
          ...detailFor().payment,
          state: "deposit",
          onlineCents: 3000,
          collectedCents: 3000,
          remainingCents: 2000,
        },
      }),
    );
    expect(field().value).toBe("20.00");
    pick(/^Cash/);
    expect(markPaid().textContent).toBe("Mark paid · $20.00");
    fireEvent.click(markPaid());
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith("appt1", { amount: 20, method: "cash" }),
    );
  });

  it("an unpriced service starts blank - never a $0.00 one tap would record", async () => {
    await openCheckout(
      detailFor({
        price: null,
        payment: { ...detailFor().payment, totalCents: null, remainingCents: null },
      }),
      { ...baseRow, price: null },
    );
    expect(field().value).toBe("");
    expect(screen.getByText("Enter an amount.")).toBeTruthy();
    pick(/^Cash/);
    expect(markPaid().textContent).toBe("Mark paid · $—");
    expect((markPaid() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("what the barber types", () => {
  it("blank is not an amount: the button stays off and nothing is sent", async () => {
    await openCheckout();
    pick(/^Cash/);
    type("");
    expect(screen.getByText("Enter an amount.")).toBeTruthy();
    expect(markPaid().textContent).toBe("Mark paid · $—");
    expect((markPaid() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(markPaid());
    expect(checkout).not.toHaveBeenCalled();
  });

  it("zero is a real amount (a comp) and is recorded as $0.00", async () => {
    await openCheckout();
    pick(/^Other/);
    type("0");
    expect(markPaid().textContent).toBe("Mark paid · $0.00");
    fireEvent.click(markPaid());
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith("appt1", { amount: 0, method: "other" }),
    );
  });

  it.each([
    ["45.5", "45.50", 45.5],
    ["45.", "45.00", 45],
    [".5", "0.50", 0.5],
    ["$60", "60.00", 60],
    [" 70 ", "70.00", 70],
    ["45.999", "46.00", 46],
  ])("%j is saved as $%s", async (input, shown, saved) => {
    await openCheckout();
    pick(/^Cash/);
    type(input);
    expect(screen.queryByText("Enter an amount.")).toBeNull();
    expect(markPaid().textContent).toBe(`Mark paid · $${shown}`);
    fireEvent.click(markPaid());
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith("appt1", { amount: saved, method: "cash" }),
    );
  });

  it.each(["abc", "-5", "100001", "5.0.0"])("%j is not an amount", async (input) => {
    await openCheckout();
    pick(/^Cash/);
    type(input);
    expect(screen.getByText("Enter an amount.")).toBeTruthy();
    expect((markPaid() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("🔴 a save that fails marks nothing paid - and SAYS SO in the footer", () => {
  // A toast draws beneath the dialog, so on a phone it is invisible while the
  // sheet is open. Drick (2026-09-29): "Pay button still did not work" - the
  // refusal was there, and nobody could read it.
  const footerError = () => screen.queryByTestId("checkout-error");

  it("a refused save keeps the screen, says why in the footer, and Mark paid tries again", async () => {
    checkout.mockResolvedValueOnce({ ok: false, error: "failed" });
    await openCheckout();
    pick(/^Cash/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(footerError()).not.toBeNull());
    expect(footerError()!.textContent).toBe(
      "Couldn't save the checkout (failed). Nothing was recorded. Try again.",
    );
    expect(footerError()!.getAttribute("role")).toBe("alert");
    // Never a toast: it would be hidden under this dialog.
    expect(toast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    // Same amount, same method, one more tap - and the message clears.
    await waitFor(() => expect((markPaid() as HTMLButtonElement).disabled).toBe(false));
    expect(markPaid().textContent).toBe("Mark paid · $50.00");
    fireEvent.click(markPaid());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(checkout).toHaveBeenCalledTimes(2);
  });

  it("no answer at all (no signal) says so, keeps the screen, and retries", async () => {
    checkout.mockRejectedValueOnce(new Error("network"));
    await openCheckout();
    pick(/^Cash/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(footerError()).not.toBeNull());
    expect(footerError()!.textContent).toBe(
      "Couldn't reach ChairBack. Check your signal and try again. Nothing was recorded.",
    );
    expect(toast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    await waitFor(() => expect((markPaid() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(markPaid());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it.each([
    ["network_error", /Couldn't reach ChairBack/],
    ["collection_in_progress", /card payment is still being confirmed/],
    ["not_found", /may have been canceled/],
    ["invalid_input", /amount or payment type wasn't accepted/],
    ["http_500", /\(http_500\)/],
  ])("the reason %s reads plainly", async (code, wording) => {
    checkout.mockResolvedValueOnce({ ok: false, error: code });
    await openCheckout();
    pick(/^Other/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(footerError()).not.toBeNull());
    expect(footerError()!.textContent).toMatch(wording);
    expect(footerError()!.textContent).toContain("Nothing was recorded");
  });

  it("the message goes away when the barber changes the payment type or the amount", async () => {
    checkout.mockResolvedValue({ ok: false, error: "failed" });
    await openCheckout();
    pick(/^Cash/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(footerError()).not.toBeNull());
    pick(/^Other/);
    expect(footerError()).toBeNull();

    fireEvent.click(markPaid());
    await waitFor(() => expect(footerError()).not.toBeNull());
    type("45");
    expect(footerError()).toBeNull();
  });

  it("trying again clears the old message while it saves - no stale error beside 'Saving…'", async () => {
    checkout.mockResolvedValueOnce({ ok: false, error: "failed" });
    let finish!: (v: { ok: boolean }) => void;
    checkout.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await openCheckout();
    pick(/^Cash/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(footerError()).not.toBeNull());
    await waitFor(() => expect((markPaid() as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(markPaid());
    await waitFor(() => expect(mainButton().textContent).toBe("Saving…"));
    expect(footerError()).toBeNull();
    // 🔴 While the answer is awaited the button is dead, so an impatient second
    // tap cannot send a second payment (this pair is the failed try + this one).
    expect(mainButton().disabled).toBe(true);
    fireEvent.click(mainButton());
    fireEvent.click(mainButton());
    expect(checkout).toHaveBeenCalledTimes(2);
    await act(async () => finish({ ok: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("🔴 a slow save reads 'Saving…' the whole time, not 'Mark paid' - it must not look dead", async () => {
    let finish!: (v: { ok: boolean }) => void;
    checkout.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await openCheckout();
    pick(/^Cash/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(mainButton().textContent).toBe("Saving…"));
    // Still waiting a moment later: still saying so.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(mainButton().textContent).toBe("Saving…");
    expect(mainButton().disabled).toBe(true);
    await act(async () => finish({ ok: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it("going Back clears it too", async () => {
    checkout.mockResolvedValueOnce({ ok: false, error: "failed" });
    await openCheckout();
    pick(/^Cash/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(footerError()).not.toBeNull());
    const footerBack = screen
      .getAllByRole("button", { name: "Back" })
      .find((b) => b.getAttribute("data-qa") !== "sheet-back")!;
    fireEvent.click(footerBack);
    fireEvent.click(screen.getByRole("button", { name: "Next", exact: true }));
    expect(footerError()).toBeNull();
  });

  it("already checked out (e.g. the lost answer did land) refreshes instead of retrying", async () => {
    checkout.mockResolvedValueOnce({ ok: false, error: "paid_already" });
    await openCheckout();
    pick(/^Cash/);
    fireEvent.click(markPaid());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(checkout).toHaveBeenCalledTimes(1);
  });
});

describe("back, close and come back", () => {
  it("Back to the charges and Next again keeps what was typed", async () => {
    await openCheckout();
    type("65");
    // The footer's Back (the header arrow is the other button named Back).
    const footerBack = screen
      .getAllByRole("button", { name: "Back" })
      .find((b) => b.getAttribute("data-qa") !== "sheet-back")!;
    fireEvent.click(footerBack);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(field().value).toBe("65");
    // ...and the header's back arrow, which also steps back to the charges.
    fireEvent.click(document.querySelector("[data-qa='sheet-back']") as HTMLElement);
    expect(screen.queryByLabelText("Amount collected")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(field().value).toBe("65");
  });

  it("closing and reopening starts again from the balance due", async () => {
    const first = await openCheckout();
    type("65");
    first.unmount();
    await openCheckout();
    expect(field().value).toBe("50.00");
    expect(screen.queryByText("Enter an amount.")).toBeNull();
  });
});
