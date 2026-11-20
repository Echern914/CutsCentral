import { forShop, runWithShop } from "@chairback/db";
import {
  TARGETED_SLOT_ORIGIN,
  specialKindOf,
  specialKinds,
  type SpecialKind,
} from "../engines/specialBooking.js";

/**
 * One person's bookings for one shop-local day, as their own home screen and
 * their own calendar show them.
 *
 * Moved out of routes/barber.ts so "today" (GET /api/barber/home) and "any
 * day" (GET /api/barber/calendar/day) are the same read with the same fields.
 *
 * 🔴 The staff id is the caller's to supply, and the caller must take it from
 * the session (`req.shopStaffId`), never from the request. Nothing here can be
 * widened to a second person: the filter is `staffId` equality.
 *
 * What is deliberately NOT in a row: what was paid, how, tips, the client's
 * phone or email, or anything about the shop's takings. The price is the price
 * of this one booking, which the person doing it has always been shown.
 */

/** Statuses that no longer take up the time. */
const CLOSED = new Set(["CANCELED", "NO_SHOW"]);

export interface ChairDayRow {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  closed: boolean;
  clientName: string;
  service: string;
  color: string | null;
  checkInStatus: string | null;
  etaMinutes: number | null;
  runningLate: boolean;
  price: string | null;
  special?: boolean;
  afterHours?: boolean;
  premium?: boolean;
}

/** "YYYY-MM-DD" for an instant, in the given zone. */
export function dayKeyIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export async function readChairDay(input: {
  shopId: string;
  staffId: string;
  timezone: string;
  /** A window that contains the day. It may be wider: rows are narrowed to `day`. */
  from: Date;
  to: Date;
  /** The shop-local day to keep, "YYYY-MM-DD". */
  day: string;
}): Promise<ChairDayRow[]> {
  const { shopId, staffId, timezone, from, to, day } = input;
  const rows = (await forShop(shopId).appointment.findMany({
    where: {
      staffId,
      startsAt: { gte: from, lte: to },
      // AI-receptionist holds aren't real bookings yet; keep them off the book.
      holdExpiresAt: null,
    },
    orderBy: { startsAt: "asc" },
    take: 200,
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      firstName: true,
      lastName: true,
      checkInStatus: true,
      etaMinutes: true,
      runningLate: true,
      priceAtBooking: true,
      staffId: true,
      bookedVia: true,
      service: { select: { name: true, color: true } },
    },
  })) as unknown as {
    id: string;
    status: string;
    startsAt: Date;
    endsAt: Date;
    firstName: string;
    lastName: string | null;
    checkInStatus: string | null;
    etaMinutes: number | null;
    runningLate: boolean | null;
    priceAtBooking: { toString(): string } | null;
    staffId: string;
    bookedVia: string | null;
    service: { name: string; color: string | null };
  }[];

  // Narrow to the SHOP's calendar day. A caller that does not know the shop's
  // timezone yet sends a generous window, so the raw rows can span three local
  // days - returning them all under one day's heading would list tomorrow's
  // 2pm under today. Comparing en-CA ("YYYY-MM-DD") renderings in the shop zone
  // keeps this off the server's own clock, which would roll over at the wrong
  // midnight.
  const kept = rows.filter((r) => dayKeyIn(timezone, r.startsAt) === day);

  // A booking into one of his specials carries the same "After hours" /
  // "Special" chip the owner's calendar shows (engines/specialBooking.ts). The
  // hours read runs only when the day actually holds a special.
  const specials: Map<string, SpecialKind> = kept.some((r) => r.bookedVia === TARGETED_SLOT_ORIGIN)
    ? await runWithShop(shopId, (tx) => specialKinds(tx, shopId, timezone, kept))
    : new Map();

  return kept.map((r) => ({
    id: r.id,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    status: r.status,
    closed: CLOSED.has(r.status),
    clientName: [r.firstName, r.lastName].filter(Boolean).join(" ").trim(),
    service: r.service.name,
    color: r.service.color,
    checkInStatus: r.checkInStatus,
    etaMinutes: r.etaMinutes,
    runningLate: Boolean(r.runningLate),
    // Decimal doesn't survive JSON as a number.
    price: r.priceAtBooking?.toString() ?? null,
    ...specialKindOf(specials, r.id),
  }));
}
