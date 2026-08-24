import type { Prisma } from "@chairback/db";

/**
 * Keeps `Staff.userId` pointing at whoever holds that chair's seat.
 *
 * THE BUG THIS EXISTS TO FIX. Every barber-facing alert resolves its recipient
 * as `appt.staff.userId ?? shop.ownerId` — see recipientForAppointment()
 * (services/barberNotify.ts), notifyBarberBookingEvent()
 * (services/appointmentNotify.ts), the cancel/reschedule paths in
 * routes/booking.public.ts, and the next-up / day-ahead sweeps in
 * engines/barberReminders.ts. But NOTHING ever wrote that column: the staff
 * POST/PATCH schema never carried it, and the team-seats migration
 * (20260731120000_team_members) backfilled ShopMember only. So the fallback
 * fired every single time and EVERY alert in a multi-chair shop went to the
 * owner, using the OWNER's notification preferences — a barber has never once
 * been notified about their own chair.
 *
 * WHY A MIRROR RATHER THAN A JOIN. The seat→chair link already lives on
 * `ShopMember.staffId` (unique: one person per chair). `Staff.userId` is a
 * denormalized mirror of it, and it stays that way deliberately — the alert
 * paths above read `staff.userId` from a `select` they already make while
 * loading the appointment, and turning each of those into a ShopMember join
 * would add a query to every send path (including the two cron sweeps, which
 * loop over appointments). So the invariant is maintained on WRITE, in exactly
 * one place, by this module:
 *
 *   Staff.userId == the userId of the ShopMember whose staffId is that Staff,
 *                   or NULL when no seat holds the chair.
 *
 * There is deliberately no way to set it by hand: an owner links a person to a
 * chair by linking their SEAT (POST /api/team/invites with a staffId, or
 * PATCH /api/team/members/:id), and this runs as a consequence. One source of
 * truth, so the two columns cannot drift.
 *
 * NULL still means "route to the owner", which stays correct for the case it
 * was always right for: a solo shop whose single chair has no separate login.
 */

/**
 * The subset of the Prisma client this needs. Callers pass an interactive
 * transaction client where they have one (teamJoin's accept), or the plain
 * client otherwise (team.ts's seat edits) — both satisfy this.
 *
 * Plain (non-`forShop`) access is deliberate and matches the surrounding team
 * routes: ShopMember/Staff are FORCE-RLS tenant tables, the app connects as the
 * owner role which bypasses RLS, and every statement below carries an explicit
 * `shopId` in its WHERE. See the note at the top of routes/team.ts.
 */
type StaffWriter = Pick<Prisma.TransactionClient, "staff">;

export interface ChairLinkChange {
  shopId: string;
  /** The seat holder whose chair assignment is changing. */
  userId: string;
  /** The chair they held before this change (null = none). */
  previousStaffId: string | null;
  /** The chair they hold after it (null = none / seat removed). */
  nextStaffId: string | null;
}

/**
 * Apply one seat's chair change to `Staff.userId`. Safe to call when nothing
 * moved, and safe to call twice — every statement is an idempotent updateMany.
 *
 * The clear is scoped by `userId` as well as by id, so releasing a chair can
 * only ever clear a link this user actually holds. If a race has already handed
 * the chair to somebody else, their link survives instead of being wiped by the
 * departing member's write.
 */
export async function applyChairLink(
  db: StaffWriter,
  { shopId, userId, previousStaffId, nextStaffId }: ChairLinkChange,
): Promise<void> {
  if (previousStaffId === nextStaffId) {
    // No move. Still (re)assert the link when a chair is held: this is what
    // makes an accept idempotent and lets a repair path converge a row whose
    // mirror drifted before this module existed.
    if (nextStaffId !== null) {
      await db.staff.updateMany({
        where: { id: nextStaffId, shopId },
        data: { userId },
      });
    }
    return;
  }
  if (previousStaffId !== null) {
    await db.staff.updateMany({
      where: { id: previousStaffId, shopId, userId },
      data: { userId: null },
    });
  }
  if (nextStaffId !== null) {
    await db.staff.updateMany({
      where: { id: nextStaffId, shopId },
      data: { userId },
    });
  }
}

/**
 * Release whatever chair a departing seat held. Used when a member is removed
 * entirely, which is the one path with no "next" chair to move to.
 */
export async function releaseChairLink(
  db: StaffWriter,
  params: { shopId: string; userId: string; staffId: string | null },
): Promise<void> {
  await applyChairLink(db, {
    shopId: params.shopId,
    userId: params.userId,
    previousStaffId: params.staffId,
    nextStaffId: null,
  });
}
