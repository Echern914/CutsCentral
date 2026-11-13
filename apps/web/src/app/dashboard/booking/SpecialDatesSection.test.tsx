import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { SpecialDayRow, TargetedSlotRow, TargetedSlotRuleRow } from "./actions";
import type { ServiceRow, StaffRow } from "./page";

/**
 * Special dates used to be three cards, each with its own form and its own
 * list: Holiday pricing, Special day, Targeted slots - and a fourth list on
 * each service's own page. A barber called it cluttered.
 *
 * It is now ONE list of every date that runs differently, soonest first, and
 * under it the three tools as closed rows. A tap on a date opens the tool
 * that owns it, on that date. "Add a date" asks what is different and opens
 * the same tool ready to add.
 */

const a = vi.hoisted(() => ({
  listSpecialDaysAction: vi.fn(),
  listTargetedSlotsAction: vi.fn(),
  listUpgradeRulesAction: vi.fn(),
  getAvailabilityAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

// The two full-screen editors, each stood in for by what it was opened on.
vi.mock("./LiveDayView", () => ({
  LiveDayView: (p: { dates: string[]; defaultName?: string; onSaved?: () => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Live view">
      <p>{`live ${p.dates.join(",")} ${p.defaultName ?? ""}`}</p>
      <button onClick={p.onSaved}>stub saved</button>
      <button onClick={p.onClose}>stub close</button>
    </div>
  ),
}));
vi.mock("./ServiceDatesSheet", () => ({
  ServiceDatesSheet: (p: {
    service: { name: string };
    onClose: () => void;
    onSaved?: (h: Record<string, unknown>, o: Record<string, number>) => void;
  }) => (
    <div role="dialog" aria-label="Change some days">
      <p>{`days of ${p.service.name}`}</p>
      <button onClick={() => p.onSaved?.({ "2026-12-05": { w: [], staff: [] } }, {})}>stub close a day</button>
      <button onClick={p.onClose}>stub close</button>
    </div>
  ),
}));

const { ServicesTab } = await import("./BookingManager");

const staff: StaffRow[] = [{ id: "st1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 }];

function service(id: string, name: string, over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id,
    name,
    description: null,
    imageUrl: null,
    durationMin: 30,
    price: 40,
    priceOverrides: {},
    dateOverrides: {},
    durationOverrides: {},
    dailyLimits: {},
    hoursWindows: {},
    timeOverrides: [],
    color: null,
    offeredByAll: true,
    active: true,
    visibility: "public",
    sortOrder: 0,
    dailyTarget: null,
    staffIds: ["st1"],
    serviceGroupId: null,
    ...over,
  };
}

const FADE = service("fade", "Fade", {
  dateOverrides: { "2026-11-26": 75 },
  dateHours: { "2026-11-24": { w: [{ s: 480, e: 1260 }], staff: [] } },
});
const KIDS = service("kids", "Kids cut");

const DAY: SpecialDayRow = {
  ruleId: "sd1",
  staffId: "st1",
  date: "2026-12-24",
  name: "Christmas Eve",
  price: 65,
  cutMin: 20,
  firstStart: null,
  lastEnd: null,
  openings: 12,
  booked: 0,
};
const SLOT: TargetedSlotRow = {
  id: "t1",
  staffId: "st1",
  serviceId: "fade",
  label: "After hours",
  // 9:30 PM on Nov 20 in New York.
  startsAt: "2026-11-21T02:30:00.000Z",
  durationMin: 30,
  price: 80,
  active: true,
  ruleId: null,
  booked: false,
};
const RULE: TargetedSlotRuleRow = {
  id: "rule1",
  staffId: "st1",
  serviceId: "fade",
  label: "Late night",
  schedule: { "5": [{ startMin: 1260 }] },
  durationMin: 30,
  price: 60,
  indefinite: true,
};

function renderDates(services: ServiceRow[] = [FADE, KIDS], names: Record<string, string> = { "2026-11-26": "Thanksgiving" }) {
  render(
    <ServicesTab
      initial={services}
      holidayNames={names}
      staff={staff}
      initialServiceGroups={[]}
      initialAddOns={[]}
      timezone="America/New_York"
      toast={vi.fn()}
      groupUnsavedRef={{ current: null }}
      acuityConnected={false}
      initialSection="dates"
    />,
  );
}

/**
 * 🔴 Text is looked for INSIDE the list. The tools under it stay mounted while
 * closed, and they print the same names; getByText finds hidden text too, so
 * an unscoped look could pass on a tool's copy with the list empty.
 */
const list = () => within(document.getElementById("special-dates-list") as HTMLElement);

/** The list's own rows, in order: "Nov: After hours, 9:30 PM | Open". */
function rows(): string[] {
  return list().getAllByRole("region").flatMap((month) =>
    within(month)
      .getAllByRole("listitem")
      .map((li) => {
        const spans = [...li.querySelectorAll("button > span")];
        const text = spans[2]!.querySelector("span")!.textContent;
        return `${month.getAttribute("aria-label")}: ${text} | ${spans[3]!.textContent}`;
      }),
  );
}
const row = (name: RegExp) => list().getByRole("button", { name });
const tool = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
const isOpen = (name: string) => tool(name).getAttribute("aria-expanded") === "true";

const scrolled = vi.fn();
beforeEach(() => {
  // A fixed instant in the past: "today" in the shop is Nov 1, 2026.
  vi.useFakeTimers({ now: new Date("2026-11-01T16:00:00.000Z"), toFake: ["Date"] });
  for (const f of Object.values(a)) f.mockReset();
  a.listSpecialDaysAction.mockResolvedValue({ ok: true, specialDays: [DAY] });
  a.listTargetedSlotsAction.mockResolvedValue({ ok: true, slots: [SLOT], rules: [RULE] });
  a.listUpgradeRulesAction.mockResolvedValue({ ok: false });
  a.getAvailabilityAction.mockResolvedValue({ ok: true, data: { rules: [] } });
  scrolled.mockReset();
  // jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled(this.id);
  };
});
afterEach(() => {
  vi.useRealTimers();
});

/** The list once both reads have answered. */
async function loaded() {
  await list().findByText("Christmas Eve");
  await list().findByText("After hours, 9:30 PM");
}

describe("every special date in one list", () => {
  it("🔴 lists all four kinds, soonest first, by month, each with what it is", async () => {
    renderDates();
    await loaded();
    expect(rows()).toEqual([
      "November: After hours, 9:30 PM | Open",
      "November: Fade | Hours",
      "November: Thanksgiving | Price",
      "December: Christmas Eve | Special day",
    ]);
  });

  it("a weekly series is not a date: it is counted on its tool, not listed", async () => {
    renderDates();
    await loaded();
    expect(list().queryByText(/Late night/)).toBeNull();
    expect(tool("Targeted slots").textContent).toContain("1 weekly, 1 one-time");
  });

  it("each tool's row says how much it holds", async () => {
    renderDates();
    await loaded();
    expect(tool("Holiday pricing").textContent).toContain("1 coming up");
    expect(tool("Special day").textContent).toContain("1 planned");
  });

  it("says so when nothing is coming up", async () => {
    a.listSpecialDaysAction.mockResolvedValue({ ok: true, specialDays: [] });
    a.listTargetedSlotsAction.mockResolvedValue({ ok: true, slots: [], rules: [] });
    renderDates([KIDS], {});
    expect(await screen.findByText("Nothing special coming up. Every day runs on your usual week.")).toBeTruthy();
    expect(tool("Holiday pricing").textContent).toContain("None");
    expect(tool("Targeted slots").textContent).toContain("None");
  });

  it("shows what it has while the rest is still being read", async () => {
    a.listTargetedSlotsAction.mockReturnValue(new Promise(() => {}));
    renderDates();
    await list().findByText("Christmas Eve");
    // Prices and hours come with the page; they do not wait.
    expect(list().getByText("Thanksgiving")).toBeTruthy();
    expect(screen.getByText(/Still loading the rest/)).toBeTruthy();
    expect(tool("Targeted slots").textContent).toContain("Loading…");
  });
});

describe("the tools are rows, closed until asked for", () => {
  it("🔴 no form is open at first: the list is what the section shows", async () => {
    renderDates();
    await loaded();
    expect(isOpen("Holiday pricing")).toBe(false);
    expect(isOpen("Special day")).toBe(false);
    expect(isOpen("Targeted slots")).toBe(false);
    // Hidden, so not reachable - but still mounted (the list reads its data).
    expect(screen.queryByRole("button", { name: "Publish slot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Add a holiday" })).toBeNull();
  });

  it("a row opens its tool, and opening another closes it", async () => {
    renderDates();
    await loaded();
    fireEvent.click(tool("Targeted slots"));
    expect(screen.getByRole("button", { name: "Publish slot" })).toBeTruthy();
    fireEvent.click(tool("Holiday pricing"));
    expect(isOpen("Targeted slots")).toBe(false);
    expect(screen.getByRole("button", { name: "+ Add a holiday" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish slot" })).toBeNull();
  });

  it("a tool inside its row does not repeat its own title", async () => {
    renderDates();
    await loaded();
    fireEvent.click(tool("Holiday pricing"));
    expect(screen.queryByRole("heading", { name: "Holiday pricing" })).toBeNull();
    expect(screen.getByText(/Charge a different price on a named date/)).toBeTruthy();
  });
});

describe("a tap on a date opens the tool that owns it", () => {
  it("🔴 a price opens Holiday pricing ON that holiday, and brings it to the top", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/Thanksgiving/));
    expect(isOpen("Holiday pricing")).toBe(true);
    expect(screen.getByText("Editing Thanksgiving - saving replaces it")).toBeTruthy();
    expect(screen.getByPlaceholderText("Thanksgiving")).toHaveValue("Thanksgiving");
    // The row first, then the form under its list: the form is where the page ends up.
    await waitFor(() => expect(scrolled).toHaveBeenLastCalledWith("holiday-form"));
    expect(scrolled).toHaveBeenCalledWith("dates-price");
  });

  it("🔴 the same holiday tapped again after Cancel opens again", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/Thanksgiving/));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Editing Thanksgiving - saving replaces it")).toBeNull();
    fireEvent.click(row(/Thanksgiving/));
    expect(screen.getByText("Editing Thanksgiving - saving replaces it")).toBeTruthy();
  });

  it("a special day opens its live view, with its name", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/Christmas Eve/));
    expect(screen.getByText("live 2026-12-24 Christmas Eve")).toBeTruthy();
    // No tool row opened for it: the live view is the editor.
    expect(isOpen("Special day")).toBe(false);
  });

  it("one service's hours open that service's own days", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/Fade.*8:00 AM/));
    expect(screen.getByText("days of Fade")).toBeTruthy();
  });

  it("🔴 a one-time opening opens Targeted slots with THAT slot open and in view", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/After hours, 9:30 PM/));
    expect(isOpen("Targeted slots")).toBe(true);
    const card = document.getElementById("tslot-t1")!;
    expect(within(card).getByRole("button", { expanded: true })).toBeTruthy();
    // The row first, then the slot itself: the slot is where the page ends up.
    await waitFor(() => expect(scrolled).toHaveBeenLastCalledWith("tslot-t1"));
    expect(scrolled).toHaveBeenCalledWith("dates-slots");
  });
});

