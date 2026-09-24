import { describe, expect, it } from "vitest";
import { addPeriods, ledger, nextBoundary, periodsThrough, type RateRow } from "./boothRent.js";

/**
 * The booth-rent ledger, pure: rate rows + the total paid + today in, the
 * balance out. The route tests exercise the same rules through the API; these
 * pin the calendar edges without a database.
 */
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const ymd = (x: Date) => x.toISOString().slice(0, 10);
let seq = 0;
function row(startsOn: string, amountCents: number | null, period: "WEEKLY" | "MONTHLY" = "WEEKLY"): RateRow {
  return {
    startsOn: d(startsOn),
    amountCents,
    period: amountCents === null ? null : period,
    createdAt: new Date(++seq),
  };
}
const spans = (rows: RateRow[], today: string) =>
  periodsThrough(rows, d(today)).map((p) => [ymd(p.start), ymd(p.end)]);

describe("periods", () => {
  it("🔴 nothing is due before the start date", () => {
    expect(periodsThrough([row("2026-09-21", 15000)], d("2026-09-20"))).toEqual([]);
    expect(ledger([row("2026-09-21", 15000)], 0, d("2026-09-20"))).toMatchObject({
      balanceCents: 0,
      current: null,
      unpaid: [],
    });
  });

  it("weeks run from the start date, whatever weekday it is", () => {
    expect(spans([row("2026-09-24", 15000)], "2026-10-01")).toEqual([
      ["2026-09-24", "2026-09-30"],
      ["2026-10-01", "2026-10-07"],
    ]);
  });

  it("months keep the start's day, clamped to short months", () => {
    expect(ymd(addPeriods(d("2026-01-31"), "MONTHLY", 1))).toBe("2026-02-28");
    expect(ymd(addPeriods(d("2026-01-31"), "MONTHLY", 2))).toBe("2026-03-31");
    expect(spans([row("2026-01-31", 50000, "MONTHLY")], "2026-03-31")).toEqual([
      ["2026-01-31", "2026-02-27"],
      ["2026-02-28", "2026-03-30"],
      ["2026-03-31", "2026-04-29"],
    ]);
  });

  it("🔴 a change starts its own periods; the ones before keep their rate", () => {
    const rows = [row("2026-09-01", 10000), row("2026-09-15", 12000)];
    expect(periodsThrough(rows, d("2026-09-22")).map((p) => p.amountCents)).toEqual([10000, 10000, 12000, 12000]);
  });

  it("a stop ends the periods; a restart runs from its own date", () => {
    const rows = [row("2026-09-01", 10000), row("2026-09-15", null), row("2026-10-07", 9000)];
    expect(spans(rows, "2026-10-14").map(([start]) => start)).toEqual([
      "2026-09-01",
      "2026-09-08",
      "2026-10-07",
      "2026-10-14",
    ]);
  });

  it("two rows on the same day: the later one counts", () => {
    const rows = [row("2026-09-01", 10000), row("2026-09-01", 12000)];
    expect(periodsThrough(rows, d("2026-09-01")).map((p) => p.amountCents)).toEqual([12000]);
  });
});

describe("nextBoundary: when a change made today takes effect", () => {
  const rows = [row("2026-09-01", 10000)];

  it("is the next period's first day - a period that began today has begun", () => {
    expect(ymd(nextBoundary(rows, d("2026-09-10"))!)).toBe("2026-09-15");
    expect(ymd(nextBoundary(rows, d("2026-09-15"))!)).toBe("2026-09-22");
  });

  it("is null when no rent is in effect", () => {
    expect(nextBoundary(rows, d("2026-08-31"))).toBeNull();
    expect(nextBoundary([...rows, row("2026-09-08", null)], d("2026-09-10"))).toBeNull();
  });
});

describe("ledger: payments pay the oldest period first", () => {
  const rows = [row("2026-09-07", 15000)];
  const today = d("2026-09-21"); // the third week

  it("🔴 a week's payment clears the MISSED week; this week still shows due", () => {
    const l = ledger(rows, 30000, today);
    expect(l.balanceCents).toBe(15000);
    expect(l.unpaid.map((u) => u.start)).toEqual(["2026-09-21"]);
    const paidOneOfTwo = ledger(rows, 15000, today);
    expect(paidOneOfTwo.unpaid.map((u) => u.start)).toEqual(["2026-09-14", "2026-09-21"]);
    expect(paidOneOfTwo.current).toMatchObject({ start: "2026-09-21", paidCents: 0, dueCents: 15000 });
  });

  it("a partial payment goes to the oldest period and shows what's left of it", () => {
    const l = ledger(rows, 20000, today);
    expect(l.unpaid[0]).toMatchObject({ start: "2026-09-14", amountCents: 15000, dueCents: 10000 });
    expect(l.balanceCents).toBe(l.unpaid.reduce((sum, u) => sum + u.dueCents, 0));
  });

  it("paying more than is due is a credit, never a negative balance", () => {
    const l = ledger(rows, 50000, today);
    expect(l).toMatchObject({ balanceCents: 0, creditCents: 5000, unpaid: [] });
    expect(l.current).toMatchObject({ paidCents: 15000, dueCents: 0 });
  });

  it("after rent stops there's no current period, and what's owed stays", () => {
    const l = ledger([row("2026-09-07", 15000), row("2026-09-14", null)], 0, d("2026-10-30"));
    expect(l).toMatchObject({ current: null, balanceCents: 15000, creditCents: 0 });
  });
});
