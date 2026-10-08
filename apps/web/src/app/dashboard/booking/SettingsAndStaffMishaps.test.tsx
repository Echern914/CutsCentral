import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BookingShop, ConnectStatus, StaffRow } from "./page";

/**
 * Booking settings, staff and holiday-date mishaps found by the 2026-10-08
 * sweep:
 *
 *  - the booking-rule boxes took numbers the API refuses, and because every
 *    toggle re-sends them, each toggle then failed too while still reading On;
 *  - one tap on staff Remove took a barber off booking for good;
 *  - Return on a phone keyboard added the same staff member twice;
 *  - "today" for holiday prices was the UTC date, so an evening save dropped
 *    today's holiday price as already past.
 */

const a = vi.hoisted(() => ({
  saveBookingSettingsAction: vi.fn(),
  deleteStaffAction: vi.fn(),
  createStaffAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/booking",
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { SettingsTab, StaffTab, buildDateOverrides } = await import("./BookingManager");

const SHOP = {
  name: "Dee's",
  slug: "dees",
  bookingMode: "native",
  bookingUrl: null,
  bookingLeadHours: 2,
  bookingMaxDays: 60,
  bookingBufferMin: 0,
  waitlistEnabled: true,
  slotOpenedTextsEnabled: false,
  requireBookingApproval: false,
  approveNewClients: false,
  bookingGroupsFirst: false,
  pushReminder24hEnabled: true,
  pushReminder2hEnabled: true,
  walkInEnabled: false,
  walkInAcceptingNow: false,
  rewardsEnabled: false,
} as unknown as BookingShop;
const CONNECT: ConnectStatus = {
  acuityConnected: false,
  acuityNeedsReconnect: false,
  acuityAvailable: false,
  squareConnected: false,
  squareAvailable: false,
  squareSync: null,
};

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.saveBookingSettingsAction.mockResolvedValue({ ok: true });
  a.deleteStaffAction.mockResolvedValue({ ok: true });
  a.createStaffAction.mockResolvedValue({ ok: true });
});

function renderSettings() {
  const toast = vi.fn();
  render(<SettingsTab shop={SHOP} bookUrl="https://x/book/dees" connect={CONNECT} apiBase="" toast={toast} />);
  return { toast };
}

describe("booking rules", () => {
  it("🔴 a notice over the API's 720 hours is never sent", async () => {
    renderSettings();
    const box = screen.getByRole("spinbutton", { name: /Min notice/ });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "1000" } });
    fireEvent.blur(box);
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
    expect(a.saveBookingSettingsAction.mock.calls[0]![0].bookingLeadHours).toBeLessThanOrEqual(720);
  });

  it("🔴 a refused toggle goes back to what the server still has", async () => {
    a.saveBookingSettingsAction.mockResolvedValue({ ok: false, error: "invalid_input" });
    renderSettings();
    // The two reminder switches start On; everything else starts Off.
    const onBefore = screen.getAllByRole("button", { name: "On" }).length;
    fireEvent.click(screen.getAllByRole("button", { name: "Off" })[0]!);
    expect(screen.getAllByRole("button", { name: "On" })).toHaveLength(onBefore + 1);
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "On" })).toHaveLength(onBefore));
  });
});

describe("staff", () => {
  const DEE: StaffRow = { id: "st1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };

  it("🔴 Remove asks first, and a No keeps the barber", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<StaffTab initial={[DEE]} toast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(confirm.mock.calls[0]![0]).toMatch(/Remove Dee\?/);
    expect(a.deleteStaffAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(a.deleteStaffAction).toHaveBeenCalledWith("st1"));
    confirm.mockRestore();
  });

  it("Return twice while adding adds the person once", async () => {
    let finish: (v: { ok: boolean }) => void = () => {};
    a.createStaffAction.mockReturnValue(new Promise((r) => (finish = r)));
    render(<StaffTab initial={[]} toast={vi.fn()} />);
    const box = screen.getByPlaceholderText("Staff member name");
    fireEvent.change(box, { target: { value: "Kai" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(a.createStaffAction).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(box, { key: "Enter" });
    finish({ ok: true });
    await waitFor(() => expect(a.createStaffAction).toHaveBeenCalledTimes(1));
  });
});

describe("holiday prices use the shop's date", () => {
  it("🔴 today's holiday survives a save, and only earlier dates drop", () => {
    const rows = [
      { date: "2026-12-23", price: "50" },
      { date: "2026-12-24", price: "60" },
      { date: "2026-12-25", price: "70" },
    ];
    // 8 PM Eastern on Dec 24 is already Dec 25 in UTC; the shop's date is the 24th.
    expect(buildDateOverrides(rows, "2026-12-24")).toEqual({ "2026-12-24": 60, "2026-12-25": 70 });
  });
});
