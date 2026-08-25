import { Prisma, prisma } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { sha256Hex } from "./waitlistJoin.js";
import { entryPrefsMatchSlot } from "./waitlistMatch.js";
import {
  CUSTOMER_ACTOR,
  recordWaitlistEvent,
  recordWaitlistEventBestEffort,
  SYSTEM_ACTOR,
} from "./waitlistAudit.js";
import { dispatchAfterCommit, recordMirrorIntent } from "./acuityMirror.js";
import {
  lockStaffAndAssertSlotFree,
  SlotTakenError,
} from "./bookingWrite.js";
import { ServiceDayFullError } from "./serviceDailyLimit.js";
import { isSlotBookable } from "./slots.js";
import { effectivePriceAt } from "./pricing.js";
import { deriveAcuityClientKey } from "../acuity/clientKey.js";
import { connectEnabled, hasActiveAccess } from "../billing/stripe.js";
import { depositChargeCents, toCents } from "../billing/payments.js";
import {
  buildWaitlistOfferCustomerEmail,
  buildWaitlistOfferCustomerPush,
  formatApptTime,
} from "../messaging/templates.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { sendPushToClient } from "../messaging/push.js";

/**
 * Waitlist phase C: ONE customer at a time gets a freed slot, held for them.
 *
 * A cancellation used to blast up to five waitlisters with "come fight for
 * it". Now the earliest eligible WAITING entry gets the slot HELD - a
 * WaitlistOffer row that hides the time from the public grid and blocks every
 * other writer - plus a claim link that books it directly. If they don't take
 * it within HOLD_MINUTES, the expiry worker releases the hold and offers the
 * slot to the next person in line.
 *
 * Design lines that must hold:
 *
 * 🔴 A hold is on ONE real barber. WaitlistOffer.staffId is NOT NULL and the
 *    GiST EXCLUDE (WaitlistOffer_no_overlapping_hold) refuses a second live
 *    hold whose span touches the same barber's. The engine checks first (via
 *    lockStaffAndAssertSlotFree, which now sees active holds) for a friendly
 *    outcome; the constraint is the backstop under concurrency.
 *
 * 🔴 The claim token is the credential. 256-bit random, ONLY its sha256 kept
 *    (same rule as the cancel token). Expired, released, claimed or unknown
 *    tokens all fail into the same generic outcomes - the table can never be
 *    used to read or take someone else's slot.
 *
 * 🔴 Expiry is enforced at CLAIM TIME, not by the sweep. The worker's cadence
 *    only decides how fast the NEXT person hears about the slot; a claim at
 *    expiresAt is refused even if the worker hasn't run in an hour. Mirrors
 *    how expired receptionist holds free their slot before the sweep.
 *
 * 🔴 Matching here is deliberately the SAME rule slotOpened has used all
 *    along (service matches or standing, staff matches or any, earliest
 *    joiner first). Phase D replaces the rule in ONE place - pickCandidate -
 *    with window-aware matching; nothing else should need to move.
 */

/** How long a customer owns the offered slot. */
export const HOLD_MINUTES = 30;
export const HOLD_MS = HOLD_MINUTES * 60_000;

/**
 * 🔴 ANTI-SPAM COOLDOWN, carried over from the broadcast era and kept on
 * purpose: after an offer notification (including one they ignored into
 * expiry), the same entry gets NO further automated offer for six hours.
 * Without this, a run of cancellations would email the same person every 30
 * minutes as each hold lapsed and the next slot came looking. The one-live-
 * offer rule and the never-the-same-slot rule still apply on top; entries in
 * cooldown are SKIPPED and the slot goes to the next eligible person.
 */
export const OFFER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Candidate scan: entries stream out of the database in ranked KEYSET pages
 * (createdAt asc, id asc - the id breaks same-instant ties AND anchors the
 * cursor) and are evaluated against their preference windows in JS, because
 * a window match is not expressible as a WHERE clause. The scan runs until
 * a candidate fits or the list is EXHAUSTED - there is no correctness cap:
 * candidate 5,001 deserves the slot exactly as much as candidate 1 did.
 * Memory stays one page; keyset (never OFFSET) keeps pages stable while
 * entries are concurrently inserted - a row added behind the cursor is
 * simply seen by the NEXT freed slot, never double-visited by this one.
 */
const CANDIDATE_BATCH = 50;

/** Last scan's shape, for the benchmark test. Not used by production code. */
export let __lastScanStatsForTests: { scanned: number; pages: number } = {
  scanned: 0,
  pages: 0,
};

// Test seam for the deposit gate: connectEnabled() reads STRIPE_* env, which
// the suite deliberately runs without. Mirrors __setSendEmailForTests.
let connectOverride: boolean | undefined;
export function __setConnectEnabledForTests(v: boolean | undefined): void {
  connectOverride = v;
}
const connectOn = (): boolean => connectOverride ?? connectEnabled();