describe("Add a date asks what is different", () => {
  const choose = (name: RegExp) => {
    fireEvent.click(screen.getByRole("button", { name: "Add a date" }));
    fireEvent.click(screen.getByRole("button", { name }));
  };

  it("offers the four kinds, each with what it means", async () => {
    renderDates();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Add a date" }));
    expect(screen.getByText("What is different that day?")).toBeTruthy();
    for (const label of [
      /^A different price/,
      /^Different hours for one service/,
      /^The whole day, run your way/,
      /^One extra opening/,
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("What is different that day?")).toBeNull();
    expect(screen.getByRole("button", { name: "Add a date" })).toBeTruthy();
  });

  it("🔴 a different price opens the holiday form, empty and ready", async () => {
    renderDates();
    await loaded();
    choose(/^A different price/);
    expect(isOpen("Holiday pricing")).toBe(true);
    expect(screen.getByLabelText("First day")).toHaveValue("");
    expect(screen.queryByText(/^Editing /)).toBeNull();
    await waitFor(() => expect(scrolled).toHaveBeenLastCalledWith("holiday-form"));
    expect(scrolled).toHaveBeenCalledWith("dates-price");
  });

  it("a price asked for after a holiday was open starts EMPTY, not on that holiday", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/Thanksgiving/));
    choose(/^A different price/);
    expect(screen.queryByText(/^Editing /)).toBeNull();
    expect(screen.getByPlaceholderText("Thanksgiving")).toHaveValue("");
  });

  it("hours for one service asks which service, then opens its days", async () => {
    renderDates();
    await loaded();
    choose(/^Different hours for one service/);
    expect(screen.getByText("Which service?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kids cut" }));
    expect(screen.getByText("days of Kids cut")).toBeTruthy();
    expect(screen.queryByText("Which service?")).toBeNull();
  });

  it("with one service there is nothing to ask", async () => {
    renderDates([FADE]);
    await loaded();
    choose(/^Different hours for one service/);
    expect(screen.getByText("days of Fade")).toBeTruthy();
  });

  it("the whole day opens Special day on its date box", async () => {
    renderDates();
    await loaded();
    choose(/^The whole day, run your way/);
    expect(isOpen("Special day")).toBe(true);
    expect(screen.getByLabelText("Date")).toBeTruthy();
    await waitFor(() => expect(scrolled).toHaveBeenLastCalledWith("special-day-plan"));
    expect(scrolled).toHaveBeenCalledWith("dates-day");
  });

  it("one extra opening opens Targeted slots, where it is published", async () => {
    renderDates();
    await loaded();
    choose(/^One extra opening/);
    expect(screen.getByRole("button", { name: "Publish slot" })).toBeTruthy();
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith("dates-slots"));
  });
});

