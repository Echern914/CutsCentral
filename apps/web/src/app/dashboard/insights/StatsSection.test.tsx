import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { Goal, InsightsData, StatsData } from "./page";

/**
 * The Stats strip at the top of Insights, and the suggested goal under it.
 *
 *  - the Day / Week / Month switch fetches and shows THAT grain's series;
 *  - tapping (or focusing) a bar shows its period and exact value;
 *  - previous vs current carries an arrow whose colour follows good/bad, and
 *    no-shows going UP is bad news;
 *  - "Use this goal" saves the suggestion through the ordinary goals action;
 *  - a Starter shop sees the headline cards and a Premium badge on the rest.
 */

const a = vi.hoisted(() => ({
  clearChairTimeGoalAction: vi.fn(),
  clearGoalAction: vi.fn(),
  goalAction: vi.fn(),
  insightsAction: vi.fn(),
  saveChairTimeGoalAction: vi.fn(),
  saveGoalAction: vi.fn(),
  statsAction: vi.fn(),
  utilizationAction: vi.fn(),
  yearlyReportOptionsAction: vi.fn(),
  yearlyReportAction: vi.fn(),
}));
vi.mock("./actions", () => a);
vi.mock("./expenseActions", () => ({
  listExpensesAction: vi.fn(async () => null),
  saveExpenseAction: vi.fn(),
  deleteExpenseAction: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { InsightsClient } = await import("./InsightsClient");
const { StatsSection } = await import("./StatsSection");

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.utilizationAction.mockResolvedValue(null);
  a.yearlyReportOptionsAction.mockResolvedValue(null);
  a.insightsAction.mockResolvedValue(null);
});

const GRAINS = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
] as StatsData["grains"];

function weekStats(over: Partial<StatsData> = {}): StatsData {
  return {
    grain: "week",
    scope: "full",
    grains: GRAINS,
    windowStart: "2026-06-08",
    windowEnd: "2026-06-17",
    periods: [
      { key: "2026-06-08", label: "Jun 8", fullLabel: "Week of Jun 8" },
      { key: "2026-06-15", label: "Jun 15", fullLabel: "Week of Jun 15" },
    ],
    metrics: [
      { key: "bookings", locked: false, values: [57, 50] },
      { key: "revenue", locked: false, values: [215_000, 240_050] },
      { key: "avgTicket", locked: false, values: [4000, null] },
      { key: "hoursBooked", locked: false, values: [600, 630] },
      { key: "newClients", locked: false, values: [3, 3] },
      { key: "noShows", locked: false, values: [1, 3] },
    ],
    suggestions: [
      { metric: "revenue", period: "week", target: 2450, average: 2150, periodsAveraged: 4, best: 2600, liftPct: 14 },
      { metric: "visits", period: "week", target: 60, average: 54, periodsAveraged: 4, best: 61, liftPct: 11 },
    ],
    levers: { rewards: false, rebookPush: true, autoFill: false },
    ...over,
  };
}

const card = (key: string) => screen.getByTestId(`stat-${key}`);

