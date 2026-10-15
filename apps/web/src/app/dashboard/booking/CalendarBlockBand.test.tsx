import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow, ServiceRow, StaffRow } from "./page";

/**
 * A blocked band on the calendar:
 *  - 🔴 tapping it OPENS the block - it no longer removes it in one tap;
 *  - a block that started the day before still shows on the day it covers.
 */
const a = vi.hoisted(() => ({
  getBlockAction: vi.fn(),
  removeBlockAction: vi.fn(),
  editBlockAction: vi.fn(),
}));
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
  getAppointmentDetailAction: vi.fn(async () => ({ ok: false })),
  ...a,
}));

const { BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-04:00`).toISOString();
const SAM: StaffRow = { id: "stf1", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "svc1", name: "Cut", durationMin: 30, price: 50, active: true }] as unknown as ServiceRow[];

function block(id: string, start: string, end: string): AgendaRow {
  return {
    id,
    source: "block",
    start,
    end,
    clientName: "Dentist",
    serviceName: null,
    serviceColor: null,
    price: null,
    status: "blocked",
    staffId: "stf1",
  } as unknown as AgendaRow;
}

function renderDay(agenda: AgendaRow[]) {
  const initial: AgendaResponse = { agenda, source: "appointment", timezone: TZ, categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative
      staff={[SAM]}
      services={services}
      toast={vi.fn()}
      openView="day"
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at("2026-09-23", "09:00")));
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  for (const f of Object.values(a)) f.mockReset();
  a.getBlockAction.mockResolvedValue({ ok: false, error: "not_found" });
});
afterEach(() => vi.useRealTimers());

describe("a blocked band", () => {
  it("🔴 opens the block instead of removing it in one tap", async () => {
    renderDay([block("blk1", at("2026-09-23", "12:00"), at("2026-09-23", "13:00"))]);
    fireEvent.click(screen.getByRole("button", { name: /Open block/ }));
    await waitFor(() => expect(a.getBlockAction).toHaveBeenCalledWith("blk1"));
    expect(a.removeBlockAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Unblock/ })).toBeNull();
  });

  it("🔴 a block that began the night before still shows on the day it covers", () => {
    renderDay([block("blk2", at("2026-09-22", "20:00"), at("2026-09-23", "10:00"))]);
    expect(document.querySelectorAll('[data-qa="block-open"]')).toHaveLength(1);
  });
});
