import { describe, expect, it } from "vitest";
import { BOOKED_OUT_RULES, diagnoseBookedOut, type BookedOutFacts } from "./bookedOut.js";

/**
 * "How do I get booked out more?" - the rules, one at a time. Each case moves
 * ONE number across its threshold from a healthy baseline, so a rule that
 * fires on the wrong side of its line, or quotes the wrong number, goes red.
 */
const H = 60;

/** A healthy native shop: nothing should be flagged. */
function healthy(over: Partial<BookedOutFacts> = {}): BookedOutFacts {
  return {
    scope: "shop",
    bookingMode: "native",
    upcoming: { openMin: 100 * H, bookedMin: 70 * H },
    past: { openMin: 200 * H, bookedMin: 140 * H },
    weekdays: [
      { weekday: 2, openMin: 64 * H, bookedMin: 40 * H, days: 8 },
      { weekday: 6, openMin: 64 * H, bookedMin: 48 * H, days: 8 },
    ],
    returning: { cohort: 30, returned: 17 },
    newClients: { last30: 6, prior30: 6 },
    noShows: { bookings: 100, noShows: 5 },
    overdueRegulars: 1,
    page: {
      publicPageEnabled: true,
      hasBio: true,
      hasHeroImage: true,
      galleryCount: 6,
      hasInstagram: true,
      hasGoogleReviewUrl: true,
    },
    profileMissingPhoto: 0,
    booking: { leadHours: 2, maxDays: 60, waitlistEnabled: true },
    rewardsEnabled: true,
    services: { total: 5, unpriced: 0 },
    ...over,
  };
}
const ids = (f: BookedOutFacts) => diagnoseBookedOut(f).items.map((i) => i.id);
const item = (f: BookedOutFacts, id: string) => diagnoseBookedOut(f).items.find((i) => i.id === id);

describe("a healthy shop", () => {
  it("flags nothing and says how full it is", () => {
    const b = diagnoseBookedOut(healthy());
    expect(b.items).toEqual([]);
    expect(b.headline).toBe("The next 2 weeks are 70% booked, with about 30 hours still open.");
    expect(b.basis).toMatch(/last 8 weeks and the next 2/);
  });
});

describe("the coming two weeks", () => {
  it("🔴 under 60% booked leads the list, with the open hours", () => {
    const f = healthy({ upcoming: { openMin: 100 * H, bookedMin: 38 * H } });
    expect(ids(f)[0]).toBe("upcoming_fill");
    expect(item(f, "upcoming_fill")!.finding).toBe(
      "Your next 2 weeks are 38% booked, with about 62 hours still open.",
    );
    // 60% exactly is not under the line.
    expect(ids(healthy({ upcoming: { openMin: 100 * H, bookedMin: 60 * H } }))).not.toContain("upcoming_fill");
  });

  it("points at overdue regulars first when there are some", () => {
    const f = healthy({ upcoming: { openMin: 100 * H, bookedMin: 30 * H }, overdueRegulars: 7 });
    expect(item(f, "upcoming_fill")!.fix).toMatch(/regulars who are due back/);
  });

  it("booked out: a strength, and the waitlist when it is off", () => {
    const full = healthy({ upcoming: { openMin: 100 * H, bookedMin: 90 * H } });
    const b = diagnoseBookedOut(full);
    expect(b.headline).toBe("You're 90% booked for the next 2 weeks - close to booked out.");
    expect(b.strengths).toContain("Your next 2 weeks are 90% booked.");
    expect(b.items).toEqual([]);
    const noWaitlist = { ...full, booking: { ...full.booking, waitlistEnabled: false } };
    expect(ids(noWaitlist)).toEqual(["waitlist_off"]);
  });

  it("a native shop with nothing open says so, first", () => {
    const f = healthy({ upcoming: { openMin: 0, bookedMin: 0 } });
    expect(ids(f)[0]).toBe("no_hours");
  });

  it("a shop whose hours live in another system gets no fill figure, not a wrong one", () => {
    const f = healthy({ bookingMode: "acuity", upcoming: null, past: null, weekdays: [] });
    const b = diagnoseBookedOut(f);
    expect(b.items.map((i) => i.id)).not.toContain("upcoming_fill");
    expect(b.items.map((i) => i.id)).not.toContain("no_hours");
    expect(b.headline).toBe("Here's what your shop's numbers say.");
  });
});

