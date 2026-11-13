import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BookingShop, ConnectStatus } from "./page";

/**
 * THE SETTINGS TAB, GROUPED.
 *
 * It used to be a stack of cards, one per setting, each with a paragraph and
 * a small On/Off pill off to the side. Now the settings sit in a few titled
 * groups, and every yes-or-no setting is a full-width switch row that says in
 * one line what On means.
 *
 * What must not move: each switch saves its own setting the moment it is
 * flipped (and goes back if the save is refused), the limits still save with
 * "Save booking rules", and a shop that books somewhere else is not shown
 * settings that do nothing for it.
 */

const a = vi.hoisted(() => ({ saveBookingSettingsAction: vi.fn(), copyText: vi.fn() }));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  saveBookingSettingsAction: a.saveBookingSettingsAction,
}));
vi.mock("@/lib/contactUri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/contactUri")>()),
  copyText: a.copyText,
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
  cancelCutoffHours: 24,
  customerCanReschedule: true,
  customerCanCancel: true,
  waitlistEnabled: true,
  slotOpenedTextsEnabled: false,
  requireBookingApproval: false,
  approveNewClients: false,
  bookingGroupsFirst: false,
  pushReminder24hEnabled: true,
  pushReminder2hEnabled: false,
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
const URL_ = "https://getchairback.com/book/dees";

beforeEach(() => {
  a.saveBookingSettingsAction.mockReset().mockResolvedValue({ ok: true });
  a.copyText.mockReset().mockResolvedValue(true);
});

function renderSettings(shop: Partial<BookingShop> = {}) {
  const toast = vi.fn();
  render(<SettingsTab shop={{ ...SHOP, ...shop } as BookingShop} bookUrl={URL_} connect={CONNECT} apiBase="" toast={toast} />);
  return { toast };
}

const group = (title: string) => {
  const heading = screen.getByRole("heading", { name: title });
  return within(heading.closest("section")!);
};
const sw = (name: string) => screen.getByRole("switch", { name });
const lastSave = () => a.saveBookingSettingsAction.mock.calls.at(-1)![0] as Record<string, unknown>;

