import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TodayAgenda, type TodayRow } from "./TodayAgenda";
import { durationLabel, planToday, startsIn } from "./todayPlan";

/**
 * The dashboard's Today page (Studio redesign). Every number on it is a claim
 * a barber acts on - "4 left", "1h 30m open", "Up next: Jordan in 18 min" - so
 * each is pinned against a fixed clock rather than whenever the suite runs.
 */

const TZ = "America/New_York";
// 2026-11-16 in New York (EST, UTC-5): 9:00 AM local = 14:00Z.
const at = (hhmm: string) => `2026-11-16T${hhmm}:00.000Z`;
const NOW = Date.parse(at("15:42")); // 10:42 AM local

let n = 0;
const row = (over: Partial<TodayRow>): TodayRow => ({
  id: `r${++n}`,
  source: "appointment",
  start: at("14:00"),
  end: at("14:30"),
  staffId: "chair-1",
  clientName: "Client",
  serviceName: "Cut",
  serviceColor: null,
  price: 40,
  status: "upcoming",
  ...over,
});

// A day shaped like the approved board: done, next, a lunch, a request, a gap.
const day = () => [
  row({ clientName: "Andre Bell", start: at("14:30"), end: at("15:45"), price: 60, status: "completed" }),
  row({ id: "jordan", clientName: "Jordan D", start: at("16:00"), end: at("16:35"), price: 45 }),
  row({ source: "block", clientName: "Lunch", start: at("17:00"), end: at("17:30"), price: null, status: "blocked" }),
  row({ clientName: "Will Park", start: at("17:30"), end: at("18:00"), price: 20 }),
  // 18:00 -> 19:30 is 1h 30m of open time.
  row({ id: "sofia", clientName: "Sofia Reyes", start: at("19:30"), end: at("20:00"), price: 30, status: "pending" }),
  row({ clientName: "Marcus Lee", start: at("21:30"), end: at("22:00"), price: 45 }),
  row({ clientName: "Gone Guy", start: at("20:30"), end: at("21:00"), price: 99, status: "canceled" }),
];

