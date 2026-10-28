import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow, ServiceRow, StaffRow } from "./page";

/**
 * No-show from the CALENDAR card (Drick, 2026-10-27: "when no-shows come he
 * presses the button to charge the card on file and it isn't working").
 *
 * The card's buttons went through a shared `act()` that read only the error
 * CODE: a refused no-show - a day past the end, when the sweep has completed
 * it and let the card go - toasted "Couldn't update", and a successful one
 * said "Marked no-show" whether the card was charged, declined or never tried.
 */

const noShow = vi.hoisted(() => vi.fn());
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
  noShowAppointmentAction: noShow,
}));

const { BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";
const shopTime = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00-04:00`).toISOString();
const SAM: StaffRow = { id: "stf1", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "svc1", name: "Cut", durationMin: 30, price: 50, active: true }] as unknown as ServiceRow[];

const ended: AgendaRow = {
  id: "appt-missed",
  source: "appointment",
  start: shopTime("09:00"),
  end: shopTime("09:30"),
  clientName: "Missed",
  serviceName: "Cut",
  serviceId: "svc1",
  staffId: "stf1",
  serviceColor: null,
  price: 50,
  status: "upcoming",
} as AgendaRow;

const toast = vi.fn();
function renderDay() {
  const initial: AgendaResponse = { agenda: [ended], source: "appointment", timezone: TZ, categories: [] };
  return render(
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
}

async function tapNoShowTwice() {
  // Open the card, then: the first tap arms it ("Confirm no-show"), the second marks it.
  fireEvent.click(await screen.findByRole("button", { name: "Expand appointment for Missed" }));
  fireEvent.click(await screen.findByTestId("card-no-show"));
  fireEvent.click(screen.getByTestId("card-no-show"));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  return toast.mock.calls[0]!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Three hours after this booking ended: inside the no-show day.
  vi.setSystemTime(new Date(shopTime("12:30")));
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  toast.mockReset();
  noShow.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("No-show on the calendar card", () => {
  it("🔴 a refusal shows the server's own sentence, not 'Couldn't update'", async () => {
    const message =
      "It's been more than 24 hours since this appointment ended, so it was marked done and the saved card was released.";
    noShow.mockResolvedValue({ ok: false, error: "not_booked", message });
    renderDay();
    const [said, kind] = await tapNoShowTwice();
    expect(said).toBe(message);
    expect(kind).toBe("error");
    expect(noShow).toHaveBeenCalledWith("appt-missed");
  });

  it("a bare not_booked (an older API) still says something readable", async () => {
    noShow.mockResolvedValue({ ok: false, error: "not_booked" });
    renderDay();
    const [said] = await tapNoShowTwice();
    expect(said).not.toBe("Couldn't update");
    expect(said).toMatch(/isn't booked anymore/);
  });

  it("🔴 charged: the toast says the card was charged", async () => {
    noShow.mockResolvedValue({ ok: true, card: { kind: "charged", cents: 2000 } });
    renderDay();
    const [said, kind] = await tapNoShowTwice();
    expect(said).toBe("Marked no-show. Charged $20 to the saved card.");
    expect(kind).toBe("success");
  });

  it("nothing charged: the toast says why", async () => {
    noShow.mockResolvedValue({ ok: true, card: { kind: "not_charged", why: "fees_off" } });
    renderDay();
    const [said, kind] = await tapNoShowTwice();
    expect(said).toBe("Marked no-show. Nothing was charged: no-show fees were off for this booking.");
    expect(kind).toBe("info");
  });
});
