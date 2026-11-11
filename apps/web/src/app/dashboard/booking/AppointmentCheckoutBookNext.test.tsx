import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * "BOOK THEIR NEXT VISIT", FROM A PAID CHECKOUT.
 *
 * The checkout can only offer the next booking where the calendar's booking
 * form is mounted to answer it - the same rule as the sheet's own "Book
 * again". So the sheet hands checkout that action when it has one, and nothing
 * when it does not: a button that does nothing is worse than no button.
 */

const detail = {
  id: "appt1",
  source: "appointment",
  origin: "chairback",
  originLabel: "ChairBack",
  status: "upcoming",
  checkInStatus: null,
  clientId: "cl1",
  clientName: "Sample Client",
  serviceName: "Standard visit",
  staffName: "Sam",
  startsAt: "2026-11-18T14:00:00.000Z",
  endsAt: "2026-11-18T14:40:00.000Z",
  durationMin: 40,
  timezone: "America/New_York",
  price: 40,
  notes: null,
  addOns: [],
  intake: [],
  contact: { phone: null, phoneDisplay: null, email: null },
  sms: { state: "no_consent", consentAt: null },
  history: { previous: [], upcoming: [] },
  payment: {
    state: "unpaid",
    totalCents: 4000,
    collectedCents: 0,
    onlineCents: 0,
    inPersonCents: 0,
    refundedCents: 0,
    authorizedCents: 0,
    remainingCents: 4000,
    method: null,
    card: null,
    receiptUrl: null,
    cardOnFile: null,
  },
  keptDeposit: null,
  tip: null,
  checkedOutAt: null,
  serviceCheckoutEnabled: true,
  editable: true,
  readOnlyReason: null,
  externalManageUrl: null,
} as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  refundDepositAction: vi.fn(),
  refundTipAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
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

const requestRebook = vi.hoisted(() => vi.fn());
vi.mock("./rebookEvent", () => ({ requestRebook }));

// The checkout itself is covered in CheckoutScreens.test.tsx; here it only
// has to show what the sheet handed it.
const handed = vi.hoisted(() => ({ onBookNext: undefined as (() => void) | undefined, mounted: false }));
vi.mock("./CheckoutFlow", async (original) => ({
  ...(await original<typeof import("./CheckoutFlow")>()),
  CheckoutFlow: (props: { onBookNext?: () => void }) => {
    handed.onBookNext = props.onBookNext;
    handed.mounted = true;
    return null;
  },
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-11-18T14:00:00.000Z",
  end: "2026-11-18T14:40:00.000Z",
  clientName: "Sample Client",
  serviceName: "Standard visit",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
};

async function openCheckout(props: { canBookAgain?: boolean; onClose?: () => void }) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(
    <AppointmentSheet
      row={row}
      toast={vi.fn()}
      onClose={props.onClose ?? vi.fn()}
      onChanged={vi.fn()}
      canBookAgain={props.canBookAgain}
    />,
  );
  await waitFor(() => expect(document.querySelector('[data-qa="start-checkout"]')).not.toBeNull());
  await act(async () => {
    fireEvent.click(document.querySelector('[data-qa="start-checkout"]')!);
  });
  await waitFor(() => expect(handed.mounted).toBe(true));
}

beforeEach(() => {
  cleanup();
  getDetail.mockReset();
  requestRebook.mockReset();
  handed.onBookNext = undefined;
  handed.mounted = false;
});

describe("booking the next visit from checkout", () => {
  it("🔴 where the calendar can answer it, checkout is handed the same Book again the sheet uses", async () => {
    const onClose = vi.fn();
    await openCheckout({ canBookAgain: true, onClose });
    expect(handed.onBookNext).toBeTypeOf("function");
    handed.onBookNext!();
    // Who and what carry over; never the time, the price or the payment.
    expect(requestRebook).toHaveBeenCalledTimes(1);
    expect(requestRebook).toHaveBeenCalledWith({
      clientId: "cl1",
      clientLabel: "Sample Client",
      serviceId: "svc1",
      serviceName: "Standard visit",
      staffId: "stf1",
      staffName: "Sam",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("🔴 where it cannot, checkout is handed nothing - so it shows no such button", async () => {
    await openCheckout({ canBookAgain: false });
    expect(handed.onBookNext).toBeUndefined();
  });
});
