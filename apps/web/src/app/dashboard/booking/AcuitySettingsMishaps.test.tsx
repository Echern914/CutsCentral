import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AcuityMappingData } from "./actions";
import type { ConnectStatus } from "./page";

/**
 * Acuity settings mishaps from the 2026-10-08 sweep:
 *
 *  - 🔴 the calendar picker saved only on a CHANGE. The preselected calendar,
 *    and a mapping made before a reconnect ("stale"), are already the option
 *    shown, and picking the option already shown fires no change event (always,
 *    on the iOS wheel). Neither could be saved, so the shop stayed not-ready
 *    and could never turn on Acuity protection.
 *  - 🔴 the whole platform card is a button around the small Connect /
 *    Disconnect pills, and one slightly missed tap switched a live ChairBack
 *    booking shop to Acuity mode - its clients could no longer book.
 *  - a refused Disconnect showed the raw code ("unresolved_acuity_releases").
 */

const getAcuityMappingAction = vi.hoisted(() => vi.fn());
const setStaffAcuityCalendarAction = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAcuityMappingAction,
  setStaffAcuityCalendarAction,
  setStaffAcuityExtraCalendarsAction: vi.fn(),
  disconnectAcuityAction: vi.fn(),
  disconnectSquareAction: vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const { AcuityCalendarMap } = await import("./AcuityCalendarMap");
const { ConnectPlatforms, disconnectRefusal } = await import("./ConnectPlatforms");

const mapping = (over: Partial<AcuityMappingData["staff"][number]> = {}, preselect: string | null = null): AcuityMappingData => ({
  mode: "OBSERVE",
  bookingMode: "native",
  ready: false,
  preselectCalendarId: preselect,
  connectedAt: "2026-10-01T00:00:00.000Z",
  calendars: [{ id: "cal_1", name: "Dee's calendar", takenByStaffId: null }],
  staff: [
    {
      id: "st1",
      name: "Dee",
      active: true,
      bookable: true,
      calendarId: null,
      calendarName: null,
      extraCalendarIds: [],
      problem: "unmapped",
      ...over,
    },
  ],
});

beforeEach(() => {
  getAcuityMappingAction.mockReset();
  setStaffAcuityCalendarAction.mockReset();
  setStaffAcuityCalendarAction.mockResolvedValue({ ok: true });
  toast.mockReset();
});

describe("the Acuity calendar picker", () => {
  it("🔴 the preselected calendar can be saved with one tap", async () => {
    getAcuityMappingAction.mockResolvedValue({ ok: true, data: mapping({}, "cal_1") });
    render(<AcuityCalendarMap />);
    fireEvent.click(await screen.findByRole("button", { name: "Use this calendar" }));
    await waitFor(() =>
      expect(setStaffAcuityCalendarAction).toHaveBeenCalledWith("st1", "cal_1", "2026-10-01T00:00:00.000Z"),
    );
  });

  it("🔴 a stale mapping can be confirmed without picking anything new", async () => {
    getAcuityMappingAction.mockResolvedValue({
      ok: true,
      data: mapping({ calendarId: "cal_1", calendarName: "Dee's calendar", problem: "stale" }),
    });
    render(<AcuityCalendarMap />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(setStaffAcuityCalendarAction).toHaveBeenCalledWith("st1", "cal_1", expect.anything()));
  });

  it("a mapping that is fine offers no extra button", async () => {
    getAcuityMappingAction.mockResolvedValue({
      ok: true,
      data: { ...mapping({ calendarId: "cal_1", calendarName: "Dee's calendar", problem: null }), ready: true },
    });
    render(<AcuityCalendarMap />);
    await screen.findByText("Dee");
    expect(screen.queryByRole("button", { name: /Use this calendar|Confirm/ })).toBeNull();
  });
});

/**
 * Drick, 2026-10: "Ability to remove a barber I guess, not sure what this is?"
 * A chair he had removed showed as an "Inactive" Drick above his real one,
 * with a "Not mapped" picker and nothing to do about it.
 */
