import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * "STILL DOESNT LET ME CHARGE CARD ON FILE FOR SOMEONE THAT MISSED APPT"
 * (Drick, 2026-10-19 - from the Checkout screen, which only asked "How did
 * they pay?").
 *
 * Checkout now carries "Didn't show up? Mark no-show" for a visit whose start
 * has passed and that is not paid, saying BEFORE the tap what it does to the
 * card - the server's figure, or the server's reason nothing is charged - and
 * opening the SAME confirm the More menu does (no second path to a charge):
 *   - a live booking -> Mark no-show's confirm;
 *   - a visit the sweep already completed -> the correction's confirm.
 * "Mark paid" is unchanged.
 */

const now = new Date().toISOString();
const base = {
  id: "appt1",
  source: "appointment",
  origin: "chairback",
  originLabel: "ChairBack",
  status: "upcoming",
  checkInStatus: null,
  clientId: null,
  clientName: "P Dot",
  serviceName: "Cut",
  staffName: "Sam",
  startsAt: now,
  endsAt: now,
  durationMin: 30,
  timezone: "UTC",
  price: 55,
  notes: null,
  addOns: [],
  intake: [],
  contact: { phone: null, phoneDisplay: null, email: null },
  sms: { state: "no_consent", consentAt: null },
  history: { previous: [], upcoming: [] },
  payment: {
    state: "unpaid",
    totalCents: 5500,
    collectedCents: 0,
    onlineCents: 0,
    inPersonCents: 0,
    refundedCents: 0,
    authorizedCents: 0,
    remainingCents: 5500,
    method: null,
    card: null,
    receiptUrl: null,
  },
  keptDeposit: null,
  tip: null,
  checkedOutAt: null,
  serviceCheckoutEnabled: false,
  editable: false,
  readOnlyReason: "not_editable",
  externalManageUrl: null,
  walkIn: false,
  correctable: false,
  noShowAllowed: true,
  undoNoShow: false,
  noShowFee: null,
  noShowCard: { charge: false, reason: "fees_off" },
} as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const noShow = vi.hoisted(() => vi.fn());
const correctVisit = vi.hoisted(() => vi.fn());
const checkout = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  correctCompletedVisitAction: correctVisit,
  removeWalkInAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  refundDepositAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: checkout,
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: noShow,
  undoNoShowAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row = (status: AgendaRow["status"]): AgendaRow => ({
  id: "appt1",
  source: "appointment",
  start: now,
  end: now,
  clientName: "P Dot",
  serviceName: "Cut",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 55,
  status,
});

async function openCheckout(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(
    <AppointmentSheet
      row={row(detail.status as AgendaRow["status"])}
      toast={vi.fn()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      initialView="pay"
    />,
  );
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
  await screen.findByText("How did they pay?");
}

beforeEach(() => {
  for (const f of [getDetail, noShow, correctVisit, checkout]) f.mockReset();
});

describe("Checkout: Didn't show up? Mark no-show", () => {
  it("🔴 a kept card and a fee: says the exact charge and card up front", async () => {
    await openCheckout({
      ...base,
      noShowFee: { cents: 2500, last4: "1234" },
      noShowCard: { charge: true, cents: 2500, last4: "1234" },
    } as AppointmentDetail);
    const box = screen.getByTestId("checkout-no-show");
    expect(box.textContent).toContain("Didn’t show up? Mark no-show");
    expect(screen.getByTestId("checkout-no-show-card").textContent).toBe(
      "Charges $25 to the card ending 1234.",
    );
    expect(screen.queryByTestId("no-show-fee-settings")).toBeNull();
  });

  it("fees off: says so, and links to where they are turned on and set", async () => {
    await openCheckout(base);
    expect(screen.getByTestId("checkout-no-show-card").textContent).toMatch(
      /^Nothing is charged: no-show fees are off/,
    );
    const link = screen.getByTestId("no-show-fee-settings");
    expect(link.getAttribute("href")).toBe("/dashboard/payments#no-show-fees");
  });

  it.each([
    ["booked_before_fees", /booked before you turned on no-show fees, so its terms don't allow a charge/],
    ["no_card", /no card was saved on this booking/],
    ["deposit_kept", /What they paid when booking stays with you/],
    ["no_price", /this booking has no price/],
  ])("%s: names the reason", async (reason, said) => {
    await openCheckout({ ...base, noShowCard: { charge: false, reason } } as unknown as AppointmentDetail);
    expect(screen.getByTestId("checkout-no-show-card").textContent).toMatch(said);
    expect(screen.queryByTestId("no-show-fee-settings")).toBeNull();
  });

  it("tapping it opens Mark no-show's own confirm - nothing is sent until confirmed", async () => {
    await openCheckout({
      ...base,
      noShowFee: { cents: 2500, last4: "1234" },
      noShowCard: { charge: true, cents: 2500, last4: "1234" },
    } as AppointmentDetail);
    fireEvent.click(screen.getByTestId("checkout-no-show").querySelector("button")!);
    const confirm = await screen.findByTestId("no-show-confirm");
    expect(confirm.textContent).toContain("Mark this a no-show?");
    expect(confirm.textContent).toContain("The card ending 1234 kept for this booking is charged the $25 no-show fee now.");
    expect(noShow).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
  });

  it("the confirm with nothing to charge says the server's reason", async () => {
    await openCheckout({ ...base, noShowCard: { charge: false, reason: "no_card" } } as unknown as AppointmentDetail);
    fireEvent.click(screen.getByTestId("checkout-no-show").querySelector("button")!);
    const confirm = await screen.findByTestId("no-show-confirm");
    expect(confirm.textContent).toContain("Nothing is charged: no card was saved on this booking. You can undo it");
  });

  it("🔴 a visit the sweep already completed: opens the correction, and says the card was let go", async () => {
    await openCheckout({
      ...base,
      status: "completed",
      noShowAllowed: false,
      correctable: true,
      noShowCard: { charge: false, reason: "visit_closed" },
    } as unknown as AppointmentDetail);
    expect(screen.getByTestId("checkout-no-show-card").textContent).toMatch(/closed this visit as done/);
    fireEvent.click(screen.getByTestId("checkout-no-show").querySelector("button")!);
    const confirm = await screen.findByTestId("correct-visit-confirm");
    expect(confirm.textContent).toContain("Mark this visit a no-show?");
    expect(screen.getByTestId("correct-visit-card").textContent).toMatch(/let the saved card go/);
    expect(correctVisit).not.toHaveBeenCalled();
    expect(noShow).not.toHaveBeenCalled();
  });

  it("not offered when the server offers no no-show (before the start, paid, or an older API)", async () => {
    for (const d of [
      { ...base, noShowAllowed: false, noShowCard: null },
      { ...base, checkedOutAt: now },
      { ...base, noShowCard: undefined },
    ]) {
      await openCheckout(d as unknown as AppointmentDetail);
      expect(screen.queryByTestId("checkout-no-show")).toBeNull();
      cleanup();
    }
  });

  it("Mark paid is unchanged beside it", async () => {
    await openCheckout(base);
    fireEvent.click(screen.getByText("Cash"));
    expect(screen.getByText("Mark paid · $55.00")).toBeTruthy();
  });
});
