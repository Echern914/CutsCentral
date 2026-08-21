import { Prisma } from "@chairback/db";
import { zonedDateParts, zonedWallTimeToUtc } from "@chairback/config";

/**
 * "Only three retwists on a Sunday."
 *
 * A per-service, per-weekday ceiling on how many of one service may be booked
 * on a single SHOP-LOCAL day. Replaces ServiceGroup.maxPerDay, which was one
 * number shared across a whole group and identical on every day of the week -
 * so the sentence above could not be expressed at all.
 *
 * Everything about the cap lives here so the read path (which hides the slots)
 * and the write path (which refuses the booking) can never disagree about what
 * counts. They disagreeing is the classic version of this bug: slots vanish but
 * a crafted POST still books, or the last slot shows as free and then errors.
 *
 * WHAT COUNTS. BOOKED and PENDING, hold-aware - the same predicate the group
 * cap and the overlap guard already use:
 *   - CANCELED never counts. A cancellation must give the day back, or one
 *     no-show permanently costs a Saturday slot.
 *   - PENDING counts. An approval request or an active receptionist hold owns
 *     its place in the day exactly as it owns its slot; if it didn't, a shop
 *     using request-before-booking could take unlimited requests against a cap
 *     of three.
 *   - An EXPIRED hold does NOT count. The place was released the moment the
 *     hold lapsed; the sweep that flips it to CANCELED is hygiene, not
 *     correctness.
 *   - COMPLETED and NO_SHOW do not count. Both are terminal states on days
 *     that have already happened, and a cap is about what may still be taken.
 *
 * WHICH DAY. The shop's own timezone, resolved at the instant itself, so the
 * day a booking falls on is the day the barber and the customer would both
 * name - not UTC's. An 8pm booking in Los Angeles is Sunday there and Monday
 * in UTC; counting it against Monday would let a Sunday cap of 3 take a
 * fourth. DST-correct by construction (see zonedWallTimeToUtc).
 */

/** {weekday 0-6 -> max bookings}. A weekday absent means unlimited. */
export type DailyLimits = Partial<Record<number, number>>;

/**
 * Read the stored blob defensively. It is a Json column, so it can hold
 * anything an older build or a hand-edit left there; anything that is not a
 * positive whole number on a real weekday is ignored rather than trusted.
 *
 * 🔴 A stored 0 is treated as UNLIMITED, not as "zero allowed". The control
 * this replaced used 0 to mean "no cap" in its editor, and a 0 that leaked
 * through would otherwise make a service silently unbookable forever. The
 * migration skips zeros for the same reason and the API floor is 1, so this is
 * the third and last line of that defence.
 */
export function parseDailyLimits(raw: unknown): DailyLimits {
  const out: DailyLimits = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const weekday = Number(key);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const n = Math.floor(value);
    if (n < 1) continue; // 0 or negative == unlimited, never "closed"
    out[weekday] = n;
  }
  return out;
}

/** The cap for one weekday, or null when that day is uncapped. */
export function limitForWeekday(limits: DailyLimits, weekday: number): number | null {
  return limits[weekday] ?? null;
}

/** True when no day carries a cap - lets both paths skip all the work. */
export function hasAnyLimit(limits: DailyLimits): boolean {
  return Object.keys(limits).length > 0;
}

/**
 * The shop-local calendar day containing `at`, as a half-open UTC range plus
 * the weekday it falls on.
 */
export function shopLocalDayWindow(
  at: Date,
  timezone: string,
): { start: Date; end: Date; weekday: number; key: string } {
  const p = zonedDateParts(at, timezone);
  return {
    // day + 1 is safe: Date.UTC rolls a 32nd into the next month.
    start: zonedWallTimeToUtc(p.year, p.month0, p.day, 0, timezone),
    end: zonedWallTimeToUtc(p.year, p.month0, p.day + 1, 0, timezone),
    weekday: p.weekday,
    key: `${p.year}-${p.month0}-${p.day}`,
  };
}

/**
 * The Prisma predicate for "this booking consumes a place in its day".
 *
 * Exported so the read path and the write path literally share it. Written
 * once, applied twice.
 */
export function consumesCapacityWhere(now: Date) {
  return {
    // Widened, not `as const`: Prisma's generated filter wants a mutable array.
    status: { in: ["BOOKED", "PENDING"] as ("BOOKED" | "PENDING")[] },
    // An expired hold has already released its place.
    AND: [{ OR: [{ holdExpiresAt: null }, { holdExpiresAt: { gt: now } }] }],
  };
}

