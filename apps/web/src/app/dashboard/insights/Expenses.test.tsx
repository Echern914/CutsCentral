import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { InsightsData } from "./page";

/**
 * EXPENSES on Insights: the card (list + add / edit / remove in a Dialog) and
 * the two money tiles it feeds, "Expenses" and "Take-home (estimate)".
 *
 * 🔴 Outcomes live in the dialog FOOTER beside the button - a toast fired from
 * inside a dialog is invisible on a phone.
 */

const ex = vi.hoisted(() => ({
  listExpensesAction: vi.fn(),
  saveExpenseAction: vi.fn(),
  archiveExpenseAction: vi.fn(),
}));
const a = vi.hoisted(() => ({
  clearChairTimeGoalAction: vi.fn(),
  clearGoalAction: vi.fn(),
  goalAction: vi.fn(),
  insightsAction: vi.fn(),
  saveChairTimeGoalAction: vi.fn(),
  saveGoalAction: vi.fn(),
  utilizationAction: vi.fn(),
  yearlyReportOptionsAction: vi.fn(),
  yearlyReportAction: vi.fn(),
}));
vi.mock("./expenseActions", () => ex);
vi.mock("./actions", () => a);
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { ExpensesCard, fmtCents, parseDollars } = await import("./ExpensesCard");
const { InsightsClient } = await import("./InsightsClient");

const RENT = {
  id: "exp_rent",
  category: "rent" as const,
  label: "Chair",
  amountCents: 120_000,
  cadence: "monthly" as const,
  startDate: "2026-01-31",
  endDate: null,
};
const SUMMARY = { totalCents: 128_450, byCategory: { rent: 120_000, products: 8_450, supplies: 0, other: 0 } };

beforeEach(() => {
  for (const f of [...Object.values(ex), ...Object.values(a)]) f.mockReset();
  ex.listExpensesAction.mockResolvedValue({ expenses: [RENT], today: "2026-06-17" });
  a.utilizationAction.mockResolvedValue(null);
  a.yearlyReportOptionsAction.mockResolvedValue(null);
  a.insightsAction.mockResolvedValue(null);
});

function card(onChanged = vi.fn()) {
  render(<ExpensesCard summary={SUMMARY} periodLabel="Last 30 days" pending={false} onChanged={onChanged} />);
  return onChanged;
}

