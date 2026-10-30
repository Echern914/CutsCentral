import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BookShopData } from "./page";
import type { DayBundlesResult, DayService } from "./actions";
import { dayHasTimes, dayMenuGroups } from "./dayMenu";

/**
 * The day view's service menu, from a barber's report (2026-10-29):
 *
 *  - He made "First Time Clients" and "Clients Only". The page showed only
 *    "Clients Only": a group with no times on the chosen day used to vanish.
 *    🔴 Every group now shows; one with no times says "No times this day".
 *  - "condense the boxes smaller to just Name Of Service and if they wanna see
 *    the details they just press on More details". 🔴 A row is name, price,
 *    length and times; the photo and description fold behind "More details".
 *  - 🔴 A day with nothing bookable still shows the booked-out screen - closed
 *    group cards never stand in for a time.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/book/sample-studio",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./actions", () => ({
  bookAction: vi.fn(),
  bookingStatusAction: vi.fn(),
  cardSavedAction: vi.fn(),
  getDayBundlesAction: vi.fn(),
  getMergedSlotsAction: vi.fn(),
  getOpenDaysAction: vi.fn(),
  getUpgradesAction: vi.fn(),
  joinWaitlistAction: vi.fn(),
  resumeCheckoutAction: vi.fn(),
  requestSavedCardCodeAction: vi.fn(),
  verifySavedCardCodeAction: vi.fn(),
}));

// The whole page renders per test; under the full suite's load a first paint
// can take seconds.
vi.setConfig({ testTimeout: 20_000 });

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;

const DESCRIPTION = "INCLUDES:\nhot towel\nline-up";

function svc(id: string, name: string, over: Partial<DayService> = {}): DayService {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    color: null,
    durationMin: 30,
    price: 45,
    slots: [{ startsAt: SLOT, staffIds: ["stf_1"] }],
    ...over,
  };
}

function shopData(): BookShopData {
  const menu = (id: string, name: string, groupId: string | null) => ({
    id,
    name,
    description: null,
    imageUrl: null,
    color: null,
    durationMin: 30,
    price: 45,
    priceOverrides: {},
    priceRange: { min: 45, max: 45 },
    durationOverrides: {},
    durationRange: { min: 30, max: 30 },
    timeOverrides: [],
    serviceGroupId: groupId,
    groupSortOrder: 0,
  });
  return {
    shop: {
      name: "Sample Studio",
      slug: "sample-studio",
      timezone: "UTC",
      logoUrl: null,
      accentColor: null,
      instagramHandle: null,
      bookingLeadHours: 1,
      bookingMaxDays: 60,
      payDirect: null,
      payment: { collects: "none", mode: "off", depositAmountCents: null, nonRefundable: false, sentence: "" },
    },
    staff: [{ id: "stf_1", name: "Sam", bio: null, imageUrl: null }],
    services: [
      menu("svc_first", "First Cut", "g_first"),
      menu("svc_reg", "Regular Cut", "g_clients"),
      menu("svc_loose", "Beard Trim", null),
    ],
    groups: [
      { id: "g_first", name: "First Time Clients" },
      { id: "g_clients", name: "Clients Only" },
    ],
    openWeekdays: [0, 1, 2, 3, 4, 5, 6],
    offerings: [
      { serviceId: "svc_first", staffId: "stf_1" },
      { serviceId: "svc_reg", staffId: "stf_1" },
      { serviceId: "svc_loose", staffId: "stf_1" },
    ],
    targetedSlots: [],
    addOns: [],
    questions: [],
  } as unknown as BookShopData;
}

/** "First Time Clients" shut today, "Clients Only" open, one loose service. */
function mixedDay(): DayBundlesResult {
  return {
    timezone: "UTC",
    date: DAY,
    bundles: [
      {
        id: "g_clients",
        name: "Clients Only",
        position: 1,
        services: [svc("svc_reg", "Regular Cut", { description: DESCRIPTION, imageUrl: "https://example.com/cut.jpg" })],
      },
    ],
    closedGroups: [
      {
        id: "g_first",
        name: "First Time Clients",
        position: 0,
        services: [svc("svc_first", "First Cut", { slots: [] })],
      },
    ],
    ungrouped: [svc("svc_loose", "Beard Trim")],
  };
}

