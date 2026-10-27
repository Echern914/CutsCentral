import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BookingShop, ConnectStatus } from "./page";

/**
 * Booking rules → "Clients can reschedule up to".
 *
 * The shop's cutoff for clients moving their own appointment
 * (config/rescheduleCutoff.ts). The dropdown shows what the API has in words
 * ("1 day before"), saves it with the other booking rules, offers only what
 * the API accepts, and is left out entirely when an older API never answered
 * it - every booking-rule save re-sends it, and an older API refuses a field
 * it doesn't know.
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

const box = () => screen.getByRole("combobox", { name: /Clients can reschedule up to/ }) as HTMLSelectElement;

function type(value: string) {
  fireEvent.change(box(), { target: { value } });
}

async function saved(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: /Save booking rules/ }));
  await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
  return a.saveBookingSettingsAction.mock.calls[0]![0] as Record<string, unknown>;
}

describe("the reschedule cutoff setting", () => {
  it("shows the shop's hours in words and says what happens inside them", () => {
    renderSettings();
    expect(box().value).toBe("24");
    expect(box().selectedOptions[0]!.textContent).toBe("1 day before");
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

  it("🔴 offers nothing past a week (the API would refuse every booking-rule save)", () => {
    renderSettings();
    const values = [...box().options].map((o) => Number(o.value));
    expect(Math.max(...values)).toBe(168);
    expect(values[0]).toBe(0);
    expect(box().options[0]!.textContent).toBe("Anytime");
  });

  it("a cutoff that is not a preset stays a choice, and saving keeps it", async () => {
    renderSettings({ ...SHOP, rescheduleCutoffHours: 5 } as BookingShop);
    expect(box().value).toBe("5");
    expect(box().selectedOptions[0]!.textContent).toBe("5 hours before");
    expect((await saved()).rescheduleCutoffHours).toBe(5);
  });

  it("🔴 an older API that never answered it: no box, and nothing sent for it", async () => {
    const { rescheduleCutoffHours: _omit, ...older } = SHOP as unknown as Record<string, unknown>;
    renderSettings(older as unknown as BookingShop);
    expect(screen.queryByRole("combobox", { name: /Clients can reschedule up to/ })).toBeNull();
    expect("rescheduleCutoffHours" in (await saved())).toBe(false);
  });
});