describe("money words", () => {
  it("formats cents, negative included", () => {
    expect(fmtCents(120_000)).toBe("$1,200");
    expect(fmtCents(8_450)).toBe("$84.50");
    expect(fmtCents(-118_450)).toBe("-$1,184.50");
    expect(fmtCents(0)).toBe("$0");
  });

  it("reads what a barber types as dollars", () => {
    expect(parseDollars("300")).toBe(30_000);
    expect(parseDollars("$1,200.5")).toBe(120_050);
    expect(parseDollars("84.50")).toBe(8_450);
    expect(parseDollars("0")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
    expect(parseDollars("1.234")).toBeNull();
    expect(parseDollars("100000.01")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
  });
});

describe("the Expenses card", () => {
  it("lists what was entered and what fell in this range, by category", async () => {
    card();
    expect(await screen.findByText("Monthly on the 31st (or the month's last day) from Jan 31, 2026")).toBeTruthy();
    expect(screen.getByTestId("expenses-range-total").textContent).toBe("$1,284.50");
    expect(screen.getByText("Products")).toBeTruthy();
    expect(screen.getByText("$84.50")).toBeTruthy();
    // A zero category is not listed as a row.
    expect(screen.queryByText("Supplies")).toBeNull();
  });

  it("adds a one-time product purchase on the shop's today, and re-reads the page", async () => {
    ex.saveExpenseAction.mockResolvedValue({ ok: true, expense: { ...RENT, id: "new" } });
    const onChanged = card();
    await screen.findByRole("button", { name: "Edit Chair expense" });
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Amount in dollars"), { target: { value: "84.50" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Products" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "One time" }));
    // No end date for a one-time expense.
    expect(within(dialog).queryByText("Ends (optional)")).toBeNull();
    expect(within(dialog).getByTestId("expense-preview").textContent).toBe("Once, Jun 17, 2026");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add expense" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(ex.saveExpenseAction).toHaveBeenCalledWith(
      { category: "products", label: null, amountCents: 8_450, cadence: "once", startDate: "2026-06-17", endDate: null },
      undefined,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(ex.listExpensesAction).toHaveBeenCalledTimes(2);
  });

  it("🔴 a refused save is read in the footer beside the button, and the dialog stays open", async () => {
    ex.saveExpenseAction.mockResolvedValue({ ok: false, error: "Couldn't save that expense. Check the fields and try again." });
    const onChanged = card();
    await screen.findByRole("button", { name: "Edit Chair expense" });
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Amount in dollars"), { target: { value: "300" } });
    const submit = within(dialog).getByRole("button", { name: "Add expense" });
    fireEvent.click(submit);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/Couldn't save that expense/);
    expect(within(alert.parentElement!).getByRole("button", { name: "Add expense" })).toBe(submit);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("checks the form before sending anything", async () => {
    card();
    await screen.findByRole("button", { name: "Edit Chair expense" });
    fireEvent.click(screen.getByRole("button", { name: "Add expense" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add expense" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Enter an amount between $0.01 and $100,000.");

    fireEvent.change(within(dialog).getByLabelText("Amount in dollars"), { target: { value: "300" } });
    fireEvent.change(within(dialog).getByLabelText(/^Ends \(optional\)/), { target: { value: "2026-01-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add expense" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("The end date can't be before the start.");
    expect(ex.saveExpenseAction).not.toHaveBeenCalled();
  });

  it("edits an existing expense with its own values, and removes it after a confirm", async () => {
    ex.archiveExpenseAction.mockResolvedValue({ ok: true });
    const onChanged = card();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Chair expense" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Amount in dollars") as HTMLInputElement).value).toBe("1200");
    expect(within(dialog).getByRole("button", { name: "Monthly" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove this expense" }));
    expect(within(dialog).getByTestId("expense-remove-confirm").textContent).toMatch(/stops counting in every range/);
    expect(ex.archiveExpenseAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(ex.archiveExpenseAction).toHaveBeenCalledWith("exp_rent");
  });
});

describe("the money tiles", () => {
  const base: InsightsData = {
    period: "30d",
    periodLabel: "Last 30 days",
    bucket: "day",
    bucketNoun: "day",
    bucketOptions: ["day", "week"],
    windowStart: "2026-05-19",
    windowEnd: "2026-06-17",
    periods: [{ key: "30d", label: "Last 30 days" }],
    scope: "peek",
    buckets: [],
    services: [],
    totals: {
      visits: 2,
      revenue: 100,
      avgTicket: 50,
      pricedCount: 2,
      unpricedCount: 0,
      uniqueClients: 2,
      newClients: 1,
      returningClients: 1,
      walkIns: 0,
    },
    busiest: { weekday: "Sat", counts: [0, 0, 0, 0, 0, 2, 0] },
    loyalty: { punchesEarned: 0, punchesRedeemed: 0, redemptions: 0 },
  };

  it("🔴 shows Expenses and a NEGATIVE take-home honestly, labelled as an estimate", async () => {
    render(<InsightsClient initial={{ ...base, expenses: SUMMARY, takeHomeCents: 10_000 - 128_450 }} />);
    const tiles = screen.getByTestId("money-tiles");
    expect(within(tiles).getByText("Expenses")).toBeTruthy();
    expect(within(tiles).getByText("$1,284.50")).toBeTruthy();
    expect(within(tiles).getByText("Take-home (estimate)")).toBeTruthy();
    const takeHome = within(tiles).getByText("-$1,184.50");
    expect(takeHome.className).toMatch(/text-danger-soft/);
    expect(tiles.textContent).toMatch(/Estimate: revenue from your bookings minus the expenses you've entered\./);
    await screen.findByRole("button", { name: "Edit Chair expense" });
  });

  it("an older payload without expenses shows neither the tiles nor the card", () => {
    render(<InsightsClient initial={base} />);
    expect(screen.queryByTestId("money-tiles")).toBeNull();
    expect(screen.queryByText("Take-home (estimate)")).toBeNull();
    expect(ex.listExpensesAction).not.toHaveBeenCalled();
  });
});
