import {
  BOOKED_OUT_MAX_ITEMS,
  type BookedOutBrief,
  type BookedOutItem,
} from "@chairback/config/bookedOut";
import { formatDuration } from "@chairback/config/bookingRuleUnits";

/**
 * "How do I get booked out more?" - turned into THIS shop's own list.
 *
 * Pure: facts in, a ranked brief out. services/bookedOutFacts.ts counts the
 * facts; nothing here reads a database, a clock or a model. Every rule below is
 * a written threshold over a counted number, and every sentence it produces
 * quotes the number it came from, so a barber can check it against his own
 * calendar and see why he is being told it.
 *
 * Ranking is by `weight`: the rule that moves the most bookings first. Weights
 * are judgement, written down here once rather than scattered:
 *   - empty upcoming time is the thing being asked about, so it leads;
 *   - regulars who are overdue are the cheapest bookings there are;
 *   - clients not coming back, then not enough new ones;
 *   - one weekday running empty, then no-shows (time booked but lost);
 *   - the booking page, then booking rules that turn people away.
 */

/** The numbers the rules read. Counted by services/bookedOutFacts.ts. */
export interface BookedOutFacts {
  scope: "shop" | "own";
  /** native = ChairBack takes the bookings; otherwise another system does. */
  bookingMode: "native" | "link" | "acuity" | "square";
  /**
   * Open and booked minutes over the coming 14 days, from the hours set in
   * ChairBack. Null when no hours are set here (an Acuity or link shop keeps
   * them elsewhere), so no fill figure can be honest.
   */
  upcoming: { openMin: number; bookedMin: number } | null;
  /** The same over the last 28 days. */
  past: { openMin: number; bookedMin: number } | null;
  /** Last 8 weeks by shop-local weekday (0 = Sunday). Days with no hours omitted. */
  weekdays: { weekday: number; openMin: number; bookedMin: number; days: number }[];
  /**
   * Clients whose last visit fell 6-13 weeks ago, and how many of them came
   * back within 6 weeks of it.
   */
  returning: { cohort: number; returned: number };
  /** Clients whose first-ever booking here fell in each 30-day window. */
  newClients: { last30: number; prior30: number };
  /** Past bookings in the last 60 days, and how many were no-shows. */
  noShows: { bookings: number; noShows: number };
  /** Regulars past their own usual gap with nothing booked. */
  overdueRegulars: number;
  /** The public page. Shop scope only; null for one provider's own view. */
  page: {
    publicPageEnabled: boolean;
    hasBio: boolean;
    hasHeroImage: boolean;
    galleryCount: number;
    hasInstagram: boolean;
    hasGoogleReviewUrl: boolean;
  } | null;
  /** The provider's own profile (own scope), or any provider missing one (shop scope). */
  profileMissingPhoto: number;
  booking: {
    /** Minimum notice, in MINUTES (Shop.bookingLeadMinutes). */
    leadMinutes: number;
    maxDays: number;
    waitlistEnabled: boolean;
  };
  rewardsEnabled: boolean;
  services: { total: number; unpriced: number };
}

/** The thresholds, named so a review can argue with each one. */
export const BOOKED_OUT_RULES = {
  /** Below this % of the coming 2 weeks booked, filling it is the first job. */
  lowFillPct: 60,
  /** At or above this, the shop is effectively booked out. */
  fullPct: 85,
  /** A weekday this far (points) under the best weekday is worth a fix... */
  weekdayGapPts: 25,
  /** ...as long as it is under this % itself... */
  weekdayLowPct: 45,
  /** ...and the last 8 weeks held at least this many of that weekday open. */
  weekdayMinDays: 3,
  /** Under this % of clients coming back within 6 weeks is a leak. */
  lowReturnPct: 50,
  /** Fewer clients than this in the cohort and the % means nothing. */
  minReturnCohort: 8,
  /** Fewer new clients than this in 30 days is "not enough". */
  lowNewClients: 4,
  /** ...or a fall of at least this % on the month before (from >= 5). */
  newClientsDropPct: 40,
  /** No-shows at or above this % of past bookings... */
  highNoShowPct: 8,
  /** ...out of at least this many bookings. */
  minNoShowBookings: 20,
  /** This many overdue regulars or more is worth a message. */
  minOverdue: 3,
  /** A booking window shorter than this many days turns planners away. */
  shortMaxDays: 28,
  /** A lead time longer than this many minutes (a day) turns same-day clients away. */
  longLeadMinutes: 24 * 60,
  /** Fewer gallery photos than this and the page reads as empty. */
  minGallery: 3,
} as const;