describe("clients", () => {
  it("🔴 overdue regulars: 3 or more is worth a message, with the count", () => {
    expect(ids(healthy({ overdueRegulars: 2 }))).not.toContain("overdue_regulars");
    const f = healthy({ overdueRegulars: 12 });
    expect(item(f, "overdue_regulars")!.finding).toBe(
      "12 regular clients are past their usual gap between visits with nothing booked.",
    );
    expect(item(f, "overdue_regulars")!.action).toEqual({ label: "Find overdue clients", featureId: "rebook-nudges" });
  });

  it("coming back: under 50% of a real cohort is a leak; a tiny cohort says nothing", () => {
    const leak = healthy({ returning: { cohort: 20, returned: 7 } });
    expect(item(leak, "return_rate")!.finding).toBe(
      "35% of the clients you saw 6 to 13 weeks ago came back within 6 weeks (7 of 20).",
    );
    expect(ids(healthy({ returning: { cohort: 5, returned: 0 } }))).not.toContain("return_rate");
    expect(diagnoseBookedOut(healthy({ returning: { cohort: 20, returned: 14 } })).strengths).toContain(
      "70% of clients came back within 6 weeks.",
    );
  });

  it("coming back without rewards switched on points at setting them up", () => {
    const f = healthy({ returning: { cohort: 20, returned: 5 }, rewardsEnabled: false });
    expect(item(f, "return_rate")!.action!.featureId).toBe("punch-cards");
  });

  it("new clients: too few, or a fall of 40% on the month before", () => {
    expect(item(healthy({ newClients: { last30: 2, prior30: 2 } }), "new_clients")!.finding).toBe(
      "2 new clients in the last 30 days.",
    );
    expect(item(healthy({ newClients: { last30: 5, prior30: 10 } }), "new_clients")!.finding).toBe(
      "5 new clients in the last 30 days, down from 10 the 30 days before.",
    );
    expect(ids(healthy({ newClients: { last30: 7, prior30: 10 } }))).not.toContain("new_clients");
  });

  it("no-shows: 8% of at least 20 bookings", () => {
    expect(item(healthy({ noShows: { bookings: 50, noShows: 5 } }), "no_shows")!.finding).toBe(
      "10% of bookings in the last 60 days were no-shows (5 of 50).",
    );
    expect(ids(healthy({ noShows: { bookings: 10, noShows: 5 } }))).not.toContain("no_shows");
  });
});

describe("the week", () => {
  it("🔴 names the emptiest weekday against the best one", () => {
    const f = healthy({
      weekdays: [
        { weekday: 2, openMin: 64 * H, bookedMin: 14 * H, days: 8 },
        { weekday: 6, openMin: 64 * H, bookedMin: 54 * H, days: 8 },
      ],
    });
    const it_ = item(f, "slow_weekday")!;
    expect(it_.title).toBe("Fill your Tuesdays");
    expect(it_.finding).toBe("Tuesdays run 22% booked, against 84% on Saturdays.");
    expect(it_.fix).toMatch(/^Run a Tuesday special/);
  });

  it("ignores a weekday the shop barely opened", () => {
    const f = healthy({
      weekdays: [
        { weekday: 1, openMin: 4 * H, bookedMin: 0, days: 1 },
        { weekday: 6, openMin: 64 * H, bookedMin: 54 * H, days: 8 },
      ],
    });
    expect(ids(f)).not.toContain("slow_weekday");
  });
});

describe("the booking page and rules", () => {
  it("lists exactly what the page is missing", () => {
    const f = healthy({
      page: { publicPageEnabled: true, hasBio: false, hasHeroImage: true, galleryCount: 1, hasInstagram: false, hasGoogleReviewUrl: true },
    });
    expect(item(f, "page_gaps")!.finding).toBe(
      "Your page is missing photos of your work, a short intro and your Instagram.",
    );
  });

  it("a page gap ranks above booking rules when new clients are low", () => {
    const gaps = { publicPageEnabled: true, hasBio: false, hasHeroImage: true, galleryCount: 6, hasInstagram: true, hasGoogleReviewUrl: true };
    const f = healthy({ page: gaps, newClients: { last30: 1, prior30: 1 }, booking: { leadHours: 2, maxDays: 14, waitlistEnabled: true } });
    expect(ids(f).indexOf("page_gaps")).toBeLessThan(ids(f).indexOf("short_window"));
  });

  it("booking rules only for a shop ChairBack books for", () => {
    const tight = { leadHours: 48, maxDays: 14, waitlistEnabled: true };
    expect(ids(healthy({ booking: tight }))).toEqual(expect.arrayContaining(["short_window", "long_lead"]));
    expect(item(healthy({ booking: tight }), "short_window")!.finding).toBe("Clients can only book 14 days ahead.");
    expect(ids(healthy({ booking: tight, bookingMode: "acuity" }))).not.toContain("short_window");
  });

  it("a provider's own view: their photo, no shop page", () => {
    const f = healthy({ scope: "own", page: null, profileMissingPhoto: 1 });
    expect(item(f, "profile_photo")!.title).toBe("Add your photo");
    expect(ids(f)).not.toContain("page_gaps");
  });
});

describe("the answer as a whole", () => {
  it(`shows at most 5, the heaviest first`, () => {
    const f = healthy({
      upcoming: { openMin: 100 * H, bookedMin: 20 * H },
      overdueRegulars: 9,
      returning: { cohort: 20, returned: 4 },
      newClients: { last30: 1, prior30: 1 },
      noShows: { bookings: 50, noShows: 9 },
      booking: { leadHours: 48, maxDays: 14, waitlistEnabled: false },
      services: { total: 4, unpriced: 2 },
    });
    expect(ids(f)).toEqual(["upcoming_fill", "overdue_regulars", "return_rate", "new_clients", "no_shows"]);
  });

  it("carries no money and no client names", () => {
    const text = JSON.stringify(diagnoseBookedOut(healthy({ overdueRegulars: 5, upcoming: { openMin: 100 * H, bookedMin: 10 * H } })));
    expect(text).not.toMatch(/\$/);
  });

  it("the thresholds are the documented ones", () => {
    expect(BOOKED_OUT_RULES.lowFillPct).toBe(60);
    expect(BOOKED_OUT_RULES.fullPct).toBe(85);
  });
});
