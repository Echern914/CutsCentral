import { asOwnerWithin, forShop, runWithShop } from "@chairback/db";
import { recomputeCadence } from "../engines/cadence.js";
import { toE164 } from "../acuity/clientKey.js";
import { settleLinksForMerge } from "./customerIdentity.js";

/**
 * Barber edits to a client's own profile. The barber is admin over their book:
 * they can fix a misspelled name, correct a phone/email, and soft-archive (hide)
 * or restore a client.
 *
 * Two deliberate non-actions:
 *  - Editing phone/email does NOT rewrite acuityClientKey. That key is the SYNC
 *    identity (how Acuity re-finds this row on the next booking, the idempotent
 *    upsert anchor) - repointing it on a display-field correction would risk a
 *    future booking forking into a duplicate or colliding with another row. The
 *    add-client upsert's update path already leaves the key alone for the same
 *    reason; we keep phone/email as the contact fields and the key as the anchor.
 *  - Editing does NOT touch SMS consent. Consent has its own attestation path
 *    (bulk attestConsent / the join page); a profile edit must never fabricate or
 *    clear it. Correcting a phone keeps the prior consent record intact.
 */

export interface EditClientInput {
  firstName?: string;
  /** "" clears the last name; undefined leaves it unchanged. */
  lastName?: string | null;
  /** "" clears; a non-empty value must parse to E.164 or the edit is refused. */
  phone?: string | null;
  /** "" clears; undefined leaves unchanged. */
  email?: string | null;
}

export type EditClientResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_phone" };

/**
 * Update a client's name / phone / email. A supplied-but-unparseable phone is
 * refused (same rule as add-client): silently storing null would make the barber
 * think the client is reachable when they never will be. An explicit empty string
 * clears the field.
 */