describe("a removed chair on the mapping card", () => {
  const removed = (over: Partial<AcuityMappingData["staff"][number]>) => ({
    id: "st_old",
    name: "Dee",
    active: false,
    bookable: false,
    calendarId: null,
    calendarName: null,
    extraCalendarIds: [],
    problem: "unmapped" as const,
    ...over,
  });

  it("🔴 one holding no calendar is not shown at all, even if an older API sends it", async () => {
    const base = mapping({ calendarId: "cal_1", calendarName: "Dee's calendar", problem: null });
    getAcuityMappingAction.mockResolvedValue({
      ok: true,
      data: { ...base, ready: true, staff: [removed({}), ...base.staff] },
    });
    render(<AcuityCalendarMap />);
    await screen.findByText("Dee");
    expect(screen.getAllByText("Dee")).toHaveLength(1);
    expect(screen.queryByText("Inactive")).toBeNull();
    expect(screen.queryByText("Removed")).toBeNull();
  });

  it("one still holding a calendar says Removed, names it, and frees it in one tap", async () => {
    const base = mapping();
    getAcuityMappingAction.mockResolvedValue({
      ok: true,
      data: {
        ...base,
        calendars: [
          { id: "cal_1", name: "Dee's calendar", takenByStaffId: "st_old" },
          { id: "cal_2", name: "After hours", takenByStaffId: "st_old" },
        ],
        staff: [
          removed({ calendarId: "cal_1", calendarName: "Dee's calendar", extraCalendarIds: ["cal_2"], problem: null }),
          ...base.staff,
        ],
      },
    });
    render(<AcuityCalendarMap />);
    expect(await screen.findByText("Removed")).toBeTruthy();
    expect(screen.getByText(/still hold "Dee's calendar", "After hours"/)).toBeTruthy();
    // No picker for a removed chair (only the active one has one): there is
    // nothing to map it to.
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Free calendars" }));
    await waitFor(() =>
      expect(setStaffAcuityCalendarAction).toHaveBeenCalledWith("st_old", null, "2026-10-01T00:00:00.000Z"),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Calendar freed", "success"));
  });

  it("a refused free is reported, not shown as done", async () => {
    setStaffAcuityCalendarAction.mockResolvedValue({ ok: false, error: "acuity_unavailable" });
    const base = mapping();
    getAcuityMappingAction.mockResolvedValue({
      ok: true,
      data: {
        ...base,
        calendars: [{ id: "cal_1", name: "Dee's calendar", takenByStaffId: "st_old" }],
        staff: [removed({ calendarId: "cal_1", calendarName: "Dee's calendar", problem: null }), ...base.staff],
      },
    });
    render(<AcuityCalendarMap />);
    fireEvent.click(await screen.findByRole("button", { name: "Free calendar" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save that mapping", "error"));
    expect(toast).not.toHaveBeenCalledWith("Calendar freed", "success");
  });
});

const connect: ConnectStatus = {
  acuityConnected: false,
  acuityNeedsReconnect: false,
  acuityAvailable: true,
  squareConnected: false,
  squareAvailable: true,
  squareSync: null,
};

describe("leaving ChairBack booking", () => {
  it("🔴 a tap on another platform's card asks first, and No keeps ChairBack booking", () => {
    const onPick = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ConnectPlatforms mode="native" onPick={onPick} connect={connect} apiBase="https://api.test" />);
    fireEvent.click(screen.getByText(/Sync appointments from your Acuity Scheduling account/).closest("button")!);
    expect(confirm.mock.calls[0]![0]).toMatch(/Clients will no longer be able to book/);
    expect(onPick).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText(/Sync appointments from your Acuity Scheduling account/).closest("button")!);
    expect(onPick).toHaveBeenCalledWith("acuity");
    confirm.mockRestore();
  });

  it("moving between other modes does not ask", () => {
    const onPick = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    render(<ConnectPlatforms mode="link" onPick={onPick} connect={connect} apiBase="https://api.test" />);
    fireEvent.click(screen.getByText(/Sync appointments from your Acuity Scheduling account/).closest("button")!);
    expect(confirm).not.toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith("acuity");
    confirm.mockRestore();
  });
});

describe("a refused Disconnect is a sentence", () => {
  it("never shows the raw code", () => {
    for (const code of ["unresolved_acuity_releases", "network_error", "forbidden_role", "failed", undefined]) {
      const line = disconnectRefusal("Acuity", code);
      expect(line, String(code)).toMatch(/^Couldn't|^Only the owner/);
      expect(line, String(code)).not.toMatch(/_/);
    }
  });
});