/**
 * Would redeeming a claim OWE MONEY under the shop's normal booking rules?
 *
 * 🔴 A waitlist claim is customer-initiated booking, and it must never mint
 * an unpaid appointment for a service that normally collects a deposit or
 * full payment up front. Phase C does not carry a checkout, so such slots
 * are NOT auto-offered at all - the entries stay WAITING for the barber to
 * work by hand. The condition mirrors the public create's payment gate
 * exactly (booking.public.ts), including the approval-mode carve-out:
 * approval shops collect on approval, not at booking, so their requests
 * are safe to create unpaid.
 */
export function claimWouldRequirePayment(
  shop: {
    requireBookingApproval: boolean;
    paymentsMode: string;
    connectChargesEnabled: boolean;
    stripeConnectAccountId: string | null;
    depositAmountCents: number | null;
  },
  price: number | null,
): boolean {
  if (shop.requireBookingApproval) return false;
  if (shop.paymentsMode !== "ahead" && shop.paymentsMode !== "deposit") return false;
  if (!connectOn() || !shop.connectChargesEnabled || !shop.stripeConnectAccountId) {
    return false;
  }
  const fullCents = toCents(price);
  const chargeCents =
    shop.paymentsMode === "deposit"
      ? depositChargeCents(shop.depositAmountCents, fullCents)
      : fullCents;
  return chargeCents !== null && chargeCents > 0;
}

export function mintClaimToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}

