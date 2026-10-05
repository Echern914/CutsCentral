import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * A REPEATING BOOKING SAYS IT REPEATS - NOT "WEEKLY". A series can be every 1
 * to 8 weeks, and a shop booking a client every 3 weeks read "Weekly" as the
 * wrong option. The New appointment chip ("Repeat appointment") is pinned by
 * the form tests that press it; this pins the tag on the booking itself.
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
  startsAt: "2026-09-18T14:00:00.000Z",
  endsAt: "2026-09-18T14:40:00.000Z",
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
  },
  checkedOutAt: null,
  serviceCheckoutEnabled: false,
  editable: true,
  readOnlyReason: null,
  externalManageUrl: null,
} as unknown as AppointmentDetail;

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

const row = (over: Partial<AgendaRow> = {}): AgendaRow =>
  ({
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
    price: 40,
    status: "upcoming",
    ...over,
  }) as AgendaRow;

async function open(r: AgendaRow) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={r} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
}

describe("a repeating booking's tag", () => {
  it("says Repeats, never Weekly, whatever the interval", async () => {
    await open(row({ seriesId: "series1" } as Partial<AgendaRow>));
    expect(await screen.findByText("↻ Repeats")).toBeTruthy();
    expect(screen.queryByText(/Weekly/)).toBeNull();
  });

  it("a one-off booking carries no tag", async () => {
    await open(row());
    await screen.findAllByText("Sample Client");
    expect(screen.queryByText("↻ Repeats")).toBeNull();
  });
});