export async function editClient(
  shopId: string,
  clientId: string,
  input: EditClientInput,
): Promise<EditClientResult> {
  const db = forShop(shopId);
  const client = await db.client.findFirst({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "not_found" };

  const data: Record<string, unknown> = {};

  if (input.firstName !== undefined) data.firstName = input.firstName;

  if (input.lastName !== undefined) {
    data.lastName = input.lastName ? input.lastName : null;
  }

  if (input.phone !== undefined) {
    const raw = (input.phone ?? "").trim();
    if (raw === "") {
      data.phone = null;
    } else {
      const e164 = toE164(raw);
      if (!e164) return { ok: false, reason: "invalid_phone" };
      data.phone = e164;
    }
  }

  if (input.email !== undefined) {
    const e = (input.email ?? "").trim().toLowerCase();
    data.email = e === "" ? null : e;
  }

  // Nothing to change (all fields omitted) - treat as a no-op success.
  if (Object.keys(data).length === 0) return { ok: true };

  await db.client.update({ where: { id: client.id }, data });
  return { ok: true };
}

export type ArchiveResult =
  | { ok: true; archived: boolean }
  | { ok: false; reason: "not_found" };

/**
 * Soft-archive a client: stamp archivedAt so it drops out of every active surface
 * (clients list default, stats, leaderboard, at-risk, all SMS sends) without
 * destroying any visits / ledger / nudge history. Idempotent: archiving an
 * already-archived client keeps the original archivedAt.
 */
export async function archiveClient(
  shopId: string,
  clientId: string,
): Promise<ArchiveResult> {
  const db = forShop(shopId);
  const client = await db.client.findFirst({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "not_found" };
  if (client.archivedAt === null) {
    await db.client.update({
      where: { id: client.id },
      data: { archivedAt: new Date() },
    });
  }
  return { ok: true, archived: true };
}

/** Restore an archived client back into the active book (clears archivedAt). */
export async function unarchiveClient(
  shopId: string,
  clientId: string,
): Promise<ArchiveResult> {
  const db = forShop(shopId);
  const client = await db.client.findFirst({ where: { id: clientId } });
  if (!client) return { ok: false, reason: "not_found" };
  if (client.archivedAt !== null) {
    await db.client.update({
      where: { id: client.id },
      data: { archivedAt: null },
    });
  }
  return { ok: true, archived: false };
}

export type MergeResult =
  | { ok: true; balance: number; movedVisits: number; moved: Record<string, number> }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "same_client" }
  | { ok: false; reason: "marked_different_people" };

/**
 * Test seam: fail the merge AFTER the customer links have been settled, to
 * prove the whole transaction rolls back together rather than leaving an app
 * pointing at a record whose history never moved.
 */
let mergeFault: "after_links" | null = null;
export function __setMergeFaultForTests(stage: "after_links" | null): void {
  mergeFault = stage;
}

/** Who asked for a merge, and (optionally) why - stored on the ClientMergeEvent. */
export interface MergeAudit {
  actorUserId: string | null;
  reason: string | null;
}

/**
 * Merge a duplicate client (the LOSER) into the one to keep (the WINNER). The
 * loser's entire footprint - visits, the whole punch ledger, nudges, and promo
 * uses - is reassigned to the winner, the winner's profile/consent is reconciled,
 * its cadence is recomputed, and the loser is soft-archived (not deleted) so the
 * merge leaves a recoverable trail.
 *
 * Why moving rows wholesale is safe:
 *  - PunchLedger balance is the AGGREGATE sum(earned)-sum(redeemed); reassigning
 *    every row of the loser makes the winner's balance the exact sum of the two.
 *    The reversal/correction chains move together (we move by clientId, not by
 *    visitId), so no offsetting row is ever orphaned.
 *  - Visit's unique is (shopId, acuityAppointmentId); we only change clientId, and
 *    both clients live in the same shop, so appointment ids can't collide.
 *  - PunchLedger.visitId @unique is per-visit; moving by clientId never touches it.
 *
 * Consent reconciliation (TCPA-safe, the locked rule):
 *  - optedOut = winner.optedOut OR loser.optedOut  (a STOP on EITHER record wins)
 *  - smsConsentAt = the EARLIEST non-null of the two (and keep that record's
 *    source). We never fabricate consent or advance its date by merging.
 *
 * EVERYTHING the customer did moves, not just the loyalty trail: their
 * appointments and standing appointments (or the survivor shows no upcoming
 * booking, and the customer's own app loses it), waitlist and walk-in entries,
 * receptionist conversations and push devices. None of those tables is unique
 * on the client, so a re-point cannot collide. Immutable audit trails
 * (WaitlistEvent, WalkInEvent) are left exactly as they were written.
 *
 * Every merge writes a ClientMergeEvent in the SAME transaction - who, when,
 * why (optional) and the row counts that moved - so a merge is never an
 * untraceable rewrite of someone's history.
 *
 * The loser's sync key (acuityClientKey) is retired to `merged:<id>`, so a
 * later booking under the duplicate's old identity becomes a new, visible
 * client rather than landing on the archived one. There is no alias from the
 * old key to the winner (that would touch every booking path); the duplicates
 * review (clientDuplicates.ts) surfaces the new record next to the winner.
 *
 * Both client rows are locked (id-ascending to avoid deadlocks) for the whole
 * move, so a concurrent earn/redeem on either can't race the reassignment.
 */
export async function mergeClients(
  shopId: string,
  winnerId: string,
  loserId: string,
  audit: MergeAudit = { actorUserId: null, reason: null },
): Promise<MergeResult> {
  if (winnerId === loserId) return { ok: false, reason: "same_client" };

  const result = await runWithShop(shopId, async (tx) => {
    // Lock both rows, lowest id first, so two concurrent merges of the same pair
    // can't deadlock (both acquire in the same order). Separate statements give a
    // deterministic acquisition order that a single IN-list FOR UPDATE does not.
    const [firstId, secondId] = [winnerId, loserId].sort();
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${firstId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${secondId} FOR UPDATE`;

    const winner = await tx.client.findFirst({ where: { id: winnerId, shopId } });
    const loser = await tx.client.findFirst({ where: { id: loserId, shopId } });
    if (!winner || !loser) return { ok: false as const, reason: "not_found" as const };
    // A customer's own deletion is final: their anonymized record never folds
    // into another one (that would re-attach the history they asked us to drop).
    if (winner.optOutSource === "deleted" || loser.optOutSource === "deleted") {
      return { ok: false as const, reason: "not_found" as const };
    }
    // 🔴 "NOT THE SAME PERSON" IS PERMANENT. Somebody at this shop looked at
    // these two records and said they are different people - the parent and
    // child on one phone number that the duplicates review exists for. A merge
    // would fold one person's visits, punches and bookings into the other's,
    // and the customer side reads the same fact to decide what an account may
    // open. It is refused here rather than quietly allowed.
    const [lowId, highId] = [winnerId, loserId].sort();
    const different = await tx.clientDuplicateDismissal.findFirst({
      where: { shopId, clientAId: lowId, clientBId: highId },
      select: { id: true },
    });
    if (different) {
      return { ok: false as const, reason: "marked_different_people" as const };
    }

    // Reassign the loser's entire footprint to the winner.
    const repoint = { where: { clientId: loserId, shopId }, data: { clientId: winnerId } };
    const moved = await tx.visit.updateMany(repoint);
    const ledger = await tx.punchLedger.updateMany(repoint);
    const nudges = await tx.nudge.updateMany(repoint);
    const promoUses = await tx.promotionRedemption.updateMany(repoint);
    // The customer's bookings and everything else that is theirs.
    const appointments = await tx.appointment.updateMany(repoint);
    const series = await tx.recurringSeries.updateMany(repoint);
    const waitlist = await tx.waitlistEntry.updateMany(repoint);
    const walkIns = await tx.walkInEntry.updateMany(repoint);
    const conversations = await tx.receptionistConversation.updateMany(repoint);
    const devices = await tx.pushSubscription.updateMany(repoint);

    // CardGrant (exclusive-card VIP membership) and WalletPassRegistration both
    // carry a composite unique that a blind re-point can violate when the winner
    // already has a matching row. Drop the loser's colliding rows first, then
    // move the rest. Without this move, a merged client keeps the loser's punch
    // balance on an exclusive card but loses the membership -> routeVisitEarn
    // silently skips that card forever; and the loser's Wallet pass keeps
    // pointing at a now-zeroed client id.

    // CardGrant unique is (cardTypeId, clientId): a loser grant collides with the
    // winner iff the winner already holds a grant on the same cardType.
    await tx.cardGrant.deleteMany({
      where: {
        shopId,
        clientId: loserId,
        cardType: { grants: { some: { clientId: winnerId } } },
      },
    });
    await tx.cardGrant.updateMany({
      where: { clientId: loserId, shopId },
      data: { clientId: winnerId },
    });

    // WalletPassRegistration unique is (deviceLibraryIdentifier, clientId): a
    // loser registration collides iff the winner already has a registration from
    // the same device. Drop those, move the rest. (deviceLibraryIdentifier is
    // not shop-scoped in the unique, but rows are always same-shop here since
    // both clients belong to `shopId`.)
    const winnerDevices = await tx.walletPassRegistration.findMany({
      where: { shopId, clientId: winnerId },
      select: { deviceLibraryIdentifier: true },
    });
    if (winnerDevices.length > 0) {
      await tx.walletPassRegistration.deleteMany({
        where: {
          shopId,
          clientId: loserId,
          deviceLibraryIdentifier: {
            in: winnerDevices.map((d) => d.deviceLibraryIdentifier),
          },
        },
      });
    }
    await tx.walletPassRegistration.updateMany({
      where: { clientId: loserId, shopId },
      data: { clientId: winnerId },
    });

    // Consent reconciliation: opted-out-wins + earliest-consent-wins.
    const optedOut = winner.optedOut || loser.optedOut;
    let smsConsentAt = winner.smsConsentAt;
    let smsConsentSource = winner.smsConsentSource;
    if (
      loser.smsConsentAt !== null &&
      (winner.smsConsentAt === null || loser.smsConsentAt < winner.smsConsentAt)
    ) {
      smsConsentAt = loser.smsConsentAt;
      smsConsentSource = loser.smsConsentSource;
    }

    // Fill any blank winner contact field from the loser (don't overwrite).
    const update: Record<string, unknown> = { optedOut, smsConsentAt, smsConsentSource };
    if (!winner.phone && loser.phone) update.phone = loser.phone;
    if (!winner.email && loser.email) update.email = loser.email;
    if (!winner.lastName && loser.lastName) update.lastName = loser.lastName;
    if (winner.notes && loser.notes) {
      update.notes = `${winner.notes}\n\n[merged] ${loser.notes}`;
    } else if (!winner.notes && loser.notes) {
      update.notes = loser.notes;
    }
    await tx.client.update({ where: { id: winnerId }, data: update });

    // Soft-archive the loser (recoverable trail; not a hard delete) and retire
    // its sync key. Every client upsert - Acuity and Square ingest, native
    // booking, add-client, import, the receptionist - finds a client by
    // (shopId, acuityClientKey). Left in place, the next booking under the
    // duplicate's old identity would attach to THIS archived row: a visit
    // nobody sees and punches the customer can't use (and a text from the
    // number would un-archive an empty record). Retired, that booking creates
    // a fresh, visible client, which the duplicates review offers to merge.
    await tx.client.update({
      where: { id: loserId },
      data: { archivedAt: new Date(), acuityClientKey: `merged:${loserId}` },
    });

    // The merge's own record, committed WITH the merge.
    const movedCounts = {
      visits: moved.count,
      ledgerEntries: ledger.count,
      nudges: nudges.count,
      promoUses: promoUses.count,
      appointments: appointments.count,
      standingAppointments: series.count,
      waitlistEntries: waitlist.count,
      walkInEntries: walkIns.count,
      conversations: conversations.count,
      pushDevices: devices.count,
    };
    await tx.clientMergeEvent.create({
      data: {
        shopId,
        survivorClientId: winnerId,
        mergedClientId: loserId,
        actorUserId: audit.actorUserId,
        reason: audit.reason,
        moved: movedCounts,
      },
    });

    // 🔴 THE CUSTOMER'S OWN APP, SETTLED IN THIS TRANSACTION. My ChairBack
    // links live in platform tables the tenant role cannot touch, so this
    // steps up to the owner INSIDE the same transaction rather than opening a
    // second one: the history has just moved, and a link still pointing at the
    // archived record - or surviving on the wrong account - must never be a
    // state that outlives a rolled-back merge. See settleLinksForMerge for
    // which account keeps what.
    await asOwnerWithin(tx, (otx) =>
      settleLinksForMerge(otx, { shopId, winnerId, loserId }),
    );
    if (mergeFault === "after_links") throw new Error("merge_fault_after_links");

    const agg = await tx.punchLedger.aggregate({
      where: { shopId, clientId: winnerId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    const balance = (agg._sum.punchesEarned ?? 0) - (agg._sum.punchesRedeemed ?? 0);
    return { ok: true as const, balance, movedVisits: moved.count, moved: movedCounts };
  });

  if (!result.ok) return result;
  // The winner's completed-visit set changed; recompute cadence (reads Visit).
  await recomputeCadence(shopId, winnerId);
  return { ok: true, balance: result.balance, movedVisits: result.movedVisits, moved: result.moved };
}
