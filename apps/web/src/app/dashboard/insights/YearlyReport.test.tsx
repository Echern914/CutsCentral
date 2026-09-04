import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { YearlyReportData, YearlyReportOptions } from "./actions";

/**
 * The yearly report sheet.
 *
 * What is worth asserting here is not that numbers render - it is the two ways
 * a report like this can quietly become wrong:
 *
 *  1. The screen computing something the PDF does not. Every figure must be
 *     read straight off the payload; the moment this file adds anything up it
 *     is a second definition of revenue.
 *  2. Offering a barber an option the API would refuse. The picker is built
 *     from what the API returned, so a barber can never even ASK for a
 *     colleague's year - and a colleague's NAME never reaches his browser.
 */
const optionsAction = vi.hoisted(() => vi.fn());
const reportAction = vi.hoisted(() => vi.fn());

vi.mock("./actions", () => ({
  yearlyReportOptionsAction: optionsAction,
  yearlyReportAction: reportAction,
}));

const { YearlyReport } = await import("./YearlyReport");

const OWNER_OPTIONS: YearlyReportOptions = {
  years: [2026, 2025, 2024],
  currentYear: 2026,
  timezone: "America/New_York",
  canReportShop: true,
  defaultSubject: "shop",
  shopName: "Chern Cuts",
  subjects: [
    { id: "staff_eric", name: "Eric Chernichaw", active: true },
    { id: "staff_dre", name: "Dre Williams", active: true },
  ],
};

const BARBER_OPTIONS: YearlyReportOptions = {
  ...OWNER_OPTIONS,
  canReportShop: false,
  defaultSubject: "staff_eric",
  subjects: [{ id: "staff_eric", name: "Eric Chernichaw", active: true }],
};

function makeReport(over: Partial<YearlyReportData> = {}): YearlyReportData {
  return {
    year: 2025,
    yearToDate: false,
    periodLabel: "2025",
    timezone: "America/New_York",
    currency: "USD",
    rangeStart: "2025-01-01",
    rangeEnd: "2025-12-31",
    generatedAt: "2026-09-04T12:00:00.000Z",
    shopName: "Chern Cuts",
    staffId: "staff_eric",
    subjectName: "Eric Chernichaw",
    scope: "staff",
    syncedExcluded: true,
    totals: {
      appointments: 1284,
      noShows: 37,
      cancellations: 61,
      booked: 1382,
      noShowRateBp: 268,
      cancellationRateBp: 441,
      uniqueClients: 402,
      newClients: 151,
      returningClients: 251,
      returnRateBp: 6244,
      walkIns: 12,
      revenueCents: 8_412_355,
      avgMonthlyRevenueCents: 701_030,
      avgTicketCents: 6_550,
      pricedCount: 1270,
      unpricedCount: 14,
      settledThroughChairbackCents: 2_100_000,
      collectedInPersonCents: 6_312_355,
    },
    busiest: {
      month: "Aug",
      monthKey: "2025-08",
      weekday: "Sat",
      weekdayCounts: [80, 90, 140, 190, 260, 410, 114],
    },
    months: Array.from({ length: 12 }, (_, i) => ({
      key: `2025-${String(i + 1).padStart(2, "0")}`,
      label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][i]!,
      fullLabel: `Month ${i + 1} 2025`,
      appointments: 100 + i,
      revenueCents: 600_000 + i * 20_000,
      complete: true,
    })),
    services: [
      { name: "Signature Fade", count: 640, revenueCents: 4_160_000 },
      { name: "Beard Sculpt", count: 310, revenueCents: 1_240_000 },
    ],
    unavailable: [
      { key: "tips", label: "Tips", reason: "ChairBack does not record tip amounts." },
      {
        key: "cardVsCash",
        label: "Card vs cash",
        reason: "Cash and card at the chair are not told apart.",
      },
    ],
    ...over,
  };
}

async function openSheet() {
  render(<YearlyReport />);
  fireEvent.click(screen.getByTestId("yearly-report-open"));
  await waitFor(() => expect(screen.getByTestId("yearly-report-preview")).toBeTruthy());
}

beforeEach(() => {
  optionsAction.mockReset();
  reportAction.mockReset();
  optionsAction.mockResolvedValue(OWNER_OPTIONS);
  reportAction.mockResolvedValue({ report: makeReport(), filename: "chairback-eric-2025-report.pdf" });
});

