import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow, ServiceRow, StaffRow } from "./page";

/**
 * ADD AN APPOINTMENT IN THE ROOM A BUSY HOUR HAS LEFT.
 *
 * A barber's screenshot, 2026-10-06: 5:40-6:20, then 6:20-6:30, with "Should
 * be able to add an appt right here" circled under them. The planner offered
 * a "+" only on an EMPTY hour, so an hour holding one short booking had no way
 * in even with half of it free. The room is found per chair (dayGaps.ts);
 * these pin what only the rendered planner can get wrong: the button is
 * there, says the time, sits in the right hour, and opens the form on that
 * exact minute.
 */

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
  // The form, once opened: no open times listed, so the tapped one is offered.
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  createAppointmentAction: vi.fn(async () => ({ ok: true })),
}));

const { BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";
/** Wednesday Sep 23 2026, EDT. */
const shopTime = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00-04:00`).toISOString();

const SAM: StaffRow = { id: "stf1", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [
  { id: "svc1", name: "Mens Service", durationMin: 30, price: 50, active: true },
] as unknown as ServiceRow[];

function booking(clientName: string, from: string, to: string, over: Partial<AgendaRow> = {}) {
  return {
    id: `${clientName}-${from}`,
    source: "appointment",
    start: shopTime(from),
    end: shopTime(to),
    clientName,
    serviceName: "Mens Service",
    serviceId: "svc1",
    staffId: "stf1",
    serviceColor: null,
    price: 50,
    status: "upcoming",
    ...over,
  } as AgendaRow;
}

function renderDay(agenda: AgendaRow[], isNative = true) {
  const initial: AgendaResponse = { agenda, source: "appointment", timezone: TZ, categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative={isNative}
      staff={[SAM]}
      services={services}
      toast={() => {}}
    />,
  );
}

const hourRow = (hour: number) => document.querySelector(`[data-hour="${hour}"]`) as HTMLElement;

const SCREENSHOT = [
  booking("Jordan Sellers", "17:30", "17:40"),
  booking("Adam Alsadi", "17:40", "18:20"),
  booking("Kristian Hall", "18:20", "18:30"),
  booking("James Vargas", "19:00", "19:30"),
  booking("Andrew Baldwin", "19:30", "20:00"),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(shopTime("12:00")));
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
});
afterEach(() => vi.useRealTimers());

describe("room inside a busy hour", () => {
  it("🔴 the screenshot: the 6 PM hour offers 'Add at 6:30 PM', right under its booking", () => {
    renderDay(SCREENSHOT);
    const six = hourRow(18);
    expect(within(six).getByText("Kristian Hall")).toBeTruthy();
    expect(within(six).getByRole("button", { name: /Add at 6:30 PM/ })).toBeTruthy();
  });

  it("a full hour offers nothing, and a busy hour with room at its top offers that", () => {
    renderDay(SCREENSHOT);
    // 7:00-7:30 and 7:30-8:00: full.
    expect(within(hourRow(19)).queryByRole("button", { name: /Add at/ })).toBeNull();
    // 5 PM: free until 5:30.
    expect(within(hourRow(17)).getByRole("button", { name: /Add at 5:00 PM/ })).toBeTruthy();
  });

  it("an empty hour keeps its own '+'", () => {
    renderDay(SCREENSHOT);
    const two = hourRow(14);
    expect(within(two).getByRole("button", { name: /Add appointment/ })).toBeTruthy();
    expect(within(two).queryByRole("button", { name: /Add at/ })).toBeNull();
  });

  it("a cancelled booking holds no time", () => {
    renderDay([
      booking("Gone", "16:00", "16:40", { status: "canceled" }),
      booking("Here", "16:40", "17:00"),
    ]);
    expect(within(hourRow(16)).getByRole("button", { name: /Add at 4:00 PM/ })).toBeTruthy();
  });

  it("🔴 tapping it opens New appointment on that exact minute", async () => {
    renderDay(SCREENSHOT);
    fireEvent.click(within(hourRow(18)).getByRole("button", { name: /Add at 6:30 PM/ }));
    const dialog = await screen.findByRole("dialog");
    const offer = await within(dialog).findByRole("button", { name: /Book this time/ });
    expect(offer.textContent).toContain("6:30 PM");
    expect(offer.textContent).toContain("The time you tapped");
  });

  it("a shop not booking on ChairBack gets no add buttons", () => {
    renderDay(SCREENSHOT, false);
    expect(screen.queryByRole("button", { name: /Add at/ })).toBeNull();
  });
});
