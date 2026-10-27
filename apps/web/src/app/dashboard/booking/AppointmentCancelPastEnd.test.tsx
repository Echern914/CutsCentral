import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import { CANCEL_PAST_END_COPY } from "@chairback/config/shopPolicy";
import type { AgendaResponse, AgendaRow, ServiceRow, StaffRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * 🔴 CANCEL ON A BOOKING THAT ALREADY ENDED ASKS FIRST.
 *
 * The completion sweep now leaves a booking BOOKED for a day after its end so
 * a no-show can still be marked (NO_SHOW_WINDOW_MS) - which leaves Cancel
 * right beside No-show on a visit that is over. A barber cancel refunds any
 * deposit and emails the client; a no-show does neither. So past the end,
 * Cancel - in the sheet's More menu and on the calendar card - asks in place
 * (never a toast): Mark no-show, or Cancel anyway. Before the end, Cancel is
 * one tap as it always was. The server is unchanged: it still allows both.
 */

// A fixed PAST instant; every booking is placed relative to it.
const NOW = new Date("2026-09-23T16:00:00.000Z");
const iso = (minsFromNow: number) => new Date(NOW.getTime() + minsFromNow * 60_000).toISOString();

const getDetail = vi.hoisted(() => vi.fn());
const noShow = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const cancelSeries = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  correctCompletedVisitAction: vi.fn(),
  removeWalkInAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  refundDepositAction: vi.fn(),
  cancelAppointmentAction: cancel,
  cancelSeriesAction: cancelSeries,
  checkoutAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: noShow,
  undoNoShowAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction: vi.fn(async () => ({ ok: false })),
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  createAppointmentAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");
const { BookingCalendar } = await import("./BookingCalendar");

function detailEnding(startMins: number, endMins: number): AppointmentDetail {
  return {
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "upcoming",
    checkInStatus: null,
    clientId: null,
    clientName: "Sample Client",
    serviceName: "Cut",
    staffName: "Sam",
    startsAt: iso(startMins),
    endsAt: iso(endMins),
    durationMin: endMins - startMins,
    timezone: "UTC",
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
    keptDeposit: null,
    tip: null,
    checkedOutAt: null,
    serviceCheckoutEnabled: false,
    editable: false,
    readOnlyReason: "not_editable",
    externalManageUrl: null,
    walkIn: false,
    correctable: false,
    noShowAllowed: startMins <= 0,
    undoNoShow: false,
    noShowFee: null,
  } as unknown as AppointmentDetail;
}

function agendaRow(startMins: number, endMins: number, over: Partial<AgendaRow> = {}): AgendaRow {
  return {
    id: "appt1",
    source: "appointment",
    start: iso(startMins),
    end: iso(endMins),
    clientName: "Sample Client",
    serviceName: "Cut",
    serviceId: "svc1",
    staffId: "stf1",
    notes: null,
    serviceColor: null,
    price: 40,
    status: "upcoming",
    ...over,
  } as AgendaRow;
}

const toast = vi.fn();
const onClose = vi.fn();
const onChanged = vi.fn();

async function openSheetCancel(startMins: number, endMins: number) {
  getDetail.mockResolvedValue({ ok: true, data: detailEnding(startMins, endMins) });
  render(
    <AppointmentSheet row={agendaRow(startMins, endMins)} toast={toast} onClose={onClose} onChanged={onChanged} />,
  );
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByText("Cancel appointment"));
}

const SAM: StaffRow = { id: "stf1", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "svc1", name: "Cut", durationMin: 30, price: 40, active: true }] as unknown as ServiceRow[];

async function cardCancel(startMins: number, endMins: number, over: Partial<AgendaRow> = {}) {
  const initial: AgendaResponse = {
    agenda: [agendaRow(startMins, endMins, over)],
    source: "appointment",
    timezone: "UTC",
    categories: [],
  };
  render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative
      staff={[SAM]}
      services={services}
      toast={toast}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Expand appointment for Sample Client" }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  for (const f of [getDetail, noShow, cancel, cancelSeries, toast, onClose, onChanged]) f.mockReset();
  cancel.mockResolvedValue({ ok: true });
  cancelSeries.mockResolvedValue({ ok: true });
  noShow.mockResolvedValue({ ok: true, card: null });
});
afterEach(() => vi.useRealTimers());

describe("the sheet's Cancel appointment", () => {
  it("🔴 past the end: asks in the footer first, and cancels nothing yet", async () => {
    await openSheetCancel(-90, -60);
    const box = await screen.findByTestId("cancel-past-confirm");
    expect(box.textContent).toContain(CANCEL_PAST_END_COPY);
    expect(cancel).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("🔴 Mark no-show runs the no-show, not the cancel", async () => {
    await openSheetCancel(-90, -60);
    const box = await screen.findByTestId("cancel-past-confirm");
    fireEvent.click(within(box).getByRole("button", { name: "Mark no-show" }));
    await waitFor(() => expect(noShow).toHaveBeenCalledWith("appt1"));
    expect(noShow).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("Cancel anyway cancels it", async () => {
    await openSheetCancel(-90, -60);
    const box = await screen.findByTestId("cancel-past-confirm");
    fireEvent.click(within(box).getByRole("button", { name: "Cancel anyway" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(noShow).not.toHaveBeenCalled();
  });

  it("in the chair right now (started, not ended): cancels at once, no extra step", async () => {
    await openSheetCancel(-10, 20);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(screen.queryByTestId("cancel-past-confirm")).toBeNull();
  });

  it("still ahead: cancels at once, no extra step", async () => {
    await openSheetCancel(120, 150);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(screen.queryByTestId("cancel-past-confirm")).toBeNull();
  });
});

describe("the calendar card's Cancel", () => {
  it("🔴 past the end: asks on the card; Mark no-show runs the no-show", async () => {
    await cardCancel(-90, -60);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const box = await screen.findByTestId("card-cancel-past-confirm");
    expect(box.textContent).toContain(CANCEL_PAST_END_COPY);
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole("button", { name: "Mark no-show" }));
    await waitFor(() => expect(noShow).toHaveBeenCalledWith("appt1"));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("card-cancel-past-confirm")).toBeNull();
  });

  it("past the end: Cancel anyway cancels it - once, for a double tap", async () => {
    await cardCancel(-90, -60);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const box = await screen.findByTestId("card-cancel-past-confirm");
    const anyway = within(box).getByRole("button", { name: "Cancel anyway" });
    fireEvent.click(anyway);
    fireEvent.click(anyway);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(noShow).not.toHaveBeenCalled();
  });

  it("a repeat's 'Just this one' past the end asks too", async () => {
    await cardCancel(-90, -60, { seriesId: "ser1" } as Partial<AgendaRow>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel ▾" }));
    fireEvent.click(screen.getByRole("button", { name: "Just this one" }));
    const box = await screen.findByTestId("card-cancel-past-confirm");
    fireEvent.click(within(box).getByRole("button", { name: "Cancel anyway" }));
    await waitFor(() => expect(cancelSeries).toHaveBeenCalledWith("ser1", "this", "appt1"));
  });

  it("in the chair right now: cancels at once, no extra step", async () => {
    await cardCancel(-10, 20);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(screen.queryByTestId("card-cancel-past-confirm")).toBeNull();
  });
});
