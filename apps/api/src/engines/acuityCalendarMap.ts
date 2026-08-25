import { prisma, runWithShop } from "@chairback/db";
import { getAcuityClientForShop } from "../acuity/client.js";
import type { AcuityCalendar } from "../acuity/types.js";

/**
 * WHICH ACUITY CALENDAR IS WHICH CHAIR.
 *
 * The prerequisite for mirroring ChairBack occupancy back out to Acuity.
 * Acuity's blocks are CALENDAR-SCOPED: `POST /blocks` without a calendarID
 * lands the block on whatever calendar the account defaults to, which on a
 * multi-barber shop takes the WRONG barber off the board while leaving the
 * real conflict bookable. So the mapping is mandatory, never inferred, and
 * validated against the live account rather than trusted from the database.
 *
 * Three failure modes this module exists to make impossible:
 *
 *  1. UNMAPPED - a bookable barber with no calendar. Enforcement is refused
 *     shop-wide rather than silently mirroring only some chairs, because a
 *     half-mirrored calendar is worse than an unmirrored one: it looks
 *     protected and isn't.
 *
 *  2. STALE - the mapping predates the current OAuth connection. A reconnect
 *     can be a DIFFERENT Acuity account, where calendar id 4471 is a stranger's
 *     chair. Staleness is DERIVED (mappedAt < connectedAt), never swept: a
 *     sweep that runs late leaves a window where stale ids look fresh.
 *
 *  3. INVALID - the stored id is no longer on the account (calendar deleted or
 *     renamed away). Only a live GET /calendars can tell us, so readiness is
 *     computed against the fetched list, not against the column alone.
 */

/** A chair, with whatever mapping it currently carries. */
export interface StaffMappingRow {
  id: string;
  name: string;
  active: boolean;
  /** Genuinely bookable = active AND offering at least one active service. */
  bookable: boolean;
  acuityCalendarId: string | null;
  acuityCalendarMappedAt: Date | null;
}

export type MappingProblem = "unmapped" | "stale" | "invalid";

export interface StaffMappingStatus extends StaffMappingRow {
  /** null = nothing wrong with this chair's mapping. */
  problem: MappingProblem | null;
  /** The live calendar name, when the id still resolves. */
  calendarName: string | null;
}

export interface MappingReadiness {
  /** True only when EVERY bookable chair has a fresh, valid mapping. */
  ready: boolean;
  staff: StaffMappingStatus[];
  /** Bookable chairs blocking enforcement, in display order. */
  blocking: StaffMappingStatus[];
  /**
   * The single calendar to preselect when the shape is unambiguous: exactly
   * one bookable chair and exactly one calendar on the account. Still shown
   * for confirmation - preselected is not the same as decided.
   */
  preselectCalendarId: string | null;
}

/**
 * A mapping is stale when it was saved before the current connection began.
 * No mappedAt at all (a row mapped before this column existed) counts as
 * stale for the same reason: we cannot prove which account it referred to.
 */
export function isMappingStale(
  mappedAt: Date | null,
  connectedAt: Date | null,
): boolean {
  if (!connectedAt) return false; // not connected: staleness is not the issue
  if (!mappedAt) return true;
  return mappedAt.getTime() < connectedAt.getTime();
}

/**
 * Pure readiness math. Kept free of Prisma so every branch is unit-testable
 * without a database - this is the gate that decides whether real Acuity
 * writes are allowed, and it must be provable.
 */
