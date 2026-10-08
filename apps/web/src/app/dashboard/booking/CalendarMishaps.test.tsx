import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow, ServiceRow, StaffRow } from "./page";

/**
 * Calendar mishaps from the 2026-10-08 sweep. Each showed the barber a time
 * as open that was not, or hid one that was:
 *
 *  - a deactivated barber's empty chair made every booked hour offer "Add at";
 *  - one barber's block-off folded the hour for the whole shop;
 *  - an hour inside a long appointment kept its "+", which booked over it;
 *  - approving a request whose time was taken only said "Couldn't update".
 */

const approve = vi.hoisted(() => vi.fn());
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction: vi.fn(async () => ({ ok: false })),
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  createAppointmentAction: vi.fn(async () => ({ ok: true })),
  approveAppointmentAction: approve,
  declineAppointmentAction: vi.fn(async () => ({ ok: true })),
}));

const { BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";
const shopTime = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00-04:00`).toISOString();

const SAM: StaffRow = { id: "stf1", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const KAI: StaffRow = { id: "stf2", name: "Kai", bio: null, imageUrl: null, active: true, sortOrder: 1 };
const services = [{ id: "svc1", name: "Cut", durationMin: 30, price: 50, active: true }] as unknown as ServiceRow[];

function booking(name: string, from: string, to: string, over: Partial<AgendaRow> = {}): AgendaRow {
  return {
    id: `${name}-${from}`,
    source: "appointment",
    start: shopTime(from),
    end: shopTime(to),
    clientName: name,
    serviceName: "Cut",
    serviceId: "svc1",
    staffId: "stf1",
    serviceColor: null,
    price: 50,
    status: "upcoming",
    ...over,
  } as AgendaRow;
}
function block(from: string, to: string, staffId: string | null): AgendaRow {
  return {
    id: `block-${from}-${staffId}`,
    source: "block",
    start: shopTime(from),
    end: shopTime(to),
    clientName: "Lunch",
    serviceName: null,
    serviceColor: null,
    price: null,
    status: "blocked",
    staffId,
  } as unknown as AgendaRow;
}

const toast = vi.fn();
function renderDay(agenda: AgendaRow[], staff: StaffRow[] = [SAM]) {
  const initial: AgendaResponse = { agenda, source: "appointment", timezone: TZ, categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative
      staff={staff}
      services={services}
      toast={toast}
    />,
  );
}
const hourRow = (hour: number) => document.querySelector(`[data-hour="${hour}"]`) as HTMLElement | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(shopTime("09:00")));
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  toast.mockReset();
  approve.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("what the planner offers", () => {
  it("🔴 a deactivated barber's chair is no open chair: a full hour offers no 'Add at'", () => {
    renderDay([booking("A", "19:00", "19:30"), booking("B", "19:30", "20:00")], [
      SAM,
      { ...KAI, active: false },
    ]);
    expect(within(hourRow(19)!).queryByRole("button", { name: /Add at/ })).toBeNull();
  });

  it("🔴 one barber's block leaves the other chair's hour open", () => {
    renderDay([block("12:00", "15:00", "stf1")], [SAM, KAI]);
    const one = hourRow(13);
    expect(one).toBeTruthy();
    expect(within(one!).getByRole("button", { name: /Add appointment/ })).toBeTruthy();
  });

  it("a block with no barber (Acuity) still covers every chair", () => {
    renderDay([block("12:00", "15:00", null)], [SAM, KAI]);
    const one = hourRow(13)!;
    expect(within(one).getByText(/blocked until/)).toBeTruthy();
    expect(within(one).queryByRole("button", { name: /Add/ })).toBeNull();
  });

  it("🔴 an hour inside a long appointment says booked, with no '+'", () => {
    renderDay([booking("Long", "13:00", "15:30")]);
    const two = hourRow(14)!;
    expect(within(two).queryByRole("button")).toBeNull();
    expect(within(two).getByText("— booked —")).toBeTruthy();
    // The hour it ends in offers the minute it frees up.
    expect(within(hourRow(15)!).getByRole("button", { name: /Add at 3:30 PM/ })).toBeTruthy();
  });
});

describe("approving a request", () => {
  it("🔴 a taken time says so, not 'Couldn't update'", async () => {
    approve.mockResolvedValue({ ok: false, error: "slot_taken" });
    renderDay([booking("Req", "16:00", "16:30", { status: "pending" })]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0]).toMatch(/booked now\. Decline the request/);
  });
});
