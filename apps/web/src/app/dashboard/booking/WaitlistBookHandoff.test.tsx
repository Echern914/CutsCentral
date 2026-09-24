import { describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse } from "./page";

/**
 * "BOOK APPOINTMENT" FROM THE WAITLIST TAB (Drick, 2026-09-24: "Booking
 * waitlisted clients button doesn't work").
 *
 * The board hands off with a window event; the calendar listens. But the
 * booking page's tabs are exclusive, so on the Waitlist tab the calendar was
 * not mounted and the event landed nowhere - the button did nothing at all.
 * Two halves pin the fix: the page catches the event while the calendar is off
 * screen and asks to go there, and the calendar opens the form for an entry
 * handed to it as it mounts.
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
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [], specials: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  createAppointmentAction: vi.fn(async () => ({ ok: true })),
}));

const { WAITLIST_BOOK_EVENT } = await import("./WaitlistBoard");
const { useWaitlistBookHandoff } = await import("./useWaitlistBookHandoff");
const { BookingCalendar } = await import("./BookingCalendar");

const ricky = {
  entryId: "wl_ricky",
  firstName: "Ricky",
  lastName: null,
  phone: "+12018996965",
  email: null,
  serviceId: null,
  staffId: null,
  windowHint: "Sep 24–Oct 8 · any time",
};

const tap = () =>
  act(() => {
    window.dispatchEvent(new CustomEvent(WAITLIST_BOOK_EVENT, { detail: ricky }));
  });

describe("the page catches the tap when the calendar is not on screen", () => {
  it("🔴 on the Waitlist tab: remembers the entry and goes to the calendar", () => {
    const go = vi.fn();
    const { result } = renderHook(() => useWaitlistBookHandoff(false, go));
    tap();
    expect(go).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toEqual(ricky);
  });

  it("on the calendar itself: stays out of the way (the calendar handles it)", () => {
    const go = vi.fn();
    const { result } = renderHook(() => useWaitlistBookHandoff(true, go));
    tap();
    expect(go).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it("once the calendar takes it, it is forgotten - a later visit never re-opens it", () => {
    const { result } = renderHook(() => useWaitlistBookHandoff(false, () => {}));
    tap();
    expect(result.current.pending).toEqual(ricky);
    act(() => result.current.taken());
    expect(result.current.pending).toBeNull();
  });
});

describe("the calendar opens the form for an entry handed to it on mount", () => {
  it("🔴 shows New appointment, prefilled from the waitlist, and says it took it", async () => {
    const taken = vi.fn();
    const initial: AgendaResponse = {
      agenda: [],
      source: "appointment",
      timezone: "America/New_York",
      categories: [],
    };
    render(
      <BookingCalendar
        initial={initial}
        initialWaitlist={[]}
        onOpenWaitlist={() => {}}
        isNative
        staff={[{ id: "stf1", name: "Drick", active: true } as never]}
        services={[{ id: "svc1", name: "Mens Haircut", durationMin: 30, price: 50, active: true } as never]}
        toast={() => {}}
        pendingWaitlistBooking={ricky}
        onPendingWaitlistBookingTaken={taken}
      />,
    );
    await waitFor(() => expect(screen.getByText(/From the waitlist/i)).toBeTruthy());
    expect(screen.getByText(/Sep 24–Oct 8 · any time/)).toBeTruthy();
    expect(taken).toHaveBeenCalled();
  });
});