/** Thrown when the requested day is already full for this service. */
export class ServiceDayFullError extends Error {
  readonly weekday: number;
  readonly limit: number;
  constructor(weekday: number, limit: number) {
    // "day_full" is a stable code for the route layer to map to a 409.
    super("day_full");
    this.name = "ServiceDayFullError";
    this.weekday = weekday;
    this.limit = limit;
  }
}

/**
 * WRITE PATH. Take a place in the day for `serviceId` on the day containing
 * `startsAt`, or throw.
 *
 * Must run INSIDE the caller's transaction, alongside
 * lockStaffAndAssertSlotFree.
 *
 * 🔑 WHY A SECOND LOCK. The existing guard serializes on `appt:<staffId>` -
 * one barber's calendar. A per-service daily cap is a different resource: two
 * barbers taking the last Sunday retwist at the same moment hold DIFFERENT
 * staff locks, so both would read count == limit-1 and both would commit. This
 * takes a lock keyed on (service, shop-local day), which is exactly the thing
 * being contended, so the second writer blocks until the first commits and
 * then re-counts and loses. That closes the overshoot the group cap documents
 * as an accepted residual race.
 *
 * LOCK ORDER. This lock is always taken BEFORE the staff lock at every call
 * site. Two locks acquired in a consistent order across all writers cannot
 * deadlock; taking them in different orders in different places is how you get
 * one at 2am.
 */
export async function assertServiceDayHasRoom(
  tx: Prisma.TransactionClient,
  opts: {
    shopId: string;
    serviceId: string;
    /** Service.dailyLimits, straight off the row. */
    dailyLimits: unknown;
    /** Shop.timezone - which day this booking lands on. */
    timezone: string;
    startsAt: Date;
    /** Reschedule/approve re-checking its own row. */
    excludeAppointmentId?: string;
    now?: Date;
  },
): Promise<void> {
  const limits = parseDailyLimits(opts.dailyLimits);
  if (!hasAnyLimit(limits)) return; // nothing configured: no lock, no count

  const day = shopLocalDayWindow(opts.startsAt, opts.timezone);
  const limit = limitForWeekday(limits, day.weekday);
  if (limit === null) return; // this weekday is uncapped

  // Serialize every writer contending for THIS service on THIS day.
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`svcday:${opts.serviceId}:${day.key}`}))`,
  );

  const now = opts.now ?? new Date();
  const taken = await tx.appointment.count({
    where: {
      shopId: opts.shopId,
      serviceId: opts.serviceId,
      ...consumesCapacityWhere(now),
      startsAt: { gte: day.start, lt: day.end },
      ...(opts.excludeAppointmentId ? { id: { not: opts.excludeAppointmentId } } : {}),
    },
  });

  if (taken >= limit) throw new ServiceDayFullError(day.weekday, limit);
}

/**
 * READ PATH. Which shop-local days in a window are already full for this
 * service, as day keys matching shopLocalDayWindow().key.
 *
 * One query for the whole range rather than one per candidate slot: the slot
 * grid can offer hundreds of candidates across a month and they collapse into
 * a few dozen days.
 */
export async function fullDaysForService(
  tx: Prisma.TransactionClient,
  opts: {
    shopId: string;
    serviceId: string;
    dailyLimits: unknown;
    timezone: string;
    rangeStart: Date;
    rangeEnd: Date;
    excludeAppointmentId?: string;
    now?: Date;
  },
): Promise<Set<string>> {
  const full = new Set<string>();
  const limits = parseDailyLimits(opts.dailyLimits);
  if (!hasAnyLimit(limits)) return full;

  const now = opts.now ?? new Date();
  const rows = await tx.appointment.findMany({
    where: {
      shopId: opts.shopId,
      serviceId: opts.serviceId,
      ...consumesCapacityWhere(now),
      // Padded by a day on each side so a booking that is inside the shop-local
      // day but outside the UTC range still counts toward that day's total.
      startsAt: {
        gte: new Date(opts.rangeStart.getTime() - 86_400_000),
        lt: new Date(opts.rangeEnd.getTime() + 86_400_000),
      },
      ...(opts.excludeAppointmentId ? { id: { not: opts.excludeAppointmentId } } : {}),
    },
    select: { startsAt: true },
  });

  const perDay = new Map<string, number>();
  for (const row of rows) {
    const day = shopLocalDayWindow(row.startsAt, opts.timezone);
    perDay.set(day.key, (perDay.get(day.key) ?? 0) + 1);
  }
  for (const [key, count] of perDay) {
    // Recover the weekday from the key rather than re-deriving from an
    // instant: the key already encodes the shop-local calendar date.
    const [y, m0, d] = key.split("-").map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(y, m0, d)).getUTCDay();
    const limit = limitForWeekday(limits, weekday);
    if (limit !== null && count >= limit) full.add(key);
  }
  return full;
}
