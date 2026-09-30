import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse } from "./page";

/**
 * A BARBER ALERT OPENS ON ITS DAY. A barber, 2026-09-29: "when I tap a
 * notification it should take me directly to that day and time's appointment."
 *
 * The alert links to `?appointment=<id>&day=YYYY-MM-DD`. The calendar used to
 * start on today's month whatever the link said, so a booking made for next
 * month was never loaded and its sheet could not open. Now the calendar starts
 * on the linked day and loads that month; the sheet opens once the row is in.
 */
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const getAgendaAction = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: false })));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction,
}));

const { BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";

function renderCalendar(link: { openAppointmentId?: string; openDay?: string }) {
  const initial: AgendaResponse = { agenda: [], source: "visit", timezone: TZ, categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative={false}
      staff={[]}
      services={[]}
      toast={() => {}}
      {...link}
    />,
  );
}

beforeEach(() => {
  // Wednesday Sep 23 2026, noon in the shop.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00"));
  getAgendaAction.mockClear();
  window.history.replaceState(null, "", "/dashboard/booking?tab=Appointments&appointment=ap_1&day=2026-10-20");
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the calendar opens on the linked day", () => {
  it("🔴 a booking next month: opens on that day and loads that month", async () => {
    renderCalendar({ openAppointmentId: "ap_1", openDay: "2026-10-20" });
    expect(await screen.findByText(/Tuesday, Oct 20/)).toBeTruthy();
    await waitFor(() => expect(getAgendaAction).toHaveBeenCalledTimes(1));
    const [from, to] = getAgendaAction.mock.calls[0]! as [string, string];
    // October, with the week of padding either side the calendar always loads.
    expect(new Date(from).getTime()).toBeLessThan(new Date("2026-10-01T00:00:00Z").getTime());
    expect(new Date(to).getTime()).toBeGreaterThan(new Date("2026-10-31T00:00:00Z").getTime());
  });

  it("a day in THIS month needs no extra load", async () => {
    renderCalendar({ openAppointmentId: "ap_1", openDay: "2026-09-25" });
    expect(await screen.findByText(/Friday, Sep 25/)).toBeTruthy();
    expect(getAgendaAction).not.toHaveBeenCalled();
  });

  it("🔴 anything that isn't a date is ignored - today, as before", async () => {
    renderCalendar({ openAppointmentId: "ap_1", openDay: "next-tuesday" });
    expect(await screen.findByText(/Wednesday, Sep 23/)).toBeTruthy();
    expect(getAgendaAction).not.toHaveBeenCalled();
  });

  it("the link is taken off the address, so a refresh doesn't reopen it", async () => {
    renderCalendar({ openAppointmentId: "ap_1", openDay: "2026-10-20" });
    await waitFor(() => expect(window.location.search).toBe("?tab=Appointments"));
  });
});
