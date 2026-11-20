import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BookShopData } from "./page";
import type { DayBundlesResult, DayService } from "./actions";

/**
 * A shop with several people: the customer can choose who.
 *
 * Before this, the page merged everyone's times into one list and booked the
 * first person on whichever time was tapped. A customer could not ask for the
 * person they always see, was not told who they got until after booking, and
 * the shop page's "Book with <name>" link landed on everyone's times.
 *
 *  - 🔴 Two or more people: a row above the calendar, starting on "Any
 *    available". One person: no row, the page is exactly as it was.
 *  - 🔴 Tapping a person shows only THEIR times, and the booking goes to them.
 *  - 🔴 The details step names who the booking is with, before anything is sent.
 *  - "Book with <name>" (?staff=<id>, no service) opens already narrowed.
 *  - A person with nothing that day says so, with the way back to everyone.
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

// The form itself is covered by WaitlistForm.test.tsx; here only what the page
// hands it matters - whose waitlist the customer is joining.
vi.mock("./WaitlistForm", () => ({
  WaitlistForm: (props: { staffId?: string; serviceLabel?: string }) => (
    <div data-testid="waitlist-form" data-staff={props.staffId ?? ""}>
      {props.serviceLabel ?? ""}
    </div>
  ),
}));

vi.setConfig({ testTimeout: 20_000 });

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

const MS_DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = iso(Date.now() + 4 * MS_DAY);
// A second open day in the SAME calendar month, so both cells are on screen.
const OTHER =
  iso(Date.now() + 5 * MS_DAY).slice(0, 7) === DAY.slice(0, 7)
    ? iso(Date.now() + 5 * MS_DAY)
    : iso(Date.now() + 3 * MS_DAY);
const weekdayOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const T3 = `${DAY}T15:00:00.000Z`;
const T4 = `${DAY}T16:00:00.000Z`;

function svc(id: string, name: string, slots: DayService["slots"]): DayService {
  return { id, name, description: null, imageUrl: null, color: null, durationMin: 30, price: 45, slots };
}

interface Person {
  id: string;
  name: string;
  weekdays?: number[];
}
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const MARCUS: Person = { id: "stf_m", name: "Marcus", weekdays: EVERY_DAY };
const DRE: Person = { id: "stf_d", name: "Dre", weekdays: EVERY_DAY };

function shopData(people: Person[], shop: Record<string, unknown> = {}): BookShopData {
  const menu = (id: string, name: string) => ({
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
    serviceGroupId: null,
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
      ...shop,
    },
    staff: people.map((p) => ({ ...p, bio: null, imageUrl: null })),
    services: [menu("svc_reg", "Regular Service"), menu("svc_beard", "Beard Trim")],
    groups: [],
    openWeekdays: EVERY_DAY,
    // Everyone does the regular service; only Marcus does beards.
    offerings: [
      ...people.map((p) => ({ serviceId: "svc_reg", staffId: p.id })),
      { serviceId: "svc_beard", staffId: "stf_m" },
    ],
    targetedSlots: [],
    addOns: [],
    questions: [],
  } as unknown as BookShopData;
}

/** 3:00 is open with both (Dre first, as the API orders it); 4:00 only Marcus. */
function teamDay(): DayBundlesResult {
  return {
    timezone: "UTC",
    date: DAY,
    bundles: [],
    closedGroups: [],
    ungrouped: [
      svc("svc_reg", "Regular Service", [
        { startsAt: T3, staffIds: ["stf_d", "stf_m"] },
        { startsAt: T4, staffIds: ["stf_m"] },
      ]),
      svc("svc_beard", "Beard Trim", [{ startsAt: T3, staffIds: ["stf_m"] }]),
    ],
  };
}

function soloDay(): DayBundlesResult {
  return {
    ...teamDay(),
    ungrouped: [svc("svc_reg", "Regular Service", [{ startsAt: T3, staffIds: ["stf_m"] }])],
  };
}

beforeEach(() => {
  dayBundles.mockReset();
  upgrades.mockReset();
  upgrades.mockResolvedValue({ upgrades: [], maxExtraMin: 0 } as never);
  openDays.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      scanDays: 60,
      openDays: [DAY, OTHER].sort(),
      soonest: { date: DAY, startsAt: T3, serviceId: "svc_reg", staffIds: ["stf_d", "stf_m"] },
    },
  });
  // DAY has the team's times; every other day is simply empty.
  dayBundles.mockImplementation(async (_slug: string, date: string) => ({
    ok: true,
    data: date === DAY ? teamDay() : { ...teamDay(), date, ungrouped: [] },
  }));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** The menu once the page has come to rest on a day showing this service. */