describe("planToday", () => {
  it("booked = the calendar's own day total: requests and cancellations never count", () => {
    // 60 + 45 + 20 + 45; Sofia's request and the canceled 99 are out.
    expect(planToday(day(), NOW).booked).toBe(170);
  });

  it("🔴 'left' goes by the clock, not just the status", () => {
    // Andre is done; a booked cut whose END has passed is done too, even
    // before the completion sweep marks it.
    const rows = [...day(), row({ clientName: "Morning", start: at("13:00"), end: at("13:30") })];
    // Jordan, Will, Marcus. The request is not a booking yet.
    expect(planToday(rows, NOW).left).toBe(3);
  });

  it("up next is the next booking, and the one in the chair beats it", () => {
    expect(planToday(day(), NOW).upNext?.clientName).toBe("Jordan D");
    const during = Date.parse(at("16:10"));
    expect(planToday(day(), during).upNext?.clientName).toBe("Jordan D");
    expect(startsIn(planToday(day(), during).upNext!, during)).toBe("Now");
    expect(startsIn(planToday(day(), NOW).upNext!, NOW)).toBe("in 18 min");
  });

  it("🔴 a request is never 'up next' - it has not been accepted", () => {
    const rows = [row({ status: "pending", start: at("16:00"), end: at("16:30") })];
    const plan = planToday(rows, NOW);
    expect(plan.upNext).toBeNull();
    expect(plan.requests).toHaveLength(1);
  });

  it("finds the open gap between bookings, and counts only what is still ahead", () => {
    const plan = planToday(day(), NOW);
    const gaps = plan.schedule.filter((i) => i.kind === "gap");
    // Lunch is a block, so 17:00-17:30 is NOT open; 18:00-19:30 is; Sofia's
    // request holds 19:30-20:00; the canceled 20:30 frees 20:00-21:30.
    expect(gaps.map((g) => g.kind === "gap" && durationLabel(g.minutes))).toEqual(["1h 30m", "1h 30m"]);
    expect(plan.openMin).toBe(180);
    // Half way through the first gap, only its back half is fillable.
    expect(planToday(day(), Date.parse(at("18:45"))).openMin).toBe(45 + 90);
  });

  it("🔴 the last few minutes of a gap are not open time (seen in the render: 'Fill it' with 11 left)", () => {
    // 20 minutes left of the 18:00-19:30 gap: too short for any booking.
    const late = Date.parse(at("19:10"));
    const plan = planToday(day(), late);
    expect(plan.openMin).toBe(90);
    expect(plan.schedule.filter((i) => i.kind === "gap" && i.fillable)).toHaveLength(1);
    render(<TodayAgenda rows={day()} timezone={TZ} now={late} />);
    expect(screen.getAllByText("Open · 1h 30m")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Fill it" })).toHaveLength(1);
  });

  it("a changeover is not a gap", () => {
    const rows = [
      row({ start: at("16:00"), end: at("16:30") }),
      row({ start: at("16:45"), end: at("17:15") }),
    ];
    expect(planToday(rows, NOW).schedule.some((i) => i.kind === "gap")).toBe(false);
    expect(planToday(rows, NOW).openMin).toBe(0);
  });

  it("🔴 two chairs: a gap between two barbers' cuts is open on neither", () => {
    const rows = [
      row({ staffId: "drick", start: at("16:00"), end: at("16:30") }),
      row({ staffId: "mike", start: at("19:00"), end: at("19:30") }),
    ];
    const plan = planToday(rows, NOW);
    expect(plan.schedule.some((i) => i.kind === "gap")).toBe(false);
    // 16:30 -> 19:00 is NOT 2h 30m of open time: each man has one booking.
    expect(plan.openMin).toBe(0);
  });

  it("two chairs: the number adds up each barber's OWN gaps, with no gap rows in the merged list", () => {
    const rows = [
      row({ staffId: "drick", start: at("16:00"), end: at("16:30") }),
      row({ staffId: "mike", start: at("17:00"), end: at("17:30") }),
      row({ staffId: "drick", start: at("18:00"), end: at("18:30") }),
      row({ staffId: "mike", start: at("17:45"), end: at("18:15") }),
    ];
    const plan = planToday(rows, NOW);
    // Drick: 16:30 -> 18:00 = 90. Mike: 17:30 -> 17:45 is changeover.
    expect(plan.openMin).toBe(90);
    expect(plan.schedule.some((i) => i.kind === "gap")).toBe(false);
  });

  it("two chairs: a block with nobody on it holds everyone; a booking with nobody on it makes the number unknowable", () => {
    const shopWide = [
      row({ staffId: "drick", start: at("16:00"), end: at("16:30") }),
      row({ staffId: "mike", start: at("16:00"), end: at("16:30") }),
      row({ source: "block", staffId: null, clientName: "Staff meeting", start: at("16:30"), end: at("18:00"), price: null, status: "blocked" }),
      row({ staffId: "drick", start: at("18:00"), end: at("18:30") }),
      row({ staffId: "mike", start: at("18:00"), end: at("18:30") }),
    ];
    expect(planToday(shopWide, NOW).openMin).toBe(0);

    const unplaced = [...shopWide, row({ staffId: null, start: at("20:00"), end: at("20:30") })];
    expect(planToday(unplaced, NOW).openMin).toBeNull();
  });

  it("🔴 a busy morning folds away so the list opens on what is next (seen in a 20-booking render)", () => {
    // Four done before 10:42 AM, one in the chair now, two still to come.
    const rows = [
      row({ clientName: "Early A", start: at("13:00"), end: at("13:30"), status: "completed" }),
      row({ clientName: "Early B", start: at("13:30"), end: at("14:00"), status: "completed" }),
      row({ clientName: "Early C", start: at("14:00"), end: at("14:30"), status: "no_show" }),
      // Over by the clock even before the completion sweep marks it.
      row({ clientName: "Early D", start: at("14:30"), end: at("15:00") }),
      row({ clientName: "In Chair", start: at("15:30"), end: at("16:00") }),
      row({ clientName: "Later One", start: at("16:00"), end: at("16:30") }),
      row({ clientName: "Later Two", start: at("16:30"), end: at("17:00") }),
    ];
    const plan = planToday(rows, NOW);
    expect(plan.earlierBookings).toBe(4);
    // ...plus the 15:00-15:30 gap, which is over too: history folds whole.
    expect(plan.earlier).toBe(5);
    // The fold stops at the first thing still ahead: never the one in the chair.
    expect(plan.schedule[plan.earlier]).toMatchObject({ kind: "row", row: { clientName: "In Chair" } });

    const { container } = render(<TodayAgenda rows={rows} timezone={TZ} now={NOW} />);
    const fold = container.querySelector("details")!;
    expect(fold.querySelector("summary")!.textContent).toContain("Earlier today");
    expect(fold.querySelector("summary")!.textContent).toContain("4 appointments");
    expect(fold.textContent).toContain("Early D");
    expect(fold.textContent).toContain("Open · 30m");
    expect(fold.textContent).not.toContain("In Chair");
  });

  it("two finished bookings stay in line: a quiet morning is not folded", () => {
    const plan = planToday(day(), Date.parse(at("17:00")));
    // Andre (done) and Jordan (over by the clock) are history; that is only 2.
    expect(plan.earlier).toBe(0);
    const { container } = render(<TodayAgenda rows={day()} timezone={TZ} now={Date.parse(at("17:00"))} />);
    expect(container.querySelector("details")).toBeNull();
  });

  it("a synced calendar with no prices says it does not know, not $0", () => {
    const rows = [row({ source: "visit", price: null }), row({ source: "visit", price: null })];
    expect(planToday(rows, NOW).bookedUnknown).toBe(true);
    expect(planToday([], NOW).bookedUnknown).toBe(false);
  });
});

describe("TodayAgenda", () => {
  it("shows the day's numbers, the request, who is next and the gap", () => {
    render(<TodayAgenda rows={day()} timezone={TZ} now={NOW} />);
    const stats = screen.getByText("Booked").closest("dl")!;
    expect(within(stats).getByText("$170")).toBeTruthy();
    expect(within(stats).getByText("3")).toBeTruthy();
    expect(within(stats).getByText("3h")).toBeTruthy();

    const request = screen.getByRole("link", { name: /1 request needs you/ });
    // ICU puts a narrow no-break space before PM.
    expect(request.textContent!.replace(/\u202f/g, " ")).toContain("Sofia Reyes asked for 2:30 PM");
    expect(request.getAttribute("href")).toBe("/dashboard/booking?appointment=sofia");

    expect(screen.getByText("Up next")).toBeTruthy();
    expect(screen.getByText("in 18 min")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
      "/dashboard/booking?appointment=jordan",
    );

    expect(screen.getAllByText("Open · 1h 30m")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Fill it" })).toHaveLength(2);
    expect(screen.getByText("3 appointments left today.")).toBeTruthy();
  });

  it("🔴 a past gap is history, not an invitation to fill it", () => {
    render(<TodayAgenda rows={day()} timezone={TZ} now={Date.parse(at("23:00"))} />);
    expect(screen.getAllByText("Open · 1h 30m")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Fill it" })).toBeNull();
    // The day is over: nobody is next.
    expect(screen.queryByText("Up next")).toBeNull();
  });

  it("an empty day says so, without numbers pretending otherwise", () => {
    render(<TodayAgenda rows={[]} timezone={TZ} now={NOW} />);
    expect(screen.getByText("Nothing on the books.")).toBeTruthy();
    expect(screen.queryByText("Up next")).toBeNull();
    expect(screen.queryByRole("link", { name: /request/ })).toBeNull();
  });

  it("a synced visit opens the day, since the calendar can only open a ChairBack booking", () => {
    render(
      <TodayAgenda
        rows={[row({ id: "v1", source: "visit", clientName: "Synced Sam", start: at("16:00"), end: at("16:30") })]}
        timezone={TZ}
        now={NOW}
      />,
    );
    expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/dashboard/booking?view=day");
  });
});