const WEEKDAY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Whole hours, never "0 hours" for a little time: "about 1 hour" at minimum. */
function hoursOf(min: number): string {
  const h = Math.max(1, Math.round(min / 60));
  return `about ${plural(h, "hour")}`;
}

type Ranked = BookedOutItem & { weight: number };

export function diagnoseBookedOut(f: BookedOutFacts): BookedOutBrief {
  const R = BOOKED_OUT_RULES;
  const items: Ranked[] = [];
  const strengths: string[] = [];
  const you = f.scope === "own" ? "you" : "your shop";

  // 1. The coming two weeks - what "booked out" literally means.
  const upPct = f.upcoming && f.upcoming.openMin > 0 ? pct(f.upcoming.bookedMin, f.upcoming.openMin) : null;
  const upOpen = f.upcoming ? Math.max(0, f.upcoming.openMin - f.upcoming.bookedMin) : 0;
  const newLow =
    f.newClients.last30 < R.lowNewClients ||
    (f.newClients.prior30 >= 5 &&
      pct(f.newClients.prior30 - f.newClients.last30, f.newClients.prior30) >= R.newClientsDropPct);

  if (f.bookingMode === "native" && f.upcoming && f.upcoming.openMin === 0) {
    items.push({
      id: "no_hours",
      weight: 120,
      title: "Open some time to book",
      finding: "Nothing is open to book in the next 2 weeks.",
      fix: "Clients can only book time you have open. Check your weekly hours and any time you blocked off.",
      action: { label: "Check your hours", featureId: "staff" },
    });
  } else if (upPct !== null && upPct < R.lowFillPct) {
    items.push({
      id: "upcoming_fill",
      weight: 100,
      title: "Fill your next two weeks",
      finding: `Your next 2 weeks are ${upPct}% booked, with ${hoursOf(upOpen)} still open.`,
      fix:
        f.overdueRegulars >= R.minOverdue
          ? "Start with the regulars who are due back (below), then send your clients a message about the open times."
          : "Send your clients a message about the open times, and post your booking link where they will see it.",
      action: { label: "Message clients", featureId: "message-clients" },
    });
  } else if (upPct !== null && upPct >= R.fullPct) {
    strengths.push(`Your next 2 weeks are ${upPct}% booked.`);
    if (!f.booking.waitlistEnabled && f.bookingMode === "native") {
      items.push({
        id: "waitlist_off",
        weight: 35,
        title: "Catch the clients you turn away",
        finding: `You're ${upPct}% booked for the next 2 weeks and the waitlist is off.`,
        fix: "Turn on the waitlist so a full day takes names, and a cancellation goes straight to the next person.",
        action: { label: "Turn on waitlist", featureId: "booking-rules" },
      });
    }
  }

  // 2. Regulars past their own usual gap, nothing booked.
  if (f.overdueRegulars >= R.minOverdue) {
    items.push({
      id: "overdue_regulars",
      weight: 80 + Math.min(f.overdueRegulars, 20),
      title: "Bring back regulars who are due",
      finding: `${plural(f.overdueRegulars, "regular client")} ${f.overdueRegulars === 1 ? "is" : "are"} past their usual gap between visits with nothing booked.`,
      fix: "They already like you. A short message with your booking link is the cheapest booking there is.",
      action: { label: "Find overdue clients", featureId: "rebook-nudges" },
    });
  }

  // 3. Clients coming back.
  const ret = f.returning;
  if (ret.cohort >= R.minReturnCohort) {
    const rp = pct(ret.returned, ret.cohort);
    if (rp < R.lowReturnPct) {
      items.push({
        id: "return_rate",
        weight: 70,
        title: "Get more clients to come back",
        finding: `${rp}% of the clients you saw 6 to 13 weeks ago came back within 6 weeks (${ret.returned} of ${ret.cohort}).`,
        fix: f.rewardsEnabled
          ? "Book their next visit before they leave, and remind them their punch card is close to a reward."
          : "Book their next visit before they leave. A punch card gives them a reason to come back to you.",
        action: f.rewardsEnabled
          ? { label: "Find overdue clients", featureId: "rebook-nudges" }
          : { label: "Set up rewards", featureId: "punch-cards" },
      });
    } else if (rp >= 60) {
      strengths.push(`${rp}% of clients came back within 6 weeks.`);
    }
  }

  // 4. New clients.
  if (newLow) {
    const finding =
      f.newClients.prior30 > f.newClients.last30
        ? `${plural(f.newClients.last30, "new client")} in the last 30 days, down from ${f.newClients.prior30} the 30 days before.`
        : `${plural(f.newClients.last30, "new client")} in the last 30 days.`;
    items.push({
      id: "new_clients",
      weight: 60,
      title: "Reach more new clients",
      finding,
      fix: "Put your booking link in your Instagram bio and your Google listing, and ask happy clients to send a friend.",
      action: { label: "Share your booking link", featureId: "qr-code" },
    });
  } else if (f.newClients.last30 >= 8) {
    strengths.push(`${f.newClients.last30} new clients in the last 30 days.`);
  }

  // 5. One weekday running empty.
  const days = f.weekdays.filter((d) => d.days >= R.weekdayMinDays && d.openMin > 0);
  if (days.length >= 2) {
    const scored = days.map((d) => ({ ...d, p: pct(d.bookedMin, d.openMin) }));
    const best = scored.reduce((a, b) => (b.p > a.p ? b : a));
    const worst = scored.reduce((a, b) => (b.p < a.p ? b : a));
    if (worst.p < R.weekdayLowPct && best.p - worst.p >= R.weekdayGapPts) {
      items.push({
        id: "slow_weekday",
        weight: 50,
        title: `Fill your ${WEEKDAY[worst.weekday]}`,
        finding: `${WEEKDAY[worst.weekday]} run ${worst.p}% booked, against ${best.p}% on ${WEEKDAY[best.weekday]}.`,
        fix: `Run a ${WEEKDAY[worst.weekday]!.slice(0, -1)} special at a set price, or move some of those hours to a busier day.`,
        action: { label: "Add a special", featureId: "targeted-slots" },
      });
    }
  }

  // 6. No-shows - time that was booked and still lost.
  if (f.noShows.bookings >= R.minNoShowBookings) {
    const np = pct(f.noShows.noShows, f.noShows.bookings);
    if (np >= R.highNoShowPct) {
      items.push({
        id: "no_shows",
        weight: 45,
        title: "Lose fewer bookings to no-shows",
        finding: `${np}% of bookings in the last 60 days were no-shows (${f.noShows.noShows} of ${f.noShows.bookings}).`,
        fix: "Ask for a card or a deposit at booking, and set a no-show fee clients see before they book.",
        action: { label: "Set booking policies", featureId: "booking-policies" },
      });
    } else if (np <= 3) {
      strengths.push(`Only ${np}% of bookings were no-shows.`);
    }
  }

  // 7. The booking page - what a new client sees before deciding.
  if (f.page) {
    const missing: string[] = [];
    if (!f.page.hasHeroImage) missing.push("a cover photo");
    if (f.page.galleryCount < R.minGallery) missing.push("photos of your work");
    if (!f.page.hasBio) missing.push("a short intro");
    if (!f.page.hasInstagram) missing.push("your Instagram");
    if (!f.page.hasGoogleReviewUrl) missing.push("a link to your Google reviews");
    if (f.page.publicPageEnabled && missing.length > 0) {
      items.push({
        id: "page_gaps",
        weight: newLow ? 58 : 40,
        title: "Finish your booking page",
        finding: `Your page is missing ${listOf(missing)}.`,
        fix: "New clients decide from your page. Photos of your work do more than anything else on it.",
        action: { label: "Edit your page", featureId: "mini-site" },
      });
    }
  }
  if (f.profileMissingPhoto > 0) {
    items.push({
      id: "profile_photo",
      weight: 30,
      title: f.scope === "own" ? "Add your photo" : "Add every provider's photo",
      finding:
        f.scope === "own"
          ? "Your profile has no photo."
          : `${plural(f.profileMissingPhoto, "provider")} ${f.profileMissingPhoto === 1 ? "has" : "have"} no photo.`,
      fix: "Clients pick a person, not a name. A photo makes them far more likely to book.",
      action: { label: "Add a photo", featureId: "staff" },
    });
  }

  // 8. Booking rules that turn people away - only where ChairBack takes the booking.
  if (f.bookingMode === "native") {
    if (f.booking.maxDays < R.shortMaxDays) {
      items.push({
        id: "short_window",
        weight: 32,
        title: "Let clients book further ahead",
        finding: `Clients can only book ${plural(f.booking.maxDays, "day")} ahead.`,
        fix: "Regulars like to lock in their next few visits. Opening 6 to 8 weeks lets them.",
        action: { label: "Change booking rules", featureId: "booking-rules" },
      });
    }
    if (f.booking.leadMinutes > R.longLeadMinutes) {
      items.push({
        id: "long_lead",
        weight: 28,
        title: "Take same-day bookings",
        finding: `Clients have to book at least ${formatDuration(f.booking.leadMinutes)} ahead.`,
        fix: "Last-minute clients go to whoever can take them today. A shorter notice time keeps them.",
        action: { label: "Change booking rules", featureId: "booking-rules" },
      });
    }
    if (f.services.unpriced > 0) {
      items.push({
        id: "unpriced",
        weight: 25,
        title: "Put prices on your services",
        finding: `${plural(f.services.unpriced, "service")} ${f.services.unpriced === 1 ? "has" : "have"} no price.`,
        fix: "People skip what they can't price. A price, even a starting one, gets them to book.",
        action: { label: "Edit services", featureId: "services" },
      });
    }
  }

  items.sort((a, b) => b.weight - a.weight);
  const shown = items.slice(0, BOOKED_OUT_MAX_ITEMS).map(({ weight: _w, ...rest }) => rest);

  return {
    scope: f.scope,
    headline: headlineFor(f, upPct, upOpen, you),
    items: shown,
    strengths: strengths.slice(0, 2),
    basis:
      f.scope === "own"
        ? "Based on your own appointments over the last 8 weeks and the next 2."
        : "Based on your shop's appointments over the last 8 weeks and the next 2.",
  };
}

function headlineFor(f: BookedOutFacts, upPct: number | null, upOpen: number, you: string): string {
  if (upPct !== null && f.upcoming && f.upcoming.openMin > 0) {
    return upPct >= BOOKED_OUT_RULES.fullPct
      ? `You're ${upPct}% booked for the next 2 weeks - close to booked out.`
      : `The next 2 weeks are ${upPct}% booked, with ${hoursOf(upOpen)} still open.`;
  }
  if (f.past && f.past.openMin > 0) {
    return `The last 4 weeks were ${pct(f.past.bookedMin, f.past.openMin)}% booked.`;
  }
  return `Here's what ${you === "you" ? "your" : "your shop's"} numbers say.`;
}

/** "a, b and c". */
function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