async function settled(serviceName = "Regular Service") {
  return screen.findByText(serviceName, {}, { timeout: 8000 });
}
const row = () => screen.getByTestId("person-row");
const chip = (name: string) => within(row()).getByRole("button", { name });
const times = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.textContent ?? "")
    .filter((t) => /^\d{1,2}:\d{2}\s?(AM|PM)$/.test(t.trim()));

describe("🔴 the row of people", () => {
  it("a shop with two people shows it, starting on 'Any available'", async () => {
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    expect(within(row()).getByText("Choose your provider")).toBeTruthy();
    expect(chip("Any available").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Marcus").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Dre").getAttribute("aria-pressed")).toBe("false");
  });

  it("🔴 a one-person shop has no row at all", async () => {
    dayBundles.mockResolvedValue({ ok: true, data: soloDay() });
    render(<BookingClient data={shopData([MARCUS])} />);
    await settled();
    expect(screen.queryByTestId("person-row")).toBeNull();
    expect(screen.queryByText("Any available")).toBeNull();
  });

  it("someone with no hours, or who does nothing on the menu, is not offered", async () => {
    const idle: Person = { id: "stf_x", name: "Idle", weekdays: [] };
    render(<BookingClient data={shopData([MARCUS, DRE, idle])} />);
    await settled();
    expect(within(row()).queryByRole("button", { name: "Idle" })).toBeNull();
  });
});

describe("🔴 choosing a person", () => {
  it("shows only their times and only what they do", async () => {
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    // Everyone: 3:00 and 4:00 for the regular service, 3:00 for the beard trim.
    expect(times()).toHaveLength(3);
    expect(screen.getByText("Beard Trim")).toBeTruthy();

    await act(async () => fireEvent.click(chip("Dre")));
    expect(chip("Dre").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Any available").getAttribute("aria-pressed")).toBe("false");
    // Dre is free at 3:00 only, and does not do beards.
    expect(times().map((t) => t.trim())).toEqual(["3:00 PM"]);
    expect(screen.queryByText("Beard Trim")).toBeNull();
    // Narrowed from the day already on the page: no second request.
    expect(dayBundles.mock.calls.filter(([, d]) => d === DAY)).toHaveLength(1);
  });

  it("going back to 'Any available' brings everyone's times back", async () => {
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    await act(async () => fireEvent.click(chip("Dre")));
    await act(async () => fireEvent.click(chip("Any available")));
    expect(times()).toHaveLength(3);
  });

  it("🔴 a time shared by both is booked with the person who was chosen, not the first listed", async () => {
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    await act(async () => fireEvent.click(chip("Marcus")));
    const three = screen
      .getAllByRole("button")
      .filter((b) => (b.textContent ?? "").trim() === "3:00 PM")[0]!;
    await act(async () => fireEvent.click(three));
    // The API listed Dre first on this time; the customer asked for Marcus.
    expect(screen.getByTestId("booking-with").textContent).toBe("With Marcus");
    await waitFor(() =>
      expect(upgrades).toHaveBeenLastCalledWith(
        "sample-studio",
        expect.objectContaining({ staffId: "stf_m", startsAt: T3 }),
      ),
    );
  });

  it("changing person clears a time picked under the old choice", async () => {
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    const three = screen
      .getAllByRole("button")
      .filter((b) => (b.textContent ?? "").trim() === "3:00 PM")[0]!;
    await act(async () => fireEvent.click(three));
    expect(screen.getByTestId("booking-with")).toBeTruthy();
    await act(async () => fireEvent.click(chip("Marcus")));
    expect(screen.queryByTestId("booking-with")).toBeNull();
  });
});

describe("🔴 the customer is told who before confirming", () => {
  it("on 'Any available' the details step names the person the time went to", async () => {
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    const three = screen
      .getAllByRole("button")
      .filter((b) => (b.textContent ?? "").trim() === "3:00 PM")[0]!;
    await act(async () => fireEvent.click(three));
    // First on the time's list, which the API orders by who is least booked.
    expect(screen.getByTestId("booking-with").textContent).toBe("With Dre");
  });

  it("a one-person shop says nothing: there is nobody else it could be", async () => {
    dayBundles.mockResolvedValue({ ok: true, data: soloDay() });
    render(<BookingClient data={shopData([MARCUS])} />);
    await settled();
    const three = screen
      .getAllByRole("button")
      .filter((b) => (b.textContent ?? "").trim() === "3:00 PM")[0]!;
    await act(async () => fireEvent.click(three));
    await screen.findByText(/Your details/);
    expect(screen.queryByTestId("booking-with")).toBeNull();
  });
});

describe("'Book with <name>' from the shop page (?staff=, no service)", () => {
  it("🔴 opens already narrowed to that person", async () => {
    render(
      <BookingClient data={shopData([MARCUS, DRE])} prefill={{ serviceId: null, staffId: "stf_d" }} />,
    );
    await settled();
    expect(chip("Dre").getAttribute("aria-pressed")).toBe("true");
    expect(times().map((t) => t.trim())).toEqual(["3:00 PM"]);
  });

  it("someone who no longer works here is just 'Any available'", async () => {
    render(
      <BookingClient data={shopData([MARCUS, DRE])} prefill={{ serviceId: null, staffId: "stf_gone" }} />,
    );
    await settled();
    expect(chip("Any available").getAttribute("aria-pressed")).toBe("true");
    expect(times()).toHaveLength(3);
  });
});

describe("a person with nothing that day", () => {
  /** Only Marcus has times on DAY. */
  function marcusOnly(): DayBundlesResult {
    return {
      ...teamDay(),
      ungrouped: [svc("svc_reg", "Regular Service", [{ startsAt: T3, staffIds: ["stf_m"] }])],
    };
  }

  it("says it is THEIR day that is empty, and offers the way back to everyone", async () => {
    dayBundles.mockImplementation(async (_slug: string, date: string) => ({
      ok: true,
      data: date === DAY ? marcusOnly() : { ...teamDay(), date, ungrouped: [] },
    }));
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    // A deliberate tap on the day, so the page does not move on by itself.
    const dayCell = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-pressed") === "true" && /^\d+$/.test((b.textContent ?? "").trim()))!;
    await act(async () => fireEvent.click(dayCell));
    await settled();

    await act(async () => fireEvent.click(chip("Dre")));
    expect(screen.getByText(/Dre has no times (this day|left today)\./)).toBeTruthy();
    expect(times()).toEqual([]);

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /See any available provider/ })),
    );
    expect(chip("Any available").getAttribute("aria-pressed")).toBe("true");
    expect(times().map((t) => t.trim())).toEqual(["3:00 PM"]);
  });

  it("🔴 the waitlist they join there is that person's", async () => {
    dayBundles.mockImplementation(async (_slug: string, date: string) => ({
      ok: true,
      data: date === DAY ? marcusOnly() : { ...teamDay(), date, ungrouped: [] },
    }));
    render(<BookingClient data={shopData([MARCUS, DRE], { waitlistEnabled: true })} />);
    await settled();
    const dayCell = screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-pressed") === "true" && /^\d+$/.test((b.textContent ?? "").trim()))!;
    await act(async () => fireEvent.click(dayCell));
    await settled();
    await act(async () => fireEvent.click(chip("Dre")));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: /Join the waitlist — get notified/ })),
    );
    const form = screen.getByTestId("waitlist-form");
    expect(form.getAttribute("data-staff")).toBe("stf_d");
    expect(form.textContent).toBe("your visit with Dre");
  });
});

