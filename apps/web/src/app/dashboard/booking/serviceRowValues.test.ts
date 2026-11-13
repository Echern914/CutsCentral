import { describe, expect, it } from "vitest";
import type { ServiceRow } from "./page";
import {
  addOnsValue,
  byDayValue,
  byTimeValue,
  colorValue,
  datePricesValue,
  detailsValue,
  duplicatePayload,
  fewOf,
  limitsValue,
  whoValue,
} from "./serviceRowValues";

/**
 * Each row on a service's page says what the setting is set to. These are
 * the words, and they have to stay SHORT: a row has room for a few of them
 * beside its label on a phone.
 */

describe("fewOf", () => {
  it("lists two, then counts the rest", () => {
    expect(fewOf(["a"])).toBe("a");
    expect(fewOf(["a", "b"])).toBe("a, b");
    expect(fewOf(["a", "b", "c", "d"])).toBe("a, b +2");
    expect(fewOf(["a", "b", "c"], 1)).toBe("a +2");
  });
});

describe("who does it", () => {
  it("says Everyone, the names, or that nobody is picked", () => {
    expect(whoValue(true, ["Dee"])).toBe("Everyone");
    expect(whoValue(false, ["Dee", "Sam"])).toBe("Dee, Sam");
    expect(whoValue(false, ["Dee", "Sam", "Kai"])).toBe("Dee, Sam +1");
    expect(whoValue(false, [])).toBe("Nobody picked");
  });
});

describe("description and photo", () => {
  it("says which of the two is there", () => {
    expect(detailsValue("A cut", "https://x/y.jpg")).toBe("Description and photo");
    expect(detailsValue("A cut", "")).toBe("Description");
    expect(detailsValue("  ", "https://x/y.jpg")).toBe("Photo");
    expect(detailsValue("", "")).toBe("None");
  });
});

describe("calendar color", () => {
  it("names the color, and says None for none or one it does not know", () => {
    expect(colorValue("green")).toBe("Green");
    expect(colorValue(null)).toBe("None");
    expect(colorValue("chartreuse")).toBe("None");
  });
});

describe("most per day", () => {
  it("says No limit when every day is blank", () => {
    expect(limitsValue({})).toBe("No limit");
    expect(limitsValue({ 3: "  " })).toBe("No limit");
  });

  it("names the days that have one, in week order", () => {
    expect(limitsValue({ 6: "8", 0: "4" })).toBe("Sun 4, Sat 8");
    expect(limitsValue({ 6: "8", 0: "4", 5: "6" })).toBe("Sun 4, Fri 6 +1");
  });
});

describe("by day of the week", () => {
  it("says the same every day when nothing differs", () => {
    expect(byDayValue({}, {})).toBe("Same every day");
  });

  it("names a day's price, its length, or both", () => {
    expect(byDayValue({ 0: "55" }, {})).toBe("Sun $55");
    expect(byDayValue({}, { 5: "20" })).toBe("Fri 20 min");
    expect(byDayValue({ 0: "55" }, { 0: "20" })).toBe("Sun $55 / 20 min");
  });

  it("shows the first day and counts the others", () => {
    expect(byDayValue({ 0: "55", 6: "60" }, { 5: "20" })).toBe("Sun $55 +2");
  });
});

describe("by time of day", () => {
  const row = (over: Partial<{ start: string; end: string; price: string; durationMin: string }> = {}) => ({
    start: "21:00",
    end: "23:00",
    price: "60",
    durationMin: "",
    ...over,
  });

  it("says None with no windows", () => {
    expect(byTimeValue([])).toBe("None");
  });

  it("reads the window as a barber would say it", () => {
    expect(byTimeValue([row()])).toBe("9 PM-11 PM $60");
    expect(byTimeValue([row({ start: "09:30", end: "12:00", price: "", durationMin: "20" })])).toBe(
      "9:30 AM-12 PM 20 min",
    );
    expect(byTimeValue([row({ end: "24:00" })])).toBe("9 PM-midnight $60");
    expect(byTimeValue([row({ start: "00:00", end: "06:00" })])).toBe("12 AM-6 AM $60");
  });

  it("a window with nothing typed yet is still shown", () => {
    expect(byTimeValue([row({ price: "" })])).toBe("9 PM-11 PM");
  });

  it("shows the first window and counts the others", () => {
    expect(byTimeValue([row(), row({ start: "06:00", end: "08:00" })])).toBe("9 PM-11 PM $60 +1");
  });
});