describe("the list stays true after a change", () => {
  it("🔴 a day closed from here is on the list at once, before the page refetches", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/Fade.*8:00 AM/));
    fireEvent.click(screen.getByRole("button", { name: "stub close a day" }));
    // The save answered with one closed day and no dated hours or prices.
    expect(rows()).toEqual([
      "November: After hours, 9:30 PM | Open",
      "December: Fade closed | Closed",
      "December: Christmas Eve | Special day",
    ]);
  });

  it("🔴 a saved special day re-reads the days AND the slots it published", async () => {
    renderDates();
    await loaded();
    expect(a.listSpecialDaysAction).toHaveBeenCalledTimes(1);
    expect(a.listTargetedSlotsAction).toHaveBeenCalledTimes(1);
    fireEvent.click(row(/Christmas Eve/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub saved" }));
    });
    await waitFor(() => expect(a.listTargetedSlotsAction).toHaveBeenCalledTimes(2));
    expect(a.listSpecialDaysAction).toHaveBeenCalledTimes(2);
  });

  it("a slot shown from the list is not thrown open again by that re-read", async () => {
    renderDates();
    await loaded();
    fireEvent.click(row(/After hours, 9:30 PM/));
    await waitFor(() => expect(scrolled).toHaveBeenLastCalledWith("tslot-t1"));
    scrolled.mockReset();
    fireEvent.click(row(/Christmas Eve/));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub saved" }));
    });
    await waitFor(() => expect(a.listTargetedSlotsAction).toHaveBeenCalledTimes(2));
    await list().findByText("After hours, 9:30 PM");
    expect(scrolled).not.toHaveBeenCalledWith("tslot-t1");
  });
});