beforeEach(() => {
  dayBundles.mockClear();
  openDays.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      scanDays: 60,
      openDays: [DAY],
      soonest: { date: DAY, startsAt: SLOT, serviceId: "svc_reg", staffIds: ["stf_1"] },
    },
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/**
 * The group cards once the page has SETTLED on its landing day. The page picks
 * a day itself, then re-aims when the open-days scan lands - each move clears
 * the menu - so the first cards to appear can be gone a tick later. Wait for
 * the last day fetched to be the one the scan aimed at, with its cards drawn.
 */
async function groupCards() {
  await waitFor(
    () => {
      expect(dayBundles).toHaveBeenLastCalledWith("sample-studio", DAY);
      expect(screen.getAllByTestId("day-group").length).toBeGreaterThan(0);
    },
    { timeout: 8000 },
  );
  return screen.getAllByTestId("day-group");
}
const header = (card: HTMLElement) => within(card).getAllByRole("button")[0]!;

describe("🔴 a group with no times that day is still on the page", () => {
  it("shows as a card saying 'No times this day', in the barber's group order", async () => {
    dayBundles.mockResolvedValue({ ok: true, data: mixedDay() });
    render(<BookingClient data={shopData()} />);
    const cards = await groupCards();
    expect(cards.map((c) => header(c).textContent)).toEqual([
      expect.stringMatching(/^First Time Clients\s*No times this day/),
      expect.stringMatching(/^Clients Only\s*1 service/),
    ]);
  });

  it("opening it lists its services, each saying it has no times that day", async () => {
    dayBundles.mockResolvedValue({ ok: true, data: mixedDay() });
    render(<BookingClient data={shopData()} />);
    const [first] = await groupCards();
    fireEvent.click(header(first!));
    expect(within(first!).getByText("First Cut")).toBeTruthy();
    // Header line + the service's own line.
    expect(within(first!).getAllByText("No times this day")).toHaveLength(2);
  });

  it("an API that sends no closedGroups still renders its open groups", async () => {
    const { closedGroups: _gone, ...old } = mixedDay();
    dayBundles.mockResolvedValue({
      ok: true,
      data: { ...old, bundles: old.bundles.map(({ position: _p, ...b }) => b) },
    });
    render(<BookingClient data={shopData()} />);
    const cards = await groupCards();
    expect(cards.map((c) => header(c).textContent)).toEqual([expect.stringMatching(/^Clients Only/)]);
  });
});

describe("🔴 a day with nothing bookable still says so", () => {
  it("shows the booked-out screen above the closed groups", async () => {
    dayBundles.mockResolvedValue({
      ok: true,
      data: { ...mixedDay(), bundles: [], ungrouped: [] },
    });
    render(<BookingClient data={shopData()} />);
    // An empty landing day is hopped past, so wait for the page to come to
    // rest: the booked-out line AND the closed groups, together.
    await waitFor(
      () => {
        expect(
          screen.getByText(/No available times left today\.|This day is fully booked\.|Nothing open this day/),
        ).toBeTruthy();
        const cards = screen.getAllByTestId("day-group");
        expect(header(cards[0]!).textContent).toMatch(/First Time Clients\s*No times this day/);
      },
      { timeout: 8000 },
    );
  });
});

describe("🔴 compact service rows: details fold behind 'More details'", () => {
  it("hides the description and photo until 'More details' is tapped", async () => {
    dayBundles.mockResolvedValue({ ok: true, data: mixedDay() });
    render(<BookingClient data={shopData()} />);
    // "Clients Only" is the only open card with times - the quiet-day rule
    // opens it by itself.
    await groupCards();
    await screen.findByText("Regular Cut", {}, { timeout: 8000 });
    expect(screen.queryByText(/hot towel/)).toBeNull();
    expect(document.querySelector('img[src="https://example.com/cut.jpg"]')).toBeNull();

    const toggle = screen.getByRole("button", { name: "More details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(toggle));

    const blurb = screen.getByText(/hot towel/);
    expect(blurb.className).toContain("whitespace-pre-line");
    expect(blurb.textContent).toBe(DESCRIPTION);
    expect(document.querySelector('img[src="https://example.com/cut.jpg"]')).toBeTruthy();
    const open = screen.getByRole("button", { name: "Hide details" });
    expect(open.getAttribute("aria-expanded")).toBe("true");

    await act(async () => fireEvent.click(open));
    expect(screen.queryByText(/hot towel/)).toBeNull();
  });

  it("a service with no description or photo has no toggle", async () => {
    dayBundles.mockResolvedValue({ ok: true, data: mixedDay() });
    render(<BookingClient data={shopData()} />);
    await groupCards();
    await screen.findByText("Beard Trim", {}, { timeout: 8000 });
    // Wait for the quiet-day auto-open of "Clients Only" (an effect after the
    // day lands), then: only Regular Cut has details.
    await screen.findByRole("button", { name: "More details" }, { timeout: 8000 });
    expect(screen.getAllByRole("button", { name: "More details" })).toHaveLength(1);
  });
});

describe("dayMenu rules", () => {
  it("counts a day's times, not its cards", () => {
    const day = mixedDay();
    expect(dayHasTimes(day)).toBe(true);
    expect(dayHasTimes({ ...day, bundles: [], ungrouped: [] })).toBe(false);
  });

  it("interleaves open and closed groups by position; open first without one", () => {
    expect(dayMenuGroups(mixedDay()).map((g) => [g.name, g.closed])).toEqual([
      ["First Time Clients", true],
      ["Clients Only", false],
    ]);
    const day = mixedDay();
    const noPos = {
      ...day,
      bundles: day.bundles.map(({ position: _p, ...b }) => b),
    };
    expect(dayMenuGroups(noPos).map((g) => g.name)).toEqual(["Clients Only", "First Time Clients"]);
  });
});