describe("a price on one date", () => {
  const today = "2026-11-12";

  it("says None when there is none ahead", () => {
    expect(datePricesValue([], today)).toBe("None");
    expect(datePricesValue([{ date: "2026-11-01", price: "60" }], today)).toBe("None");
  });

  it("shows the soonest date and counts the others", () => {
    expect(
      datePricesValue(
        [
          { date: "2026-12-24", price: "80" },
          { date: "2026-11-26", price: "60" },
        ],
        today,
      ),
    ).toBe("Nov 26 $60 +1");
  });

  it("today still counts, and a half-typed row does not", () => {
    expect(
      datePricesValue(
        [
          { date: "2026-11-12", price: "50" },
          { date: "2026-11-20", price: "" },
          { date: "", price: "70" },
        ],
        today,
      ),
    ).toBe("Nov 12 $50");
  });
});

describe("add-ons", () => {
  const addOn = (name: string, serviceIds: string[], active = true) => ({ name, serviceIds, active });

  it("names the ones offered with this service", () => {
    expect(
      addOnsValue([addOn("Beard trim", []), addOn("Design", ["svc1"]), addOn("Wash", ["other"])], "svc1"),
    ).toBe("Beard trim, Design");
  });

  it("leaves out one that is turned off", () => {
    expect(addOnsValue([addOn("Beard trim", [], false)], "svc1")).toBe("None");
  });
});

describe("a copy of a service", () => {
  const svc: ServiceRow = {
    id: "svc1",
    name: "Retwist",
    description: null,
    imageUrl: null,
    durationMin: 90,
    price: 120,
    priceOverrides: { "0": 140 },
    dateOverrides: { "2099-12-24": 150 },
    durationOverrides: {},
    dailyLimits: { "5": 2 },
    hoursWindows: {},
    timeOverrides: [],
    color: "green",
    offeredByAll: false,
    active: true,
    visibility: "hidden",
    sortOrder: 0,
    dailyTarget: null,
    staffIds: ["st1"],
    serviceGroupId: "g1",
  };

  it("🔴 a hidden service's copy is hidden: the API would make it public", () => {
    expect(duplicatePayload(svc).visibility).toBe("hidden");
    expect(duplicatePayload({ ...svc, visibility: "public" }).visibility).toBe("public");
  });

  it("carries the prices, limits and who does it", () => {
    expect(duplicatePayload(svc)).toMatchObject({
      name: "Retwist copy",
      durationMin: 90,
      price: 120,
      priceOverrides: { "0": 140 },
      dateOverrides: { "2099-12-24": 150 },
      dailyLimits: { "5": 2 },
      color: "green",
      staffIds: ["st1"],
    });
  });

  it("does NOT join the original's group", () => {
    expect(duplicatePayload(svc)).not.toHaveProperty("serviceGroupId");
  });

  it("offered by everyone stays offered by everyone, including staff added later", () => {
    const copy = duplicatePayload({ ...svc, offeredByAll: true });
    expect(copy.offeredByAll).toBe(true);
    expect(copy.staffIds).toBeUndefined();
  });

  it("a very long name still fits the column", () => {
    const copy = duplicatePayload({ ...svc, name: "x".repeat(120) });
    expect(copy.name.length).toBeLessThanOrEqual(120);
    expect(copy.name.endsWith(" copy")).toBe(true);
  });
});