export function computeMappingReadiness(input: {
  staff: StaffMappingRow[];
  calendars: AcuityCalendar[];
  connectedAt: Date | null;
}): MappingReadiness {
  const byId = new Map(input.calendars.map((c) => [c.id, c]));

  const staff: StaffMappingStatus[] = input.staff.map((s) => {
    const cal = s.acuityCalendarId ? byId.get(s.acuityCalendarId) : undefined;
    let problem: MappingProblem | null = null;
    if (!s.acuityCalendarId) problem = "unmapped";
    else if (!cal) problem = "invalid";
    else if (isMappingStale(s.acuityCalendarMappedAt, input.connectedAt)) problem = "stale";
    return { ...s, problem, calendarName: cal?.name ?? null };
  });

  // Only BOOKABLE chairs gate enforcement. An inactive barber, or one with no
  // active service, cannot receive a native booking, so there is nothing of
  // theirs to mirror and demanding a mapping would block the shop for nothing.
  const blocking = staff.filter((s) => s.bookable && s.problem !== null);

  const bookable = staff.filter((s) => s.bookable);
  const preselectCalendarId =
    bookable.length === 1 && input.calendars.length === 1 && bookable[0]!.problem !== null
      ? input.calendars[0]!.id
      : null;

  return { ready: blocking.length === 0 && bookable.length > 0, staff, blocking, preselectCalendarId };
}

/** The staff slice + connection timestamp, read under tenant scoping. */
export async function loadStaffMappingRows(shopId: string): Promise<StaffMappingRow[]> {
  return runWithShop(shopId, async (tx) => {
    const rows = await tx.staff.findMany({
      where: { shopId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        active: true,
        acuityCalendarId: true,
        acuityCalendarMappedAt: true,
        services: {
          where: { service: { active: true } },
          select: { staffId: true },
          take: 1,
        },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      bookable: s.active && s.services.length > 0,
      acuityCalendarId: s.acuityCalendarId,
      acuityCalendarMappedAt: s.acuityCalendarMappedAt,
    }));
  });
}

/**
 * Full readiness for a shop: live calendars + current mapping.
 *
 * Throws whatever the Acuity client throws (not connected / 401 / network) -
 * the caller decides how to present it. Deliberately NOT swallowed into
 * `ready: false`: "we could not ask Acuity" and "a chair is unmapped" are
 * different problems with different fixes, and collapsing them would send an
 * owner hunting for a mapping bug when the token needs reconnecting.
 */
export async function getMappingReadiness(shopId: string): Promise<MappingReadiness> {
  const [staff, conn, acuity] = await Promise.all([
    loadStaffMappingRows(shopId),
    // AcuityConnection is a secrets table with no RLS policy - plain prisma.
    prisma.acuityConnection.findUnique({
      where: { shopId },
      select: { connectedAt: true },
    }),
    getAcuityClientForShop(shopId),
  ]);
  const calendars = await acuity.listCalendars();
  return computeMappingReadiness({
    staff,
    calendars,
    connectedAt: conn?.connectedAt ?? null,
  });
}

export class CalendarNotOnAccountError extends Error {
  constructor() {
    super("calendar_not_on_account");
    this.name = "CalendarNotOnAccountError";
  }
}

/**
 * Assign a calendar to a chair.
 *
 * The id is VALIDATED against a live GET /calendars every time rather than
 * trusted from the request: the mapping is what points an outbound block at a
 * human being's day, and a typo'd or copy-pasted id from another account would
 * silently blank the wrong barber's availability. Passing null clears it.
 *
 * Stamps mappedAt = now, which is also what clears the stale flag - so
 * re-saving the same id after a reconnect is the documented way to re-attest
 * a mapping without changing it.
 */
export async function setStaffCalendar(
  shopId: string,
  staffId: string,
  calendarId: string | null,
): Promise<void> {
  if (calendarId !== null) {
    const acuity = await getAcuityClientForShop(shopId);
    const calendars = await acuity.listCalendars();
    if (!calendars.some((c) => c.id === calendarId)) {
      throw new CalendarNotOnAccountError();
    }
  }
  await runWithShop(shopId, async (tx) => {
    await tx.staff.updateMany({
      where: { id: staffId, shopId },
      data: {
        acuityCalendarId: calendarId,
        acuityCalendarMappedAt: calendarId === null ? null : new Date(),
      },
    });
  });
}
