import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BookingShop, ConnectStatus } from "./page";

/**
 * Booking rules -> "Clients can reschedule online" and "Clients can cancel
 * online" (config/customerChangeRules.ts): a switch each, plus the hours
 * before the start they close. Each is shown and sent only when the API
 * answered it - an older API refuses a field it doesn't know, which would
 * fail every booking-rule save. The fee for a late cancel is NOT here; the
 * card says so and points at Payments.
 */

const a = vi.hoisted(() => ({ saveBookingSettingsAction: vi.fn() }));
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

const { SettingsTab } = await import("./BookingManager");

const SHOP = {
  name: "Dee's",
  slug: "dees",
  bookingMode: "native",
  bookingUrl: null,
  bookingLeadHours: 2,
  bookingLeadMinutes: 120,
  bookingMaxDays: 60,
  bookingBufferMin: 0,
  rescheduleCutoffHours: 24,
  customerCanReschedule: true,
  customerCanCancel: true,
  cancelCutoffHours: 0,
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
  a.saveBookingSettingsAction.mockReset();
  a.saveBookingSettingsAction.mockResolvedValue({ ok: true });
});


function renderSettings(shop: BookingShop = SHOP) {
  render(<SettingsTab shop={shop} bookUrl="https://x/book/dees" connect={CONNECT} apiBase="" toast={vi.fn()} />);
}

const sw = (name: RegExp) => screen.getByRole("switch", { name });
const cancelBox = () => screen.getByRole("combobox", { name: /Clients can cancel up to/ }) as HTMLSelectElement;

function type(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

const lastSave = () =>
  a.saveBookingSettingsAction.mock.calls.at(-1)![0] as Record<string, unknown>;

describe("what clients can change online", () => {
  it("shows both switches on, with what the client sees and that the fee lives in Payments", () => {
    renderSettings();
    expect(sw(/Clients can reschedule online/).getAttribute("aria-checked")).toBe("true");
    expect(sw(/Clients can cancel online/).getAttribute("aria-checked")).toBe("true");
    expect(cancelBox().value).toBe("0");
    expect(cancelBox().selectedOptions[0]!.textContent).toBe("Anytime");
    expect(screen.getByText(/No limit: clients can cancel any time before the appointment starts/)).toBeTruthy();
    expect(screen.getByText(/You can always cancel any appointment yourself/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Payments" }).getAttribute("href")).toBe("/dashboard/payments");
  });

  it("🔴 turning cancelling off saves at once, and says the client is sent to you", async () => {
    renderSettings();
    fireEvent.click(sw(/Clients can cancel online/));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
    expect(lastSave()).toMatchObject({ customerCanCancel: false, customerCanReschedule: true, cancelCutoffHours: 0 });
    expect(sw(/Clients can cancel online/).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/Off: clients can't cancel from their link or by text/)).toBeTruthy();
    // No hours to set for something that is off.
    expect(screen.queryByRole("combobox", { name: /Clients can cancel up to/ })).toBeNull();
  });

  it("🔴 turning rescheduling off saves at once", async () => {
    renderSettings();
    fireEvent.click(sw(/Clients can reschedule online/));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
    expect(lastSave()).toMatchObject({ customerCanReschedule: false, customerCanCancel: true });
    expect(screen.getByText(/Off: clients can't move their appointment from their link or by text/)).toBeTruthy();
  });

  it("a refused save puts the switch back", async () => {
    a.saveBookingSettingsAction.mockResolvedValue({ ok: false });
    renderSettings();
    fireEvent.click(sw(/Clients can cancel online/));
    await waitFor(() =>
      expect(sw(/Clients can cancel online/).getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("saves the cancel hours with the booking rules, within a week", async () => {
    renderSettings();
    type(cancelBox(), "12");
    expect(screen.getByText(/Closer than 12 hours to the appointment, clients can't cancel it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Save booking rules/ }));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
    expect(lastSave().cancelCutoffHours).toBe(12);

    // Nothing past a week is offered at all.
    expect(Math.max(...[...cancelBox().options].map((o) => Number(o.value)))).toBe(168);
  });

  it("🔴 an older API that never answered them: no switches, and nothing sent for them", async () => {
    const {
      customerCanReschedule: _r,
      customerCanCancel: _c,
      cancelCutoffHours: _h,
      ...older
    } = SHOP as unknown as Record<string, unknown>;
    renderSettings(older as unknown as BookingShop);
    expect(screen.queryByRole("switch", { name: /Clients can reschedule online/ })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Clients can cancel online/ })).toBeNull();
    expect(screen.queryByText(/Clients can cancel online/)).toBeNull();
    // The #637 hours box still shows - that API answered it.
    expect(screen.getByRole("combobox", { name: /Clients can reschedule up to/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Save booking rules/ }));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
    const sent = lastSave();
    for (const k of ["customerCanReschedule", "customerCanCancel", "cancelCutoffHours"]) {
      expect(k in sent, k).toBe(false);
    }
  });
});