describe("the groups", () => {
  it("are titled, in the order a barber thinks about them", () => {
    renderSettings();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(
      expect.arrayContaining(["When clients can book", "Changes and cancellations", "What goes out", "Your booking page"]),
    );
    const order = ["When clients can book", "Changes and cancellations", "What goes out", "Your booking page"].map((t) =>
      titles.indexOf(t),
    );
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("each switch sits in its own group", () => {
    renderSettings();
    expect(group("When clients can book").getByRole("switch", { name: "Approve each booking first" })).toBeTruthy();
    expect(group("Changes and cancellations").getByRole("switch", { name: "Clients can reschedule online" })).toBeTruthy();
    expect(group("Changes and cancellations").getByRole("switch", { name: "Clients can cancel online" })).toBeTruthy();
    const out = group("What goes out");
    expect(out.getByRole("switch", { name: "Reminder a day before" })).toBeTruthy();
    expect(out.getByRole("switch", { name: "Reminder 2 hours before" })).toBeTruthy();
    expect(out.getByRole("switch", { name: "Tell the waitlist when a time opens" })).toBeTruthy();
    const page = group("Your booking page");
    expect(page.getByRole("switch", { name: "Clients pick a date first" })).toBeTruthy();
    expect(page.getByRole("switch", { name: "Approve new clients" })).toBeTruthy();
  });

  it("the limits sit with when clients can book", () => {
    renderSettings();
    const when = group("When clients can book");
    for (const name of [/Last-minute booking limit/, /Future booking limit/, /Buffer between appointments/]) {
      expect(when.getByRole("combobox", { name })).toBeTruthy();
    }
  });

  it("deposits and fees point to Payments, where they are set", () => {
    renderSettings();
    const row = group("Changes and cancellations").getByRole("link", { name: /Deposits and late-cancel fees/ });
    expect(row.getAttribute("href")).toBe("/dashboard/payments");
  });
});

describe("a switch", () => {
  it("says what it is set to, and what On means, in one line under its name", () => {
    renderSettings();
    expect(sw("Reminder a day before").getAttribute("aria-checked")).toBe("true");
    expect(sw("Reminder 2 hours before").getAttribute("aria-checked")).toBe("false");
    const approve = sw("Approve each booking first");
    expect(approve.getAttribute("aria-checked")).toBe("false");
    const hint = document.getElementById(approve.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("Off: clients get a confirmed time the moment they book.");
    fireEvent.click(approve);
    expect(hint.textContent).toBe("On: an online booking is a request until you say yes on your calendar.");
  });

  it.each([
    ["Approve each booking first", "requireBookingApproval", true],
    ["Reminder a day before", "pushReminder24hEnabled", false],
    ["Reminder 2 hours before", "pushReminder2hEnabled", true],
    ["Tell the waitlist when a time opens", "slotOpenedTextsEnabled", true],
    ["Clients pick a date first", "bookingGroupsFirst", true],
    ["Approve new clients", "approveNewClients", true],
  ] as const)("%s saves the moment it is flipped", async (name, field, next) => {
    renderSettings();
    fireEvent.click(sw(name));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalledTimes(1));
    expect(lastSave()[field]).toBe(next);
    expect(sw(name).getAttribute("aria-checked")).toBe(String(next));
  });

  it("only its own switch sends Approve new clients", async () => {
    renderSettings();
    fireEvent.click(sw("Reminder 2 hours before"));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalledTimes(1));
    expect("approveNewClients" in lastSave()).toBe(false);
  });

  it("goes back when the save is refused", async () => {
    a.saveBookingSettingsAction.mockResolvedValue({ ok: false, error: "invalid_input" });
    const { toast } = renderSettings();
    fireEvent.click(sw("Tell the waitlist when a time opens"));
    expect(sw("Tell the waitlist when a time opens").getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(sw("Tell the waitlist when a time opens").getAttribute("aria-checked")).toBe("false"));
    expect(toast).toHaveBeenCalledWith("Couldn't save", "error");
  });
});

describe("Save booking rules", () => {
  it("still saves the limits, and says the switches save on their own", async () => {
    renderSettings();
    fireEvent.change(screen.getByRole("combobox", { name: /Future booking limit/ }), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Save booking rules" }));
    await waitFor(() => expect(a.saveBookingSettingsAction).toHaveBeenCalledTimes(1));
    expect(lastSave().bookingMaxDays).toBe(14);
    expect(screen.getByText("Saves the limits above. Each switch saves as you flip it.")).toBeTruthy();
  });
});

describe("your booking link", () => {
  it("shows the link and copies it, saying so beside the button", async () => {
    renderSettings();
    expect(screen.getByRole("link", { name: "getchairback.com/book/dees" }).getAttribute("href")).toBe(
      `${URL_}?from=dashboard`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy your booking link" }));
    expect(a.copyText).toHaveBeenCalledWith(URL_);
    expect((await screen.findByRole("status")).textContent).toBe("Copied. Paste it anywhere clients find you.");
  });

  it("a copy that fails says how to copy it by hand", async () => {
    a.copyText.mockResolvedValue(false);
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Copy your booking link" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't copy. Press and hold the link to copy it.");
  });
});

describe("a shop that books somewhere else", () => {
  it("sees only what applies to it: who joins in the app", () => {
    renderSettings({ bookingMode: "link", bookingUrl: "https://example.com/book" } as Partial<BookingShop>);
    expect(screen.queryByRole("heading", { name: "When clients can book" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "What goes out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy your booking link" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Clients pick a date first" })).toBeNull();
    expect(group("Your booking page").getByRole("switch", { name: "Approve new clients" })).toBeTruthy();
    // Its own link box is still there.
    expect(screen.getByRole("textbox", { name: "Booking link" })).toBeTruthy();
  });
});