describe("the calendar follows the person", () => {
  it("🔴 greys a day the shop is open but they are off", async () => {
    // Dre does not work OTHER's weekday; the shop (Marcus) does.
    const dre: Person = { ...DRE, weekdays: EVERY_DAY.filter((w) => w !== weekdayOf(OTHER)) };
    render(<BookingClient data={shopData([MARCUS, dre])} />);
    await settled();
    /** OTHER's cell in the month grid: the day number, with a spoken date. */
    const otherCell = () =>
      screen
        .getAllByRole("button")
        .find(
          (b) =>
            (b.textContent ?? "").trim() === String(Number(OTHER.slice(8))) &&
            b.hasAttribute("aria-label"),
        ) as HTMLButtonElement;
    // Open for the shop...
    expect(otherCell().disabled).toBe(false);
    // ...and not offered once Dre is chosen.
    await act(async () => fireEvent.click(chip("Dre")));
    expect(otherCell().disabled).toBe(true);
    expect(otherCell().getAttribute("aria-label")).toMatch(/\(no openings\)$/);
    // Back to everyone: the day is offered again.
    await act(async () => fireEvent.click(chip("Any available")));
    expect(otherCell().disabled).toBe(false);
  });

  it("hides 'Soonest available' once a person is chosen: it may be someone else's time", async () => {
    render(<BookingClient data={shopData([MARCUS, DRE])} />);
    await settled();
    expect(screen.getByText("Soonest available")).toBeTruthy();
    await act(async () => fireEvent.click(chip("Dre")));
    expect(screen.queryByText("Soonest available")).toBeNull();
  });
});
