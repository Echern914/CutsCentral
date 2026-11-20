import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ByPersonData, InsightsData } from "./page";

/**
 * The Insights totals, split by who took each appointment.
 *
 *  - every row, "Not assigned" and a Total that is the tiles' own figure;
 *  - tips only where the shop has them, never a $0 column that reads as
 *    "nobody tips";
 *  - nothing at all for a one-person shop (the API sends no split), so its
 *    page is the page it always was.
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
const { ByPersonCard } = await import("./ByPersonCard");

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.utilizationAction.mockResolvedValue(null);
  a.yearlyReportOptionsAction.mockResolvedValue(null);
  a.insightsAction.mockResolvedValue(null);
});

const SPLIT: ByPersonData = {
  rows: [
    { staffId: "sam", name: "Sam", active: true, visits: 3, noShows: 1, revenueCents: 8000, tipsCents: 800 },
    { staffId: "dee", name: "Dee", active: true, visits: 1, noShows: 0, revenueCents: 5550, tipsCents: 500 },
    { staffId: "gary", name: "Gary", active: false, visits: 1, noShows: 0, revenueCents: 3000, tipsCents: 0 },
  ],
  notAssigned: { visits: 1, noShows: 0, revenueCents: 2500 },
  total: { visits: 6, noShows: 1, revenueCents: 19050, tipsCents: 1300 },
  tips: true,
};

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
    visits: 6,
    revenue: 191,
    avgTicket: 40,
    pricedCount: 6,
    unpricedCount: 0,
    uniqueClients: 3,
    newClients: 1,
    returningClients: 2,
    walkIns: 0,
  },
  busiest: { weekday: "Sat", counts: [0, 0, 0, 0, 1, 3, 0] },
  loyalty: { punchesEarned: 0, punchesRedeemed: 0, redemptions: 0 },
};

const items = () => within(screen.getByTestId("by-person")).getAllByRole("listitem");

describe("per person on Insights", () => {
  it("🔴 one line per person, then Not assigned, then the Total", () => {
    render(<ByPersonCard data={SPLIT} />);
    const lines = items().map((li) => li.textContent ?? "");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^Sam3 visits · 1 no-show · \$8 tips\$80$/);
    expect(lines[1]).toMatch(/^Dee1 visit · \$5 tips\$55\.50$/);
    expect(lines[2]).toMatch(/Gary.*no longer on your booking page.*\$30$/);
    expect(screen.getByTestId("not-assigned").textContent).toMatch(/Not assigned1 visit · synced from another booking app/);
    expect(screen.getByTestId("by-person-total").textContent).toBe("Total6 visits · 1 no-show · $13 tips$190.50");
    expect(screen.getByRole("heading", { name: "By provider" })).toBeTruthy();
  });

  it("🔴 no tips column where the shop has none, and no Not assigned line without synced work", () => {
    render(
      <ByPersonCard
        data={{
          ...SPLIT,
          rows: SPLIT.rows.map((r) => ({ ...r, tipsCents: 0 })),
          notAssigned: null,
          total: { ...SPLIT.total, tipsCents: 0 },
          tips: false,
        }}
      />,
    );
    const card = screen.getByTestId("by-person");
    expect(card.textContent).not.toMatch(/tips/i);
    expect(screen.queryByTestId("not-assigned")).toBeNull();
  });

  it("sits under the headline tiles on the page, on the peek too", () => {
    const { rerender } = render(<InsightsClient initial={{ ...BASE, byPerson: SPLIT }} initialStats={null} />);
    expect(screen.getByTestId("by-person")).toBeTruthy();
    rerender(<InsightsClient initial={{ ...BASE, scope: "peek", byPerson: { ...SPLIT, tips: false } }} initialStats={null} />);
    expect(screen.getByTestId("by-person")).toBeTruthy();
  });

  it("🔴 a one-person shop's page has no such card", () => {
    const { rerender } = render(<InsightsClient initial={{ ...BASE, byPerson: null }} initialStats={null} />);
    expect(screen.queryByTestId("by-person")).toBeNull();
    // An older payload, without the field at all.
    rerender(<InsightsClient initial={BASE} initialStats={null} />);
    expect(screen.queryByTestId("by-person")).toBeNull();
  });
});
