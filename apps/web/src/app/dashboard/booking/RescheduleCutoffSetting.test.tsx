import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BookingShop, ConnectStatus } from "./page";

/**
 * Booking rules → "Clients can reschedule up to (hours before)".
 *
 * The shop's cutoff for clients moving their own appointment
 * (config/rescheduleCutoff.ts). The box shows what the API has, saves it with
 * the other booking rules, keeps it inside the range the API accepts, and is
 * left out entirely when an older API never answered it - every booking-rule
 * save re-sends this box, and an older API refuses a field it doesn't know.
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
  bookingMaxDays: 60,
  bookingBufferMin: 0,
  rescheduleCutoffHours: 24,
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

const box = () => screen.getByRole("spinbutton", { name: /Clients can reschedule up to/ });

function type(value: string) {
  const el = box();
  fireEvent.focus(el);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}

async function saved(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: /Save booking rules/ }));
  await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
  return a.saveBookingSettingsAction.mock.calls[0]![0] as Record<string, unknown>;
}

describe("the reschedule cutoff setting", () => {
  it("shows the shop's hours and says what happens inside them", () => {
    renderSettings();
    expect((box() as HTMLInputElement).value).toBe("24");
    expect(screen.getByText(/Closer than 24 hours to the appointment, clients can't move it/)).toBeTruthy();
    expect(screen.getByText(/You can always move any appointment yourself/)).toBeTruthy();
  });

  it("saves a new number of hours with the booking rules", async () => {
    renderSettings();
    type("6");
    expect((await saved()).rescheduleCutoffHours).toBe(6);
  });

  it("0 reads as no limit and is saved as 0", async () => {
    renderSettings();
    type("0");
    expect(screen.getByText(/No limit: clients can move their appointment any time/)).toBeTruthy();
    expect((await saved()).rescheduleCutoffHours).toBe(0);
  });

  it("🔴 never sends more than a week (the API would refuse every booking-rule save)", async () => {
    renderSettings();
    type("500");
    expect((await saved()).rescheduleCutoffHours).toBeLessThanOrEqual(168);
  });

  it("🔴 an older API that never answered it: no box, and nothing sent for it", async () => {
    const { rescheduleCutoffHours: _omit, ...older } = SHOP as unknown as Record<string, unknown>;
    renderSettings(older as unknown as BookingShop);
    expect(screen.queryByRole("spinbutton", { name: /Clients can reschedule up to/ })).toBeNull();
    expect("rescheduleCutoffHours" in (await saved())).toBe(false);
  });
});
