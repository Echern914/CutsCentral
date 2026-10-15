import { Prisma, prisma, runWithShop } from "@chairback/db";
import { releaseForAppointment } from "./acuityMirror.js";
import { lockStaffCalendars, lockStaffsAndAssertPartyFree } from "./bookingWrite.js";
import { sendGroupConfirmationOnce } from "./appointmentGroupSettle.js";

/**
 * A PARTY AT A REQUEST-BEFORE-BOOKING SHOP IS ONE REQUEST.
 *
 * A shop with `requireBookingApproval` gets every online booking as a request
 * the shop accepts or turns down. A party booked there arrives the same way:
 * every member PENDING, no confirmation, the shop alerted once. This file is
 * the shop's answer to it.
 *
 * 🔴 THE ANSWER IS FOR THE WHOLE PARTY, whichever member's card was tapped:
 *
 *  - A party is asked for as one visit and written all-or-nothing. Approving
 *    one member would leave a family half booked - told nothing, or told that
 *    two of three chairs are theirs - which is the partial success the feature
 *    exists to make impossible.
 *  - It is also the only answer that works. The single approve re-checks one
 *    row against every BOOKED row with the shop's turnover buffer on both
 *    sides; approving member 2 after member 1 would find member 1 back to back
 *    with it, inside that buffer, and refuse. The party is checked as the
 *    create path checks it: one combined run per chair, its own rows excluded.
 *  - The client hears once, for everybody: the party's ONE confirmation
 *    (appointmentGroupSettle.ts), never one per member.
 *
 * A shop that wants only part of a party approves it and then cancels the one
 * member who is not coming, which is the ordinary cancel with all of its
 * consequences.
 */

/** Live members of a party still waiting for the shop - never a payment hold. */
const AWAITING = { status: "PENDING" as const, holdExpiresAt: null };

/**
 * Approve every member of a party request, inside the caller's transaction.
 *
 * All or none: each member is checked on its OWN chair (a member the shop
 * moved to another provider is checked there), every chair is locked before
 * any is checked, and nothing flips until all of them have answered. Throws
 * whatever the guard throws (SlotTakenError, ExternalBlockError) - with
 * nothing written.
 *
 * Returns the ids it approved; empty means there was nothing left to approve
 * (already approved or declined - idempotent, like the single approve).
 */
export async function approvePartyInTx(
  tx: Prisma.TransactionClient,
  params: { shopId: string; groupId: string; bufferMin: number },
): Promise<string[]> {
  const { shopId, groupId } = params;
  const members = await tx.appointment.findMany({
    where: { shopId, groupId, ...AWAITING },
    select: { id: true, staffId: true, startsAt: true, endsAt: true, serviceId: true },
  });
  if (members.length === 0) return [];
  // Every row of the party, whatever its status, is out of its own way.
  const partyIds = (
    await tx.appointment.findMany({ where: { shopId, groupId }, select: { id: true } })
  ).map((r) => r.id);

  await lockStaffsAndAssertPartyFree(tx, members, {
    shopId,
    bufferMin: params.bufferMin,
    excludeAppointmentIds: partyIds,
    // Approve-path parity (booking.dashboard.ts): the rows being approved are
    // themselves PENDING, and a conflicting PENDING failed its own create guard.
    statuses: ["BOOKED"],
    // The same answers the single approve gives, for the same reasons: no
    // override step here, the shop's own automation yields, the cap was paid
    // when the request was made, and a walk-in projection does not refuse the
    // shop's own decision.
    externalBlocks: "enforce",
    walkInCapacity: "ignore",
    // The barber's own hand: his own blocked time does not stop him (bookingWrite.ts `nativeBlocks`).
    nativeBlocks: "ignore",
    serviceDayLimit: null,
    overrideWaitlistHolds: true,
  });

  const ids = members.map((m) => m.id);
  const flipped = await tx.appointment.updateMany({
    where: { id: { in: ids }, shopId, ...AWAITING },
    data: { status: "BOOKED" },
  });
  if (flipped.count === 0) return [];
  // Part of the party changed under us. Roll the whole thing back rather than
  // approve some of it - the shop can tap again and get a straight answer.
  if (flipped.count !== ids.length) throw new PartyChangedError();
  return ids;
}

/** A party's members changed between being read and being approved. */
export class PartyChangedError extends Error {
  constructor() {
    super("party_changed");
    this.name = "PartyChangedError";
  }
}

/**
 * The confirmation an approved party is owed: ONE, for everybody.
 *
 * Held while the party's calendar mirror is still unresolved
 * (`mirrorPendingSince`): the settle sweep confirms it once every block is
 * proven, exactly as for a party that never needed approval. Otherwise it is
 * claimed now, through the same once-only marker every party uses.
 */
export async function confirmApprovedParty(
  shopId: string,
  groupId: string,
  now = new Date(),
): Promise<boolean> {
  const group = await prisma.appointmentGroup.findFirst({
    where: { id: groupId, shopId },
    select: { status: true, mirrorPendingSince: true },
  });
  if (!group || group.status !== "ACTIVE" || group.mirrorPendingSince !== null) return false;
  return sendGroupConfirmationOnce(shopId, groupId, now);
}

/**
 * Turn down a whole party request. The same LIGHT flip a single decline makes
 * - nothing was ever confirmed, so there is no refund, no cancellation email
 * and no "a slot opened" blast - applied to every member still waiting, and
 * the party itself ends when nobody in it is booked.
 *
 * Takes the party's chairs' locks first, in the same order approve does, so
 * an approve and a decline of the same party cannot interleave into half of
 * each. Returns the ids it declined.
 */
export async function declineParty(
  shopId: string,
  groupId: string,
  now = new Date(),
): Promise<string[]> {
  const declined = await runWithShop(shopId, async (tx) => {
    const chairs = await tx.appointment.findMany({
      where: { shopId, groupId, ...AWAITING },
      select: { staffId: true },
    });
    if (chairs.length === 0) return [];
    await lockStaffCalendars(
      tx,
      chairs.map((c) => c.staffId),
    );
    // Re-read under the locks: this is the set that is actually declined.
    const members = await tx.appointment.findMany({
      where: { shopId, groupId, ...AWAITING },
      select: { id: true },
    });
    const ids = members.map((m) => m.id);
    if (ids.length === 0) return [];
    await tx.appointment.updateMany({
      where: { id: { in: ids }, shopId, ...AWAITING },
      data: { status: "CANCELED", canceledAt: now },
    });
    const stillBooked = await tx.appointment.count({
      where: { shopId, groupId, status: "BOOKED" },
    });
    if (stillBooked === 0) {
      await tx.appointmentGroup.updateMany({
        where: { id: groupId, shopId, status: "ACTIVE" },
        data: { status: "CANCELED", canceledAt: now },
      });
    }
    // The same release a single decline makes: a request that claimed a
    // special hands it back.
    await tx.targetedSlot.updateMany({
      where: { shopId, bookedAppointmentId: { in: ids } },
      data: { bookedAppointmentId: null },
    });
    return ids;
  });
  // A request is mirrored (it holds the chairs), so turning it down hands the
  // times back on the Acuity side too. Fire-and-forget, like a single decline:
  // the reconciler retries any release that does not confirm.
  for (const id of declined) void releaseForAppointment(shopId, id).catch(() => {});
  return declined;
}
