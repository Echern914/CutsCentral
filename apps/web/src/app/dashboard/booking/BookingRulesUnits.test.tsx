import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BookingShop, ConnectStatus } from "./page";

/**
 * Booking rules in words (config/bookingRuleUnits.ts).
 *
 * The card was five bare number boxes whose unit lived only in the label. A
 * barber typed 15 into "Min notice (hours)" meaning fifteen MINUTES, saved
 * fifteen hours, and turned away a same-day client. Each rule is now a
 * dropdown whose choices say their unit, with the sentence beneath, and the
 * notice is saved in minutes - so "15 minutes" is a real choice.
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

function renderSettings(shop: Partial<Record<string, unknown>> = {}) {
  render(
    <SettingsTab
      shop={{ ...SHOP, ...shop } as BookingShop}
      bookUrl="https://x/book/dees"
      connect={CONNECT}
      apiBase=""
      toast={vi.fn()}
    />,
  );
}

const select = (name: RegExp) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
const lead = () => select(/Last-minute booking limit/);
const labels = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);
const shown = (el: HTMLSelectElement) => el.selectedOptions[0]!.textContent;

async function saved(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: /Save booking rules/ }));
  await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalled());
  return a.saveBookingSettingsAction.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe("the last-minute booking limit", () => {
  it("🔴 15 minutes is a choice, reads as minutes, and saves as 15 MINUTES", async () => {
    renderSettings();
    expect(shown(lead())).toBe("2 hours");
    expect(labels(lead())).toEqual(
      expect.arrayContaining(["No limit", "15 minutes", "30 minutes", "1 hour", "2 hours", "1 day", "1 week"]),
    );
    fireEvent.change(lead(), { target: { value: "15" } });
    expect(screen.getByText("Clients must book at least 15 minutes ahead.")).toBeTruthy();
    const body = await saved();
    expect(body.bookingLeadMinutes).toBe(15);
    expect("bookingLeadHours" in body).toBe(false);
  });

  it("🔴 a value that is not a preset stays a choice, in its unit, and saving keeps it", async () => {
    // What the barber actually saved: 15 typed into the old hours box.
    renderSettings({ bookingLeadHours: 15, bookingLeadMinutes: 900 });
    expect(shown(lead())).toBe("15 hours");
    expect((await saved()).bookingLeadMinutes).toBe(900);
  });

  it("an older API that answers hours only: whole hours offered, sent as hours", async () => {
    const { bookingLeadMinutes: _m, ...older } = SHOP as unknown as Record<string, unknown>;
    render(
      <SettingsTab shop={older as unknown as BookingShop} bookUrl="https://x/book/dees" connect={CONNECT} apiBase="" toast={vi.fn()} />,
    );
    expect(shown(lead())).toBe("2 hours");
    expect(labels(lead())).not.toContain("15 minutes");
    fireEvent.change(lead(), { target: { value: "1440" } });
    const body = await saved();
    expect(body.bookingLeadHours).toBe(24);
    expect("bookingLeadMinutes" in body).toBe(false);
  });
});

describe("the other rules say their unit", () => {
  it("future booking limit: weeks and months, with the days alongside", async () => {
    renderSettings();
    const el = select(/Future booking limit/);
    expect(shown(el)).toBe("2 months (60 days)");
    expect(labels(el)).toEqual(expect.arrayContaining(["1 week", "2 weeks", "1 month (30 days)", "1 year (365 days)"]));
    fireEvent.change(el, { target: { value: "14" } });
    expect(screen.getByText("Clients can book up to 2 weeks ahead.")).toBeTruthy();
    expect((await saved()).bookingMaxDays).toBe(14);
  });

  it("buffer: None, then minutes, and the last slot of the day needs it too", async () => {
    renderSettings();
    const el = select(/Buffer between appointments/);
    expect(shown(el)).toBe("None");
    fireEvent.change(el, { target: { value: "15" } });
    expect(screen.getByText(/final booking ends 15 minutes before closing/)).toBeTruthy();
    expect((await saved()).bookingBufferMin).toBe(15);
  });

  it("a buffer that is not a preset stays a choice", () => {
    renderSettings({ bookingBufferMin: 7 });
    expect(shown(select(/Buffer between appointments/))).toBe("7 minutes");
  });

  it("cutoffs: Anytime, hours and days before", () => {
    renderSettings();
    expect(shown(select(/Clients can reschedule up to/))).toBe("1 day before");
    expect(shown(select(/Clients can cancel up to/))).toBe("Anytime");
    expect(labels(select(/Clients can cancel up to/))).toEqual(
      expect.arrayContaining(["1 hour before", "12 hours before", "2 days before", "1 week before"]),
    );
  });

  it("no rule is a bare number box any more", () => {
    renderSettings();
    for (const name of [/Last-minute/, /Future booking/, /Buffer between/, /reschedule up to/, /cancel up to/]) {
      expect(screen.queryByRole("spinbutton", { name })).toBeNull();
    }
  });
});