/** The claim URL that goes in the offer email/push. */
export function claimUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/waitlist/offer/${token}`;
}

export interface FreedSlot {
  shopId: string;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  /** Shop.timezone - the day-cap and price layers are shop-local. */
  timezone: string;
  /** Shop.bookingBufferMin. */
  bufferMin: number;
}

export type OfferResult =
  | {
      outcome: "offered";
      offerId: string;
      entryId: string;
      /** RAW claim token - exists only in memory, for the notification. */
      token: string;
      expiresAt: Date;
      entry: { firstName: string; email: string | null; clientId: string | null };
    }
  /** Nobody eligible AND reachable - the slot stays public. */
  | { outcome: "no_candidates" }
  /** Held/booked/blocked/day-full/outside-hours - nothing to offer. */
  | { outcome: "unavailable" }
  /**
   * The service collects a deposit/pay-ahead at booking and phase C carries
   * no checkout: never auto-offered. Entries stay WAITING for manual work.
   */
  | { outcome: "requires_deposit" };

/**
 * Hold a freed slot for the earliest eligible WAITING entry.
 *
 * Idempotent under duplicate cancellation events: the first call creates the
 * hold; a second call for the same span finds that hold via the overlap guard
 * and returns "unavailable" without a second offer or notification. Safe
 * under concurrency for the same reason - the staff advisory lock serializes
 * racers and the GiST constraint backstops.
 */
export async function offerFreedSlot(
  slot: FreedSlot,
  now: Date = new Date(),
): Promise<OfferResult> {
  // Rules gate (hours, exceptions, blocked time, caps): don't hold a time the
  // grid would never offer. ignoreBooked semantics mean an existing hold or
  // appointment does NOT trip this - the tx guard below owns taken-ness.
  const stillOffered = await isSlotBookable({
    shopId: slot.shopId,
    staffId: slot.staffId,
    serviceId: slot.serviceId,
    startsAt: slot.startsAt,
    now,
  });
  if (!stillOffered) return { outcome: "unavailable" };

  // 🔴 Deposit gate: if claiming this slot would owe money, don't offer it -
  // there is no checkout inside the hold yet, and an unpaid appointment for a
  // deposit-required service is exactly the thing that must never exist.
  const [policyShop, policyService] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: slot.shopId },
      select: {
        requireBookingApproval: true,
        paymentsMode: true,
        connectChargesEnabled: true,
        stripeConnectAccountId: true,
        depositAmountCents: true,
      },
    }),
    prisma.service.findFirst({
      where: { id: slot.serviceId, shopId: slot.shopId },
      select: { price: true },
    }),
  ]);
  if (!policyShop) return { outcome: "unavailable" };
  if (
    claimWouldRequirePayment(
      policyShop,
      policyService?.price == null ? null : Number(policyService.price),
    )
  ) {
    logger.info(
      { shopId: slot.shopId, serviceId: slot.serviceId },
      "waitlist offer skipped: service requires a deposit; entries stay WAITING for manual handling",
    );
    return { outcome: "requires_deposit" };
  }

  const expiresAt = new Date(now.getTime() + HOLD_MS);
  const { token, hash } = mintClaimToken();

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Serialize against every other writer on this barber; throws
      // SlotTakenError when an appointment, targeted slot, synced visit or
      // ANOTHER ACTIVE HOLD overlaps. Day cap asserted too - offering a slot
      // the cap would refuse at booking time is a dead offer.
      await lockStaffAndAssertSlotFree(tx, {
        staffId: slot.staffId,
        shopId: slot.shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: slot.bufferMin,
        serviceDayLimit: { serviceId: slot.serviceId, timezone: slot.timezone },
        now,
      });

      const candidate = await pickCandidate(tx, slot, now);
      if (!candidate) return null;

      const offer = await tx.waitlistOffer.create({
        data: {
          shopId: slot.shopId,
          entryId: candidate.id,
          staffId: slot.staffId,
          serviceId: slot.serviceId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          tokenHash: hash,
          status: "OFFERED",
          expiresAt,
        },
        select: { id: true },
      });
      // Same transaction as the hold itself: a slot held for someone with no
      // record of why is exactly the state F1 exists to prevent.
      await recordWaitlistEvent(tx, {
        shopId: slot.shopId,
        entryId: candidate.id,
        offerId: offer.id,
        type: "offer.created",
        actor: SYSTEM_ACTOR,
        metadata: {
          holdMinutes: HOLD_MINUTES,
          scanned: __lastScanStatsForTests.scanned,
          pages: __lastScanStatsForTests.pages,
        },
      });
      return { offer, candidate };
    });

    if (!created) return { outcome: "no_candidates" };
    logger.info(
      {
        shopId: slot.shopId,
        offerId: created.offer.id,
        entryId: created.candidate.id,
        staffId: slot.staffId,
        startsAt: slot.startsAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      "waitlist offer created (slot held)",
    );
    return {
      outcome: "offered",
      offerId: created.offer.id,
      entryId: created.candidate.id,
      token,
      expiresAt,
      entry: {
        firstName: created.candidate.firstName,
        email: created.candidate.email,
        clientId: created.candidate.clientId,
      },
    };
  } catch (err) {
    if (err instanceof SlotTakenError || err instanceof ServiceDayFullError) {
      return { outcome: "unavailable" };
    }
    // The GiST EXCLUDE fired under a race the advisory lock couldn't see
    // (different staff lock ordering can't happen here, but a raw writer
    // elsewhere could). Same meaning: someone else holds it.
    if (/exclusion constraint|WaitlistOffer_no_overlapping_hold/i.test(String(err))) {
      return { outcome: "unavailable" };
    }
    throw err;
  }
}

/**
 * Phase D matching: everything phase C filtered, PLUS the entry's own
 * preference windows, timezone and minimum notice (engines/waitlistMatch.ts).
 * Base eligibility is unchanged: status WAITING, service matches or standing
 * join, staff matches or any-provider (a slot-entry join that captured no
 * service/staff context stays Any/Any - context is never invented), earliest
 * joiner first with the id as a stable tie-breaker. Phase C's own rules:
 *   - not currently holding a live offer (one held slot per person),
 *   - never offered THIS exact slot before (an expired offer must advance to
 *     the NEXT person, not bounce back),
 *   - 🔴 not inside the six-hour notification COOLDOWN (OFFER_COOLDOWN_MS):
 *     someone who just ignored an offer into expiry must not get another
 *     automated email 30 minutes later as the next hold lapses. In cooldown =
 *     skipped; the slot advances to the next eligible person.
 *   - reachable: an email address, or a linked client we can push to. A
 *     phone-only entry cannot be told about a 30-minute window while customer
 *     SMS is dark (10DLC), so holding a slot for them would just go dead.
 */
async function pickCandidate(
  tx: Prisma.TransactionClient,
  slot: FreedSlot,
  now: Date,
): Promise<{ id: string; firstName: string; email: string | null; clientId: string | null } | null> {
  // Phase D: what the DATABASE can filter, it filters (status, shop, service,
  // staff, live-offer, same-slot, cooldown); what only the calendar can
  // answer - do the entry's preference WINDOWS fit this physical slot, in
  // the entry's own timezone, with their minimum notice - is evaluated per
  // candidate by engines/waitlistMatch.ts, in ranked order, first fit wins.
  //
  // 🔴 LOG HYGIENE: skip lines carry the machine CODE and ids only. The
  // verdict's human reason names the customer's dates and time windows -
  // preference details that belong in tests and the isolated trace, never
  // in production logs.
  let scanned = 0;
  let pages = 0;
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    const and: Prisma.WaitlistEntryWhereInput[] = [
      { OR: [{ serviceId: slot.serviceId }, { serviceId: null }] },
      { OR: [{ staffId: slot.staffId }, { staffId: null }, { staffId: "" }] },
      { offers: { none: { status: "OFFERED", expiresAt: { gt: now } } } },
      { offers: { none: { staffId: slot.staffId, startsAt: slot.startsAt } } },
      {
        OR: [
          { notifiedAt: null },
          { notifiedAt: { lt: new Date(now.getTime() - OFFER_COOLDOWN_MS) } },
        ],
      },
    ];
    // KEYSET, not OFFSET: strictly after the last row we saw, in the exact
    // scan order. Stable under concurrent inserts and never re-reads or
    // skips a page the way a shifting OFFSET would.
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      });
    }
    const batch = await tx.waitlistEntry.findMany({
      where: {
        shopId: slot.shopId,
        status: "WAITING",
        AND: and,
      },
      // Deterministic ranking: earliest joiner first, id as the stable
      // tie-breaker for same-instant joins (and the cursor anchor).
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        createdAt: true,
        firstName: true,
        email: true,
        phone: true,
        timezone: true,
        minHoursNotice: true,
        windows: {
          select: { startDate: true, endDate: true, startMin: true, endMin: true },
        },
      },
    });
    if (batch.length === 0) break;
    pages += 1;
    cursor = { createdAt: batch[batch.length - 1]!.createdAt, id: batch[batch.length - 1]!.id };

    // ONE client lookup per page for its phone-only candidates (no N+1):
    // fetched up front so the walk below never queries per candidate.
    const phoneOnly = batch.filter((c) => !c.email && c.phone).map((c) => c.phone!);
    const pushable = new Map<string, string>();
    if (phoneOnly.length > 0) {
      const clients = await tx.client.findMany({
        where: { shopId: slot.shopId, phone: { in: phoneOnly }, archivedAt: null },
        select: { id: true, phone: true },
      });
      for (const cl of clients) if (cl.phone) pushable.set(cl.phone, cl.id);
    }

    for (const c of batch) {
      scanned += 1;
      try {
        const verdict = entryPrefsMatchSlot(c, slot, {
          shopTimezone: slot.timezone,
          now,
        });
        if (!verdict.ok) {
          logger.debug(
            { shopId: slot.shopId, entryId: c.id, code: verdict.code },
            "waitlist match: candidate skipped",
          );
          continue;
        }
        if (c.email) {
          __lastScanStatsForTests = { scanned, pages };
          logger.info(
            { shopId: slot.shopId, entryId: c.id, code: "selected_email", scanned, pages },
            "waitlist match: candidate selected",
          );
          return { id: c.id, firstName: c.firstName, email: c.email, clientId: null };
        }
        const clientId = c.phone ? pushable.get(c.phone) : undefined;
        if (clientId) {
          __lastScanStatsForTests = { scanned, pages };
          logger.info(
            { shopId: slot.shopId, entryId: c.id, code: "selected_push", scanned, pages },
            "waitlist match: candidate selected",
          );
          return { id: c.id, firstName: c.firstName, email: null, clientId };
        }
        logger.debug(
          { shopId: slot.shopId, entryId: c.id, code: "unreachable" },
          "waitlist match: candidate skipped",
        );
      } catch (err) {
        // One candidate's bad data (a corrupt zone, a mangled window) must
        // cost THEM the evaluation, not the whole offer - and never the
        // cancellation this ultimately hangs off. Skip and keep walking.
        logger.error(
          { err, shopId: slot.shopId, entryId: c.id, code: "match_error" },
          "waitlist match: candidate evaluation failed; skipping",
        );
      }
    }
    if (batch.length < CANDIDATE_BATCH) break;
  }

  __lastScanStatsForTests = { scanned, pages };
  logger.info(
    { shopId: slot.shopId, code: "exhausted", scanned, pages },
    "waitlist match: no eligible candidate",
  );
  return null;
}

/** What notifyOffer needs to say who/where/when. */
export interface OfferNotifyShop {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
}

/**
 * Tell exactly ONE customer their slot is being held. Push (when a linked
 * client exists) + email (when they left an address) - never SMS (10DLC).
 * Never throws: the offer stands even if every channel fails; the worker
 * expires it and advances in HOLD_MINUTES, so an unreachable hold self-heals.
 */
export async function notifyOffer(params: {
  shop: OfferNotifyShop;
  offer: {
    entryId: string;
    startsAt: Date;
    expiresAt: Date;
    serviceName: string | null;
    staffName: string | null;
    /** Approval-mode shop: the claim submits a REQUEST, so say "request". */
    approvalRequired: boolean;
  };
  entry: { firstName: string; email: string | null; clientId: string | null };
  token: string;
  now?: Date;
}): Promise<void> {
  const { shop, offer, entry } = params;
  const now = params.now ?? new Date();
  // No DRY_RUN check HERE on purpose: dry-run environments never CREATE an
  // offer in the first place (the slotOpened wiring and the worker's advance
  // are both gated), so by the time this runs the offer is real and the
  // channels below carry their own suppression (sendEmail/sendPushToClient
  // honor the test seams and env exactly like every other transactional send).
  const when = formatApptTime(offer.startsAt, shop.timezone);
  const holdUntil = formatApptTime(offer.expiresAt, shop.timezone);
  const url = claimUrl(apiEnv().APP_BASE_URL, params.token);
  let reached = false;
  // 🔴 The FACT of a send and its outcome - never the address, the subject or
  // the body. "We never reached them" versus "we reached them and they let it
  // lapse" is the difference between a bug and a customer's choice, and today
  // that distinction survives only as a log line. `notifiedAt` (stamped below)
  // is also the six-hour cooldown's sole evidence, so it deserves a row.
  const channels: { channel: string; outcome: string }[] = [];

  if (entry.clientId) {
    const push = buildWaitlistOfferCustomerPush({
      firstName: entry.firstName,
      shopName: shop.name,
      when,
      holdMinutes: HOLD_MINUTES,
      approvalRequired: offer.approvalRequired,
    });
    const res = await sendPushToClient({
      shopId: shop.id,
      clientId: entry.clientId,
      payload: { title: push.title, body: push.body, url, tag: "waitlist-offer" },
      kind: "nudge",
    }).catch((err) => {
      logger.error({ err, shopId: shop.id }, "waitlist offer push failed");
      return null;
    });
    if (res?.anyDelivered) reached = true;
    channels.push({
      channel: "push",
      outcome: res === null ? "failed" : res.anyDelivered ? "delivered" : "not_delivered",
    });
  }

  if (entry.email && emailEnabled()) {
    const email = buildWaitlistOfferCustomerEmail({
      firstName: entry.firstName,
      shopName: shop.name,
      serviceName: offer.serviceName,
      staffName: offer.staffName,
      when,
      holdUntil,
      claimUrl: url,
      approvalRequired: offer.approvalRequired,
    });
    const res = await sendEmail({
      to: entry.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    }).catch((err) => {
      logger.error({ err, shopId: shop.id }, "waitlist offer email failed");
      return null;
    });
    if (res && (res.status === "sent" || res.status === "dry_run")) reached = true;
    channels.push({
      channel: "email",
      outcome: res === null ? "failed" : res.status,
    });
  }

  if (reached) {
    await prisma.waitlistEntry
      .updateMany({ where: { id: offer.entryId, shopId: shop.id }, data: { notifiedAt: now } })
      .catch((err) =>
        logger.error({ err, shopId: shop.id }, "offer notifiedAt stamp failed"),
      );
  } else {
    logger.warn(
      { shopId: shop.id, entryId: offer.entryId },
      "waitlist offer created but NO channel reached the customer; hold will expire and advance",
    );
  }

  // Best-effort, and post-send by necessity: the message is already gone. An
  // audit failure here costs a line of history; throwing would turn a
  // delivered email into a failed offer.
  for (const c of channels) {
    await recordWaitlistEventBestEffort({
      shopId: shop.id,
      entryId: offer.entryId,
      type: "offer.notified",
      actor: SYSTEM_ACTOR,
      metadata: { channel: c.channel, outcome: c.outcome },
    });
  }
  if (!reached) {
    await recordWaitlistEventBestEffort({
      shopId: shop.id,
      entryId: offer.entryId,
      type: "offer.unreachable",
      actor: SYSTEM_ACTOR,
      metadata: { code: "no_channel", channel: channels.length === 0 ? "none" : "all_failed" },
    });
  }
}

export type ClaimResult =
  | {
      outcome: "claimed";
      appointmentId: string;
      manageToken: string;
      shopId: string;
      shopSlug: string | null;
      startsAt: Date;
      endsAt: Date;
      /**
       * True on approval-mode shops: the claim created a PENDING REQUEST that
       * consumes the slot but is not confirmed until the barber approves -
       * exactly the shop's normal booking policy, never overridden.
       */
      pending: boolean;
    }
  /** Token matches nothing. */
  | { outcome: "invalid" }
  /** Expired, released, or already claimed - the hold is gone either way. */
  | { outcome: "expired" }
  /** The physical time got taken through an overriding path. */
  | { outcome: "slot_taken" }
  | { outcome: "day_full" }
  /**
   * The shop turned on deposits mid-hold: redeeming would mint an unpaid
   * appointment that normally costs money, so the claim refuses and the
   * offer is RELEASED. The entry stays on the waitlist.
   */
  | { outcome: "deposit_required" };

/**
 * Redeem a claim token: revalidate and book ATOMICALLY.
 *
 * The offer row is read FOR UPDATE, so a concurrent claim of the same token,
 * the expiry worker's compare-and-set, and an admin release all serialize on
 * the row: exactly one of them decides the offer's fate. The slot itself is
 * then re-asserted under the SAME advisory-lock protocol as every other
 * Appointment write - with this offer's own hold excluded so it cannot block
 * its own redemption.
 */
export async function claimOffer(params: {
  token: string;
  now?: Date;
  /** Optional corrections from the claim form; entry values are the default. */
  customer?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
}): Promise<ClaimResult> {
  const now = params.now ?? new Date();
  const hash = sha256Hex(params.token);
  // Captured inside the transaction, dispatched after it commits.
  let claimOutboxId: string | null = null;
  let claimedApptId: string | null = null;

  try {
    const claimResult = await prisma.$transaction(async (tx) => {
      // Row lock FIRST: whoever holds it decides this offer's fate.
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "WaitlistOffer" WHERE "tokenHash" = ${hash} FOR UPDATE`,
      );
      if (locked.length === 0) return { outcome: "invalid" as const };

      const offer = await tx.waitlistOffer.findUnique({
        where: { id: locked[0]!.id },
        include: {
          entry: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
              status: true,
            },
          },
        },
      });
      if (!offer) return { outcome: "invalid" as const };
      if (offer.status !== "OFFERED") return { outcome: "expired" as const };
      if (offer.expiresAt.getTime() <= now.getTime()) {
        // Enforce the boundary here, not in the sweep: flip so the state is
        // honest even if the worker is behind.
        await tx.waitlistOffer.update({
          where: { id: offer.id },
          data: { status: "EXPIRED" },
        });
        await recordWaitlistEvent(tx, {
          shopId: offer.shopId,
          entryId: offer.entryId,
          offerId: offer.id,
          type: "offer.expired",
          actor: CUSTOMER_ACTOR,
          // `at` separates the two ways a hold dies: the sweep found it, or
          // the customer arrived a moment too late. The second is the one a
          // barber asks about.
          metadata: { at: "claim" },
        });
        return { outcome: "expired" as const };
      }

      const [shop, service] = await Promise.all([
        tx.shop.findUnique({
          where: { id: offer.shopId },
          select: {
            id: true,
            slug: true,
            name: true,
            timezone: true,
            bookingBufferMin: true,
            requireBookingApproval: true,
            paymentsMode: true,
            connectChargesEnabled: true,
            stripeConnectAccountId: true,
            depositAmountCents: true,
          },
        }),
        tx.service.findFirst({
          where: { id: offer.serviceId, shopId: offer.shopId },
          select: {
            id: true,
            price: true,
            priceOverrides: true,
            dateOverrides: true,
            timeOverrides: true,
          },
        }),
      ]);
      if (!shop) return { outcome: "invalid" as const };

      // Deposit re-check at REDEMPTION: offers are never created for paid
      // services, but the shop can flip deposits on mid-hold. Refuse rather
      // than mint an unpaid appointment; release the hold (we own the row
      // lock) so the slot returns to the pool and the entry stays WAITING.
      if (
        claimWouldRequirePayment(
          shop,
          service?.price == null ? null : Number(service.price),
        )
      ) {
        await tx.waitlistOffer.update({
          where: { id: offer.id },
          data: { status: "RELEASED" },
        });
        await recordWaitlistEvent(tx, {
          shopId: offer.shopId,
          entryId: offer.entryId,
          offerId: offer.id,
          type: "offer.released",
          actor: CUSTOMER_ACTOR,
          metadata: { code: "deposit_required", via: "claim" },
        });
        return { outcome: "deposit_required" as const };
      }

      // Same guard as every booking write; our own hold must not block us.
      await lockStaffAndAssertSlotFree(tx, {
        staffId: offer.staffId,
        shopId: offer.shopId,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        bufferMin: shop.bookingBufferMin,
        waitlistOfferIdToIgnore: offer.id,
        serviceDayLimit: { serviceId: offer.serviceId, timezone: shop.timezone },
        now,
      });

      const firstName = params.customer?.firstName?.trim() || offer.entry.firstName;
      const lastName = params.customer?.lastName?.trim() || offer.entry.lastName || null;
      const email = params.customer?.email?.trim() || offer.entry.email || null;
      const phone = params.customer?.phone?.trim() || offer.entry.phone || null;

      // Same client upsert as the public create, so the booking lands in the
      // barber's client book. No consent stamping here: the waitlist consent
      // stays on the entry, and the claim form asked for none.
      const acuityClientKey = deriveAcuityClientKey({
        phone,
        email,
        firstName,
        lastName: lastName ?? undefined,
      });
      const client = await tx.client.upsert({
        where: { shopId_acuityClientKey: { shopId: offer.shopId, acuityClientKey } },
        create: {
          shopId: offer.shopId,
          acuityClientKey,
          magicToken: randomToken(),
          firstName,
          lastName,
          phone,
          email,
          source: "manual",
        },
        update: {
          firstName,
          lastName: lastName ?? undefined,
          phone: phone ?? undefined,
          email: email ?? undefined,
        },
        select: { id: true },
      });

      const priceAtBooking = service
        ? effectivePriceAt(service.price === null ? null : Number(service.price), {
            at: offer.startsAt,
            timezone: shop.timezone,
            weekdayOverrides: service.priceOverrides,
            dateOverrides: service.dateOverrides,
            timeWindows: service.timeOverrides,
          })
        : null;

      const manageToken = randomToken();
      const appt = await tx.appointment.create({
        data: {
          shopId: offer.shopId,
          staffId: offer.staffId,
          serviceId: offer.serviceId,
          clientId: client.id,
          firstName,
          lastName,
          phone,
          email,
          // The shop's own booking policy, never overridden: approval-mode
          // shops get a PENDING REQUEST (it consumes the slot exactly like
          // any pending request; the barber confirms it on their normal
          // approval screen), everyone else books directly.
          status: shop.requireBookingApproval ? "PENDING" : "BOOKED",
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
          priceAtBooking: priceAtBooking ?? undefined,
          manageToken,
          bookedVia: "waitlist_offer",
        },
        select: { id: true, manageToken: true },
      });

      // The claim is customer-driven, so the shop's approval policy decides
      // whether this occupies as a BOOKED row or an indefinite PENDING
      // request - both hold the chair, so both mirror.
      claimedApptId = appt.id;
      claimOutboxId = await recordMirrorIntent(tx, {
        shopId: offer.shopId,
        appointmentId: appt.id,
        staffId: offer.staffId,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        occupancy: {
          status: shop.requireBookingApproval ? "PENDING" : "BOOKED",
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
          holdExpiresAt: null, // a claimed offer is not an ephemeral hold
          visitId: null,
        },
      });

      // We hold the row lock, so this cannot lose a race - the WHERE status
      // guard is pure hygiene.
      await tx.waitlistOffer.update({
        where: { id: offer.id },
        data: { status: "CLAIMED", claimedAppointmentId: appt.id },
      });
      // The entry got what it was waiting for. updateMany: if the barber
      // REMOVED it meanwhile, the booking still stands - just don't resurrect
      // the entry's status.
      const linked = await tx.waitlistEntry.updateMany({
        where: { id: offer.entryId, status: { in: ["WAITING", "CONTACTED"] } },
        data: { status: "BOOKED", bookedAppointmentId: appt.id },
      });

      await recordWaitlistEvent(tx, {
        shopId: offer.shopId,
        entryId: offer.entryId,
        offerId: offer.id,
        appointmentId: appt.id,
        type: "offer.claimed",
        actor: CUSTOMER_ACTOR,
        metadata: {
          // Approval-mode shops get a PENDING request, not a confirmed
          // booking. Worth recording: it is the difference between "they have
          // the slot" and "they have asked for it".
          pending: shop.requireBookingApproval,
          // False when the barber REMOVED the entry mid-hold: the booking
          // still stands, but the entry was not resurrected.
          linked: linked.count > 0,
        },
      });

      return {
        outcome: "claimed" as const,
        appointmentId: appt.id,
        manageToken: appt.manageToken,
        shopId: offer.shopId,
        shopSlug: shop.slug,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        pending: shop.requireBookingApproval,
      };
    });

    // Block the chair in Acuity after the claim is durable. Best-effort: the
    // customer is mid-conversation on a link they were sent, and tearing the
    // claim down because Acuity was briefly unreachable would be worse than a
    // block the reconciler places a minute later.
    if (claimOutboxId && claimedApptId) {
      await dispatchAfterCommit(claimOutboxId, {
        shopId: claimResult && "shopId" in claimResult ? String(claimResult.shopId) : "",
        appointmentId: claimedApptId,
        via: "waitlist_claim",
      });
    }
    return claimResult;
  } catch (err) {
    if (err instanceof ServiceDayFullError) return { outcome: "day_full" };
    if (err instanceof SlotTakenError) {
      // The physical time is gone (admin override, block, or a ghost). The
      // hold can never be redeemed now - release it so the row's state says
      // what happened. Post-tx: the claim tx above rolled back.
      //
      // The release and its audit row go in ONE transaction of their own, so
      // the two cannot disagree - but the whole thing is swallowed, because
      // the customer is already being told slot_taken and a failure here must
      // not turn that into a 500.
      await prisma
        .$transaction(async (tx) => {
          const released = await tx.waitlistOffer.findFirst({
            where: { tokenHash: hash, status: "OFFERED" },
            select: { id: true, shopId: true, entryId: true },
          });
          if (!released) return;
          await tx.waitlistOffer.updateMany({
            where: { id: released.id, status: "OFFERED" },
            data: { status: "RELEASED" },
          });
          await recordWaitlistEvent(tx, {
            shopId: released.shopId,
            entryId: released.entryId,
            offerId: released.id,
            type: "offer.released",
            actor: CUSTOMER_ACTOR,
            metadata: { code: "slot_taken", via: "claim" },
          });
        })
        .catch(() => undefined);
      return { outcome: "slot_taken" };
    }
    throw err;
  }
}

