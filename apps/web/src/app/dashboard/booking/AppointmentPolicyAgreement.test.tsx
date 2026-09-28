import { describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * The appointment sheet says what the customer agreed to when they booked -
 * the owner's checklist as it read THEN - and says nothing for a booking that
 * was never asked. Fixture appointments only; the detail load is mocked.
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
    clientName: "Sample Client",
    serviceName: "Standard visit",
    staffName: "Sam",
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
    serviceCheckoutEnabled: false,
    editable: true,
    readOnlyReason: null,
    externalManageUrl: null,
    ...over,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
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

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:40:00.000Z",
  clientName: "Sample Client",
  serviceName: "Standard visit",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 50,
  status: "upcoming",
};

async function open(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
}

describe("the agreement on the appointment sheet", () => {
  it("shows the lines the customer ticked, and when", async () => {
    await open(
      detailFor({
        policyAgreement: {
          acceptedAt: "2026-09-10T16:00:00.000Z",
          text: "Deposits are non-refundable.",
          checklist: ["I'll arrive 5 minutes early", "Late counts as a no-show"],
        },
      }),
    );
    expect(await screen.findByText(/Agreed to your policies when booking, Sep 10/)).toBeTruthy();
    expect(screen.getByText("I'll arrive 5 minutes early")).toBeTruthy();
    expect(screen.getByText("Late counts as a no-show")).toBeTruthy();
    expect(screen.getByText("Deposits are non-refundable.")).toBeTruthy();
    cleanup();
  });

  it("says nothing for a booking that was never asked", async () => {
    await open(detailFor({ policyAgreement: null }));
    await screen.findAllByText("Sample Client");
    expect(screen.queryByText(/Agreed to your policies/)).toBeNull();
    cleanup();
  });
});