describe("what the sheet shows", () => {
  it("prints every figure exactly as the API sent it", async () => {
    await openSheet();
    const preview = screen.getByTestId("yearly-report-preview");
    // Money to the cent where it matters, whole dollars where cents are noise -
    // and NOTHING recomputed: 8_412_355 cents is $84,124 rounded, which is only
    // right if the screen is formatting rather than summing.
    expect(within(preview).getByText("$84,124")).toBeTruthy();
    expect(within(preview).getByText("$65.50")).toBeTruthy();
    expect(within(preview).getByText("1,284")).toBeTruthy();
    expect(within(preview).getByText("402")).toBeTruthy();
    expect(within(preview).getByText("62.4%")).toBeTruthy();
    expect(within(preview).getByText("37 · 2.7%")).toBeTruthy();
    expect(within(preview).getByText("61 · 4.4%")).toBeTruthy();
    // "Aug" is also a chart axis label, so assert the TILE - the value node
    // carries a title attribute, the axis labels do not.
    expect(within(preview).getByTitle("Aug")).toBeTruthy();
    expect(within(preview).getByTitle("Sat")).toBeTruthy();
  });

  it("labels a finished year plainly and the year in progress as year to date", async () => {
    await openSheet();
    // A finished year is printed plainly - the preview's period label, not the
    // picker option of the same name.
    expect(within(screen.getByTestId("yearly-report-preview")).getByText("2025")).toBeTruthy();
    // The picker names the current year for what it is, so nobody prints a
    // partial year believing it is a whole one.
    const yearSelect = screen.getByTestId("yearly-report-year") as HTMLSelectElement;
    expect([...yearSelect.options].map((o) => o.textContent)).toEqual([
      "2026 year to date",
      "2025",
      "2024",
    ]);
  });

  it("says what is NOT in the numbers instead of leaving a gap", async () => {
    await openSheet();
    const preview = screen.getByTestId("yearly-report-preview");
    expect(within(preview).getByText(/Not included/i)).toBeTruthy();
    expect(within(preview).getByText(/does not record tip amounts/i)).toBeTruthy();
    expect(within(preview).getByText(/not told apart/i)).toBeTruthy();
    // A per-barber report says the synced work is missing from it.
    expect(within(preview).getByText(/carry no barber/i)).toBeTruthy();
  });

  it("renders an empty year as a complete report, not a broken one", async () => {
    reportAction.mockResolvedValue({
      report: makeReport({
        totals: {
          ...makeReport().totals,
          appointments: 0,
          noShows: 0,
          cancellations: 0,
          booked: 0,
          noShowRateBp: null,
          cancellationRateBp: null,
          uniqueClients: 0,
          newClients: 0,
          returningClients: 0,
          returnRateBp: null,
          walkIns: 0,
          revenueCents: 0,
          avgMonthlyRevenueCents: 0,
          avgTicketCents: null,
          pricedCount: 0,
          unpricedCount: 0,
          settledThroughChairbackCents: 0,
          collectedInPersonCents: 0,
        },
        busiest: { month: null, monthKey: null, weekday: null, weekdayCounts: [0, 0, 0, 0, 0, 0, 0] },
        months: makeReport().months.map((m) => ({ ...m, appointments: 0, revenueCents: 0 })),
        services: [],
      }),
      filename: "chairback-eric-2025-report.pdf",
    });
    await openSheet();
    const preview = screen.getByTestId("yearly-report-preview");
    // Honest dashes for rates with no denominator - never a confident "0%".
    expect(within(preview).getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(within(preview).getByText(/No revenue in this range/i)).toBeTruthy();
    // The actions are still there: an empty year is a report a barber may
    // legitimately want to print.
    expect(screen.getByText("Download PDF")).toBeTruthy();
  });

  it("survives very long barber and shop names", async () => {
    reportAction.mockResolvedValue({
      report: makeReport({
        subjectName: "Bartholomew Maximilian Fitzgerald-Wellingtonshire III",
        shopName: "The Extremely Distinguished Gentlemen's Grooming Parlour of Ridgewood",
      }),
      filename: "chairback-bartholomew-2025-report.pdf",
    });
    await openSheet();
    const preview = screen.getByTestId("yearly-report-preview");
    const heading = within(preview).getByText(/Bartholomew Maximilian/);
    // `truncate` is what stops a long name pushing the dates off the card -
    // the trap that makes a report look broken rather than long.
    expect(heading.className).toContain("truncate");
    expect(heading.parentElement?.className).toContain("min-w-0");
  });

  it("handles very large money without breaking the tile", async () => {
    reportAction.mockResolvedValue({
      report: makeReport({
        totals: { ...makeReport().totals, revenueCents: 987_654_321 },
      }),
      filename: "x.pdf",
    });
    await openSheet();
    expect(screen.getByText("$9,876,543")).toBeTruthy();
  });
});

describe("who may ask for whose report", () => {
  it("offers an owner the whole shop and every barber", async () => {
    await openSheet();
    const subject = screen.getByTestId("yearly-report-subject") as HTMLSelectElement;
    expect([...subject.options].map((o) => o.textContent)).toEqual([
      "Whole shop",
      "Eric Chernichaw",
      "Dre Williams",
    ]);
  });

  it("🔴 offers a barber no subject control at all, and never names a colleague", async () => {
    optionsAction.mockResolvedValue(BARBER_OPTIONS);
    await openSheet();
    // One subject and no shop option means there is nothing to choose. A
    // disabled dropdown would only raise the question.
    expect(screen.queryByTestId("yearly-report-subject")).toBeNull();
    // And the colleague's name was never in this browser to begin with - the
    // API filtered the list in its QUERY, not in the response mapping.
    expect(document.body.textContent).not.toContain("Dre Williams");
  });

  it("says plainly when the API refuses, rather than showing an empty report", async () => {
    reportAction.mockResolvedValue({ error: "forbidden" });
    render(<YearlyReport />);
    fireEvent.click(screen.getByTestId("yearly-report-open"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("only generate your own report"),
    );
    // 🔴 A refusal must never look like "you had no business this year".
    expect(screen.queryByTestId("yearly-report-preview")).toBeNull();
  });

  it("asks the API again whenever the selection changes", async () => {
    await openSheet();
    expect(reportAction).toHaveBeenLastCalledWith({ year: 2026, subject: "shop" });
    fireEvent.change(screen.getByTestId("yearly-report-year"), { target: { value: "2025" } });
    await waitFor(() =>
      expect(reportAction).toHaveBeenLastCalledWith({ year: 2025, subject: "shop" }),
    );
    fireEvent.change(screen.getByTestId("yearly-report-subject"), {
      target: { value: "staff_dre" },
    });
    await waitFor(() =>
      expect(reportAction).toHaveBeenLastCalledWith({ year: 2025, subject: "staff_dre" }),
    );
  });
});