describe("a stat card", () => {
  function renderSection(stats: StatsData) {
    return render(
      <StatsSection
        stats={stats}
        grain={stats.grain}
        pending={false}
        failed={false}
        onGrain={vi.fn()}
        serviceNoun="visit"
      />,
    );
  }

  it("tapping a bar shows that period's exact value; focusing one does too", () => {
    renderSection(weekStats());
    const bookings = card("bookings");
    const readout = screen.getByTestId("stat-bookings-readout");
    expect(readout.textContent).toBe("");
    fireEvent.click(within(bookings).getByRole("button", { name: "Week of Jun 8: 57" }));
    expect(readout.textContent).toBe("Week of Jun 8: 57");
    expect(
      within(bookings).getByRole("button", { name: "Week of Jun 8: 57" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.focus(within(card("revenue")).getByRole("button", { name: "Week of Jun 15: $2,400.50" }));
    expect(screen.getByTestId("stat-revenue-readout").textContent).toBe("Week of Jun 15: $2,400.50");
  });

  it("a real tap (focus, THEN click) leaves the readout open", () => {
    // A browser focuses a button on pointer-down and clicks on pointer-up. A
    // toggle on click would undo the select the focus just made.
    renderSection(weekStats());
    const bar = within(card("bookings")).getByRole("button", { name: "Week of Jun 8: 57" });
    fireEvent.focus(bar);
    fireEvent.click(bar);
    expect(screen.getByTestId("stat-bookings-readout").textContent).toBe("Week of Jun 8: 57");
  });

  it("shows previous vs current with a red down arrow when a good number falls", () => {
    renderSection(weekStats());
    const bookings = card("bookings");
    expect(bookings.textContent).toContain("Jun 8 · 57");
    expect(bookings.textContent).toContain("Jun 15 · 50");
    const mark = bookings.querySelector("[data-trend]")!;
    expect(mark.getAttribute("data-trend")).toBe("down");
    expect(mark.className).toContain("text-danger-soft");
    expect(mark.textContent).toContain("down from last period");
  });

  it("a rise is green, a rise in no-shows is red, a tie is neutral, nothing to compare has no arrow", () => {
    renderSection(weekStats());
    const rev = card("revenue").querySelector("[data-trend]")!;
    expect(rev.getAttribute("data-trend")).toBe("up");
    expect(rev.className).toContain("text-emerald-soft");
    const ns = card("noShows").querySelector("[data-trend]")!;
    expect(ns.getAttribute("data-trend")).toBe("up");
    expect(ns.className).toContain("text-danger-soft");
    expect(card("newClients").querySelector("[data-trend]")!.className).toContain("text-muted");
    expect(card("avgTicket").querySelector("[data-trend]")).toBeNull();
  });

  it("the arrow compares this period so far with the last one up to the same point", () => {
    // Last week ended on 57, but by this point of it there were 40: 50 so far is UP.
    renderSection(
      weekStats({
        metrics: [{ key: "bookings", locked: false, values: [57, 50], previousToDate: 40 }],
      }),
    );
    const bookings = card("bookings");
    expect(bookings.textContent).toContain("Jun 8 · 40");
    const mark = bookings.querySelector("[data-trend]")!;
    expect(mark.getAttribute("data-trend")).toBe("up");
    expect(mark.className).toContain("text-emerald-soft");
    expect(screen.getByTestId("stats-basis").textContent).toBe(
      " Arrows compare this week so far with last week up to the same point.",
    );
    // The previous bar itself still reads the whole week.
    expect(within(bookings).getByRole("button", { name: "Week of Jun 8: 57" })).toBeTruthy();
  });

  it("highlights the current period's bar with the theme's gold, never a raw colour", () => {
    renderSection(weekStats());
    const bars = within(card("bookings")).getAllByRole("button");
    const fill = (b: HTMLElement) => b.querySelector("span")!.className;
    expect(fill(bars[1]!)).toContain("bg-gold");
    expect(fill(bars[0]!)).not.toContain("bg-gold");
    expect(fill(bars[0]!)).toMatch(/bg-muted/);
  });

  it("Starter: the headline cards show this period vs the last, the rest carry the Premium badge", () => {
    renderSection(
      weekStats({
        scope: "peek",
        suggestions: [],
        levers: null,
        metrics: [
          { key: "bookings", locked: false, values: [57, 50] },
          { key: "revenue", locked: false, values: [215_000, 240_050] },
          { key: "avgTicket", locked: false, values: [4000, 4200] },
          { key: "hoursBooked", locked: true, values: [] },
          { key: "newClients", locked: true, values: [] },
          { key: "noShows", locked: true, values: [] },
        ],
      }),
    );
    expect(card("bookings").textContent).toContain("Jun 15 · 50");
    // No bar history on the peek.
    expect(within(card("bookings")).queryAllByRole("button")).toHaveLength(0);
    for (const key of ["hoursBooked", "newClients", "noShows"]) {
      expect(card(key).getAttribute("data-locked")).toBe("true");
      expect(card(key).textContent).toMatch(/Premium/);
      expect(card(key).textContent).not.toMatch(/\d/);
    }
  });
});

const BASE: InsightsData = {
  scope: "full",
  period: "30d",
  periodLabel: "Last 30 days",
  bucket: "day",
  bucketNoun: "day",
  bucketOptions: ["day"],
  windowStart: "2026-05-19",
  windowEnd: "2026-06-17",
  periods: [{ key: "30d", label: "Last 30 days" }],
  buckets: [],
  services: [],
  totals: {
    visits: 4,
    revenue: 160,
    avgTicket: 40,
    pricedCount: 4,
    unpricedCount: 0,
    uniqueClients: 3,
    newClients: 1,
    returningClients: 2,
    walkIns: 0,
  },
  busiest: { weekday: "Sat", counts: [0, 0, 0, 0, 1, 3, 0] },
  loyalty: { punchesEarned: 0, punchesRedeemed: 0, redemptions: 0 },
};

const UNSET: Goal[] = (["revenue", "visits"] as const).flatMap((metric) =>
  (["week", "month"] as const).map((period) => ({ metric, period, target: null, plan: null, progress: null })),
);

describe("on the Insights page", () => {
  it("the Day / Week / Month switch fetches and shows that grain's series", async () => {
    a.statsAction.mockResolvedValue(
      weekStats({
        grain: "month",
        periods: [
          { key: "2026-05", label: "May", fullLabel: "May 2026" },
          { key: "2026-06", label: "Jun", fullLabel: "June 2026" },
        ],
        metrics: [{ key: "bookings", locked: false, values: [210, 120] }],
        suggestions: [],
      }),
    );
    render(<InsightsClient initial={BASE} initialStats={weekStats()} initialGoalData={null} />);
    expect(card("bookings").textContent).toContain("Jun 15 · 50");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Month" }));
    });
    expect(a.statsAction).toHaveBeenCalledWith("month");
    await waitFor(() => expect(card("bookings").textContent).toContain("Jun · 120"));
    expect(within(card("bookings")).getByRole("button", { name: "May 2026: 210" })).toBeTruthy();
  });

  it("puts the numbers first and the goals under them", () => {
    render(
      <InsightsClient
        initial={BASE}
        initialStats={weekStats()}
        initialGoalData={{ goals: UNSET, chairTime: { target: null }, serviceGoals: [], planner: { services: [], capacity: { week: { openMin: 0 }, month: { openMin: 0 } } } }}
      />,
    );
    const stats = screen.getByRole("heading", { name: "Stats" });
    const where = screen.getByRole("heading", { name: "Where you can go" });
    const goals = screen.getByText("Goals");
    expect(stats.compareDocumentPosition(where) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(where.compareDocumentPosition(goals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("explains the suggestion, and 'Use this goal' saves it through the goals action", async () => {
    a.saveGoalAction.mockResolvedValue({ ok: true });
    a.goalAction.mockResolvedValue(null);
    render(
      <InsightsClient
        initial={BASE}
        initialStats={weekStats()}
        initialGoalData={{ goals: UNSET, chairTime: { target: null }, serviceGoals: [], planner: { services: [], capacity: { week: { openMin: 0 }, month: { openMin: 0 } } } }}
      />,
    );
    const cell = screen.getByTestId("suggest-revenue");
    expect(cell.textContent).toContain(
      "Your last 4 weeks averaged $2,150. With rebooking nudges running, $2,450 is within reach (about 14% more).",
    );
    await act(async () => {
      fireEvent.click(within(cell).getByRole("button", { name: "Use this goal" }));
    });
    expect(a.saveGoalAction).toHaveBeenCalledWith({ metric: "revenue", period: "week", target: 2450 });
    expect(a.goalAction).toHaveBeenCalled();
    expect(within(cell).getByRole("status").textContent).toMatch(/Saved/);
    // Rewards and auto-fill are off: each links to where it is switched on.
    const levers = screen.getByTestId("growth-levers");
    expect(within(levers).getByRole("link", { name: "Turn on rewards" }).getAttribute("href")).toBe("/dashboard/rewards");
    expect(within(levers).getByRole("link", { name: "Fill cancellations automatically" })).toBeTruthy();
  });

  it("a goal already at the suggestion cannot be 'used' again", () => {
    const goals = UNSET.map((g) => (g.metric === "revenue" && g.period === "week" ? { ...g, target: 2450 } : g));
    render(
      <InsightsClient
        initial={BASE}
        initialStats={weekStats()}
        initialGoalData={{ goals, chairTime: { target: null }, serviceGoals: [], planner: { services: [], capacity: { week: { openMin: 0 }, month: { openMin: 0 } } } }}
      />,
    );
    const btn = within(screen.getByTestId("suggest-revenue")).getByRole("button", { name: "This is your goal" });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("Starter: no suggestions and no goals, the headline cards still lead", () => {
    render(
      <InsightsClient
        initial={{ ...BASE, scope: "peek" }}
        initialStats={weekStats({
          scope: "peek",
          suggestions: [],
          levers: null,
          metrics: [
            { key: "bookings", locked: false, values: [57, 50] },
            { key: "hoursBooked", locked: true, values: [] },
          ],
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Stats" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where you can go" })).toBeNull();
    expect(screen.queryByText("Use this goal")).toBeNull();
    expect(card("hoursBooked").getAttribute("data-locked")).toBe("true");
  });
});