/**
 * The expiry worker body. For each lapsed hold: compare-and-set to EXPIRED
 * (losing cleanly to a concurrent claim), then offer the slot to the NEXT
 * eligible entry - unless the shop's gates say no or DRY_RUN is on (an offer
 * nobody can be told about is a dead slot, so none is created).
 *
 * Idempotent and restart-safe: every step is a CAS or an insert guarded by
 * the overlap constraint, and each offer is processed in its own try/catch,
 * so a crash mid-batch just leaves work for the next tick.
 */
export async function expireDueOffers(
  now: Date = new Date(),
  opts?: {
    /** Test hook (mirrors the enabled overrides elsewhere): advance even under DRY_RUN. */
    forceAdvance?: boolean;
  },
): Promise<{ expired: number; advanced: number }> {
  const due = await prisma.waitlistOffer.findMany({
    where: { status: "OFFERED", expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
    take: 50,
    select: {
      id: true,
      shopId: true,
      entryId: true,
      staffId: true,
      serviceId: true,
      startsAt: true,
      endsAt: true,
    },
  });

  let expired = 0;
  let advanced = 0;
  for (const offer of due) {
    try {
      // The CAS and its audit row commit together: an offer that flipped to
      // EXPIRED with no record of it is the state that makes a bad sweep
      // unreviewable. A concurrent claim still wins - count 0 and we skip.
      const won = await prisma.$transaction(async (tx) => {
        const cas = await tx.waitlistOffer.updateMany({
          where: { id: offer.id, status: "OFFERED", expiresAt: { lte: now } },
          data: { status: "EXPIRED" },
        });
        if (cas.count === 0) return false;
        await recordWaitlistEvent(tx, {
          shopId: offer.shopId,
          entryId: offer.entryId,
          offerId: offer.id,
          type: "offer.expired",
          actor: SYSTEM_ACTOR,
          metadata: { at: "sweep" },
        });
        return true;
      });
      if (!won) continue; // claimed in the race - their win
      expired += 1;

      const advance = opts?.forceAdvance ?? !apiEnv().DRY_RUN;
      if (!advance) {
        logger.info(
          { shopId: offer.shopId, offerId: offer.id },
          "[dry-run] offer expired; advancement suppressed",
        );
        continue;
      }

      const shop = await prisma.shop.findUnique({
        where: { id: offer.shopId },
        select: {
          id: true,
          name: true,
          slug: true,
          timezone: true,
          bookingBufferMin: true,
          bookingMode: true,
          waitlistEnabled: true,
          slotOpenedTextsEnabled: true,
          requireBookingApproval: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          compAccess: true,
        },
      });
      // Same gates the original offer honored - a shop that lapsed or turned
      // the feature off mid-hold gets no further outreach.
      if (
        !shop ||
        shop.bookingMode !== "native" ||
        !shop.waitlistEnabled ||
        !shop.slotOpenedTextsEnabled ||
        !hasActiveAccess(shop, { now })
      ) {
        continue;
      }
      if (offer.startsAt.getTime() <= now.getTime()) continue; // slot in the past

      const next = await offerFreedSlot(
        {
          shopId: offer.shopId,
          staffId: offer.staffId,
          serviceId: offer.serviceId,
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
          timezone: shop.timezone,
          bufferMin: shop.bookingBufferMin,
        },
        now,
      );
      if (next.outcome !== "offered") continue;
      advanced += 1;
      // Best-effort: offerFreedSlot has already committed the new hold and
      // audited it as offer.created. This row only records that the new hold
      // came from a lapsed one, so the chain reads end to end.
      await recordWaitlistEventBestEffort({
        shopId: offer.shopId,
        entryId: next.entryId,
        offerId: next.offerId,
        type: "offer.advanced",
        actor: SYSTEM_ACTOR,
        metadata: { previousOfferId: offer.id },
      });

      const [service, staff] = await Promise.all([
        prisma.service.findFirst({
          where: { id: offer.serviceId, shopId: offer.shopId },
          select: { name: true },
        }),
        prisma.staff.findFirst({
          where: { id: offer.staffId, shopId: offer.shopId },
          select: { name: true },
        }),
      ]);
      await notifyOffer({
        shop: { id: shop.id, name: shop.name, slug: shop.slug, timezone: shop.timezone },
        offer: {
          entryId: next.entryId,
          startsAt: offer.startsAt,
          expiresAt: next.expiresAt,
          serviceName: service?.name ?? null,
          staffName: staff?.name ?? null,
          approvalRequired: shop.requireBookingApproval,
        },
        entry: next.entry,
        token: next.token,
        now,
      });
    } catch (err) {
      logger.error(
        { err, offerId: offer.id, shopId: offer.shopId },
        "offer expiry/advance failed; next tick retries",
      );
    }
  }

  if (expired > 0) {
    logger.info({ expired, advanced }, "waitlist offers expired");
  }
  return { expired, advanced };
}
