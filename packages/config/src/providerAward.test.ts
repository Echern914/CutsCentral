import { describe, expect, it } from "vitest";
import {
  awardIsShowing,
  awardMonthKey,
  awardTitle,
  isMonthKey,
  monthLabel,
  previousMonthKey,
} from "./providerAward.js";

describe("provider of the month", () => {
  it("names the month an award belongs to, and the one before", () => {
    expect(awardMonthKey(new Date("2026-10-17T15:00:00Z"))).toBe("2026-10");
    expect(previousMonthKey("2026-10")).toBe("2026-09");
    expect(previousMonthKey("2027-01")).toBe("2026-12");
    expect(monthLabel("2026-10")).toBe("October 2026");
  });

  it("is called by the shop's own word for who does the work", () => {
    expect(awardTitle("barber")).toBe("Barber of the Month");
    expect(awardTitle("stylist")).toBe("Stylist of the Month");
    expect(awardTitle("nail tech")).toBe("Nail Tech of the Month");
    expect(awardTitle("lash artist")).toBe("Lash Artist of the Month");
  });

  it("🔴 shows through its month and the whole month after - then stops", () => {
    expect(awardIsShowing("2026-10", new Date("2026-10-17T12:00:00Z"))).toBe(true);
    expect(awardIsShowing("2026-10", new Date("2026-11-30T12:00:00Z"))).toBe(true);
    expect(awardIsShowing("2026-10", new Date("2026-12-01T12:00:00Z"))).toBe(false);
    expect(awardIsShowing("2026-11", new Date("2026-10-17T12:00:00Z"))).toBe(false);
  });

  it("only takes a real month", () => {
    expect(isMonthKey("2026-10")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("October")).toBe(false);
  });
});