describe("a read that failed", () => {
  it("🔴 the list says what it may be missing, once, and leads to the tool that can retry", async () => {
    a.listTargetedSlotsAction.mockResolvedValue({ ok: false });
    renderDates();
    await list().findByText("Christmas Eve");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load your one-time openings");
    expect(alert.textContent).toContain("still live on your booking page");
    expect(tool("Targeted slots").textContent).toContain("Couldn't load");
    // What did load is still shown.
    expect(list().getByText("Thanksgiving")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "See what went wrong" }));
    expect(isOpen("Targeted slots")).toBe(true);
    // The retry is the tool's own - one of them on the page, not two.
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });

  it("special days that did not load are named, and lead to Special day", async () => {
    a.listSpecialDaysAction.mockResolvedValue({ ok: false });
    renderDates();
    await list().findByText("After hours, 9:30 PM");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load your special days");
    expect(tool("Special day").textContent).toContain("Couldn't load");
    fireEvent.click(within(alert).getByRole("button", { name: "See what went wrong" }));
    expect(isOpen("Special day")).toBe(true);
  });

  it("an empty list is never called empty when part of it did not load", async () => {
    a.listSpecialDaysAction.mockResolvedValue({ ok: false });
    a.listTargetedSlotsAction.mockResolvedValue({ ok: true, slots: [], rules: [] });
    renderDates([KIDS], {});
    await screen.findByRole("alert");
    expect(screen.queryByText(/Nothing special coming up/)).toBeNull();
  });
});
