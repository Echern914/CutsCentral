import { Prisma, prisma, runAsOwner } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { AUTO_FILL_MIN_WAITLIST_HOLD_MS, AUTO_FILL_STAGE_MS, autoFillDeadline } from "./autoFillRules.js";
import { ACTIVE_WAITLIST_STATUSES, sha256Hex } from "./waitlistJoin.js";
import { entryPrefsMatchSlot } from "./waitlistMatch.js";
import {
  keysetAfter,
  scanCursorFrom,
  scanOrderBy,
  type ScanKeyPart,
} from "./waitlistScanOrder.js";
import {
  CUSTOMER_ACTOR,
  recordWaitlistEvent,
  recordWaitlistEventBestEffort,
  SYSTEM_ACTOR,
  type WaitlistActor,
} from "./waitlistAudit.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import { dispatchAfterCommit, recordMirrorIntent } from "./acuityMirror.js";
import { isMirrorNotConfigured, mirrorNotConfiguredSource } from "./mirrorNotConfigured.js";
import {
  lockStaffAndAssertSlotFree,
  SlotTakenError,
} from "./bookingWrite.js";
import { ServiceDayFullError } from "./serviceDailyLimit.js";
import { isSlotBookable } from "./slots.js";
import { effectivePriceAt } from "./pricing.js";
import { deriveAcuityClientKey } from "../acuity/clientKey.js";
import { connectEnabled } from "../billing/stripe.js";
import { hasPremiumAccess } from "../billing/entitlements.js";
import { depositChargeCents, toCents } from "../billing/payments.js";
import { collectsAtBooking } from "../services/appointmentPaymentHold.js";
import {
  buildWaitlistOfferCustomerEmail,
  buildWaitlistOfferCustomerPush,
  formatApptTime,
} from "../messaging/templates.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { sendPushToClient } from "../messaging/push.js";
import { fillBlankClientFields } from "../services/clientFill.js";
import { loadBookingBlocks } from "../services/clientBookingBlock.js";

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

/**
 * Test-only: the id of every candidate the scan VISITS, in visit order.
 *
 * `scanned` above is a COUNT, and a count cannot tell a correct walk from one
 * that skipped a row and visited another twice - the two cancel out exactly.
 * Proving a keyset cursor right needs identities, so the trace records them,
 * and only when a test asks: null in production, allocating nothing.
 */
let scanTrace: string[] | null = null;

/** Start (or stop) recording visited ids. Returns the live array. */
export function __setScanTraceForTests(on: boolean): readonly string[] {
  scanTrace = on ? [] : null;
  return scanTrace ?? [];
}

// Test seam for the deposit gate: connectEnabled() reads STRIPE_* env, which
// the suite deliberately runs without. Mirrors __setSendEmailForTests.
let connectOverride: boolean | undefined;
export function __setConnectEnabledForTests(v: boolean | undefined): void {
  connectOverride = v;
}
const connectOn = (): boolean => connectOverride ?? connectEnabled();

// Test seam for advancing a freed hold to the next person: production gates it
// on DRY_RUN (an offer nobody can be told about is a dead slot), which the
// suite runs with. Same shape as expireDueOffers' forceAdvance.
let advanceOverride: boolean | undefined;
export function __setAdvanceForTests(v: boolean | undefined): void {
  advanceOverride = v;
}

/**
 * The per-shop lock every offer CREATION takes, after the staff lock.
 *
 * 🔴 The staff lock alone let two cancellations on DIFFERENT barbers pick the
 * same any-barber entry at once: each read "no live offer" for them, each
 * inserted one, and that person got two holds and two emails while the next
 * person got nothing. The GiST constraint only covers one barber's span, and
 * nothing in the database says one live offer per entry. Serializing creation
 * per shop makes the second scan see the first one's offer.
 *
 * Lock order is staff, then this. Nothing takes them the other way round, and
 * nothing waits on another lock while holding this one.
 */
export const offerLockKey = (shopId: string): string => `wloffer:${shopId}`;

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
    requireCardToBook: boolean;
  },
  /**
   * The price the booking page would show for THIS slot - effectivePriceAt,
   * not the service's base price. A service with no base price and a
   * weekday or holiday override is paid on the page and was free here.
   */
  price: number | null,
): boolean {
  const fullCents = toCents(price);
  const chargeCents =
    shop.paymentsMode === "deposit"
      ? depositChargeCents(shop.depositAmountCents, fullCents)
      : fullCents;
  // The public create's own question (services/appointmentPaymentHold.ts),
  // so a claim never books what the booking page would hold for money.
  const collects = collectsAtBooking({
    connectEnabled: connectOn(),
    paymentsMode: shop.paymentsMode,
    requireBookingApproval: shop.requireBookingApproval,
    connectChargesEnabled: shop.connectChargesEnabled,
    stripeConnectAccountId: shop.stripeConnectAccountId,
    chargeCents,
  });
  if (collects === "payment") return chargeCents !== null && chargeCents > 0;
  // 🔴 A shop that REQUIRES a saved card books nobody without one, and a
  // claim has no card step: it booked them card-less, which is exactly what
  // the setting exists to stop. (A card shop with the card optional books
  // claims as it books Confirm on the page.)
  if (collects === "card") return shop.requireCardToBook;
  return false;
}

/**
 * What the booking page charges for this service at this instant: the base
 * price through its weekday, holiday and time-of-day overrides. The money
 * gate must read this, never the base price alone.
 */
export function slotPrice(
  service: {
    price: Prisma.Decimal | number | null;
    priceOverrides: Prisma.JsonValue;
    dateOverrides: Prisma.JsonValue;
    timeOverrides: Prisma.JsonValue;
  } | null,
  at: Date,
  timezone: string,
): number | null {
  if (!service) return null;
  return effectivePriceAt(service.price === null ? null : Number(service.price), {
    at,
    timezone,
    weekdayOverrides: service.priceOverrides,
    dateOverrides: service.dateOverrides,
    timeWindows: service.timeOverrides,
  });
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
  | { outcome: "requires_deposit" }
  /**
   * An Auto-fill shop, and the hold that would be left before its deadline
   * (start - minimum notice - margin) is too short for anyone to act on.
   */
  | { outcome: "too_soon" };

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
        requireCardToBook: true,
        autoFillEnabled: true,
        bookingLeadHours: true,
      },
    }),
    prisma.service.findFirst({
      where: { id: slot.serviceId, shopId: slot.shopId },
      select: { price: true, priceOverrides: true, dateOverrides: true, timeOverrides: true },
    }),
  ]);
  if (!policyShop) return { outcome: "unavailable" };
  if (claimWouldRequirePayment(policyShop, slotPrice(policyService, slot.startsAt, slot.timezone))) {
    logger.info(
      { shopId: slot.shopId, serviceId: slot.serviceId },
      "waitlist offer skipped: service requires a deposit; entries stay WAITING for manual handling",
    );
    return { outcome: "requires_deposit" };
  }

  // Never held past its own start: a hold that outlives the time it holds
  // tells the customer they have until a moment the slot no longer exists.
  let expiresAt = new Date(Math.min(now.getTime() + HOLD_MS, slot.startsAt.getTime()));
  // 🔴 AN AUTO-FILL SHOP KEEPS THE LINE MOVING: 15 minutes each, the same as
  // its Gold and Silver stages, and never past its deadline - so a claim never
  // lands inside the minimum notice the shop asks of everyone else, and the
  // booking page gets the time back while it can still be booked. Every
  // advance comes through here, so each next person gets the same rule.
  if (policyShop.autoFillEnabled) {
    const deadline = autoFillDeadline(slot.startsAt, policyShop.bookingLeadHours);
    expiresAt = new Date(Math.min(now.getTime() + AUTO_FILL_STAGE_MS, deadline.getTime(), expiresAt.getTime()));
    if (expiresAt.getTime() - now.getTime() < AUTO_FILL_MIN_WAITLIST_HOLD_MS) return { outcome: "too_soon" };
  }
  const outsiders = await sameSlotOutsiders(slot);
  const { token, hash } = mintClaimToken();

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Serialize against every other writer on this barber; throws
      // SlotTakenError when an appointment, targeted slot, synced visit or
      // ANOTHER ACTIVE HOLD overlaps. Day cap asserted too - offering a slot
      // the cap would refuse at booking time is a dead offer.
      await lockStaffAndAssertSlotFree(tx, {
        walkInCapacity: "enforce",
        staffId: slot.staffId,
        shopId: slot.shopId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: slot.bufferMin,
        serviceDayLimit: { serviceId: slot.serviceId, timezone: slot.timezone },
        now,
      });
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${offerLockKey(slot.shopId)}))`,
      );

      // 🔴 INSERT THE HOLD, THEN LOCK AND RE-READ THE ENTRY. The scan saw the
      // entry WAITING, but the customer may be leaving at this moment
      // (leaveWaitlistEntry, or the barber's Remove), and a hold minted for
      // someone who just left keeps the time from everyone for half an hour.
      // FOR SHARE waits out a leave in flight, so the status read is the
      // committed one; anything not WAITING gets its hold deleted and the next
      // person is tried. A leave that starts after this lock waits for our
      // commit and then releases what we made (releaseRacedOffers).
      //
      // The ORDER is load-bearing. Locking the entry BEFORE the insert can
      // deadlock: a leave that has just released an overlapping lapsed hold
      // waits on our entry lock, while our insert's overlap check waits on
      // that leave. Inserted first, we hold nothing a leave needs (advisory
      // locks it never takes, a row it cannot see, and the foreign key's KEY
      // SHARE, which its update does not conflict with).
      const skipped = new Set<string>();
      let made: {
        offer: { id: string };
        candidate: NonNullable<Awaited<ReturnType<typeof pickCandidate>>>;
      } | null = null;
      for (let attempt = 0; attempt < 5 && !made; attempt++) {
        const pick = await pickCandidate(tx, slot, now, skipped, outsiders);
        if (!pick) break;
        const offer = await tx.waitlistOffer.create({
          data: {
            shopId: slot.shopId,
            entryId: pick.id,
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
        const [row] = await tx.$queryRaw<{ status: string }[]>(
          Prisma.sql`SELECT status FROM "WaitlistEntry" WHERE id = ${pick.id} FOR SHARE`,
        );
        if (row?.status === "WAITING") {
          made = { offer, candidate: pick };
        } else {
          await tx.waitlistOffer.delete({ where: { id: offer.id } });
          skipped.add(pick.id);
        }
      }
      if (!made) return null;
      const { offer, candidate } = made;
      // Same transaction as the hold itself: a slot held for someone with no
      // record of why is exactly the state F1 exists to prevent.
      await recordWaitlistEvent(tx, {
        shopId: slot.shopId,
        entryId: candidate.id,
        offerId: offer.id,
        type: "offer.created",
        actor: SYSTEM_ACTOR,
        metadata: {
          // The REAL length: a hold is capped at the slot's start.
          holdMinutes: Math.round((expiresAt.getTime() - now.getTime()) / 60_000),
          scanned: __lastScanStatsForTests.scanned,
          pages: __lastScanStatsForTests.pages,
        },
      });
      return { offer, candidate };
    });

    if (!created) return { outcome: "no_candidates" };
    // 🔴 A live offer OWNS that slot until it lapses - the slot engine already
    // subtracts it, but the public page would keep serving a cached day that
    // still showed it. Anyone else tapping it would be refused, and the
    // customer the slot was promised to could lose it to that race.
    await noteAvailabilityChanged(slot.shopId);
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

export interface SlotOutsiders {
  clientIds: Set<string>;
  /** Lowercased. */
  emails: Set<string>;
}

/**
 * The people the waitlist must NOT be offered this exact time:
 *
 *   - whoever just cancelled it. They gave it up; handing it back to their
 *     own waitlist request a minute later is noise, and after a client cancel
 *     at an Auto-fill shop it would undo the reason the time is free;
 *   - the members Auto-fill already offered it to in the app. They saw it and
 *     let it pass; the waitlist stage is for the next people in line.
 *
 * Matched by record and by email, never by a phone alone (a shared phone is
 * not the same person) - the same rule as the per-person same-slot check.
 * Read before the hold's transaction, on the owner connection: the
 * invitations are platform-owned.
 */
async function sameSlotOutsiders(slot: FreedSlot): Promise<SlotOutsiders> {
  const out: SlotOutsiders = { clientIds: new Set(), emails: new Set() };
  const add = (clientId: string | null, ...emails: (string | null | undefined)[]) => {
    if (clientId) out.clientIds.add(clientId);
    for (const e of emails) if (e?.trim()) out.emails.add(e.trim().toLowerCase());
  };
  await runAsOwner(async (tx) => {
    const [cancelled, invited] = await Promise.all([
      tx.appointment.findMany({
        where: { shopId: slot.shopId, staffId: slot.staffId, startsAt: slot.startsAt, status: "CANCELED" },
        select: { clientId: true, email: true, client: { select: { email: true } } },
      }),
      tx.tierOpeningRecipient.findMany({
        where: { opening: { shopId: slot.shopId, staffId: slot.staffId, startsAt: slot.startsAt, source: "auto" } },
        select: { clientId: true, client: { select: { email: true } } },
      }),
    ]);
    for (const c of cancelled) add(c.clientId, c.email, c.client?.email);
    for (const i of invited) add(i.clientId, i.client.email);
  });
  return out;
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
  /** Entries already found to have left between the scan and their lock. */
  exclude: ReadonlySet<string> = new Set(),
  /** People who must not be offered this time at all (sameSlotOutsiders). */
  outsiders: SlotOutsiders = { clientIds: new Set(), emails: new Set() },
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
  let cursor: ScanKeyPart[] | null = null;
  // A client the shop blocked from booking is never offered a time: the claim
  // would refuse them, and a hold nobody can take is the next person's time
  // lost for the length of the hold. Loaded once for the whole walk.
  const blocks = await loadBookingBlocks(tx, slot.shopId);

  // 🔴 "NEVER THIS EXACT SLOT AGAIN" IS PER PERSON, not only per entry. One
  // person can hold two requests at a shop (Saturday, and also Tuesday), and
  // the per-entry rule alone handed a time they had just passed on, or let
  // lapse, straight to their OTHER request seconds later. Matched on email and
  // the linked client only - never a phone alone, because a shared phone is
  // not the same person.
  const prior = await tx.waitlistOffer.findMany({
    where: { shopId: slot.shopId, staffId: slot.staffId, startsAt: slot.startsAt },
    select: { entry: { select: { email: true, clientId: true } } },
  });
  const priorEmails = new Set(
    prior.map((p) => p.entry.email?.trim().toLowerCase()).filter((e): e is string => Boolean(e)),
  );
  const priorClients = new Set(
    prior.map((p) => p.entry.clientId).filter((c): c is string => Boolean(c)),
  );

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
    //
    // 🔴 The predicate is GENERATED from the same list as the orderBy below
    // (engines/waitlistScanOrder.ts) rather than written out here a second
    // time. Hand-writing both is how a resume predicate and a sort order
    // drift apart, and when they drift the walk silently skips rows.
    if (cursor) and.push(keysetAfter(cursor));
    if (exclude.size > 0) and.push({ id: { notIn: [...exclude] } });
    const batch = await tx.waitlistEntry.findMany({
      where: {
        shopId: slot.shopId,
        status: "WAITING",
        AND: and,
      },
      // Deterministic ranking: earliest joiner first, id as the stable
      // tie-breaker for same-instant joins (and the cursor anchor). Same
      // source as the keyset predicate above - see waitlistScanOrder.ts.
      orderBy: scanOrderBy(),
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        createdAt: true,
        // The ranking key. Selected because the CURSOR is read off the last
        // row of each page (scanCursorFrom), not because the walk below looks
        // at it - the ordering lives entirely in waitlistScanOrder.ts.
        tierRank: true,
        firstName: true,
        email: true,
        phone: true,
        clientId: true,
        timezone: true,
        minHoursNotice: true,
        windows: {
          select: { startDate: true, endDate: true, startMin: true, endMin: true },
        },
      },
    });
    if (batch.length === 0) break;
    pages += 1;
    cursor = scanCursorFrom(batch[batch.length - 1]!);

    // Which candidates on this page need a Client, and how we find it.
    //
    // Only the ones with NO email: an address is the first reachable channel
    // the walk below checks, so an emailed candidate never consults a client
    // record at all. That is today's behaviour and it does not move here.
    //
    // 🔑 THE LINK IS A PREFERENCE, NOT A REPLACEMENT. clientId holds the same
    // answer this phone lookup produces, computed once and stored
    // (engines/waitlistClientLink.ts) - but the phone query still runs over
    // every email-less candidate exactly as it does today, and the link is
    // only used when it resolves to a LIVE client.
    //
    // That is deliberate, and it is what makes this change a no-op. Narrowing
    // the phone query to unlinked rows would look tidier and would lose a
    // real case: archive a duplicate client and re-add the same person, and
    // the entry's link now points at the archived row while the phone points
    // at the live one. Today that entry is reachable. It stays reachable.
    //
    // Both halves keep archivedAt: null - an archived client was never
    // pushable and a link must not quietly change that. Two queries per page
    // at most, both bounded by the page (no N+1), and the id lookup is a
    // primary-key hit that does not fire at all until rows have links.
    const linkIds = batch.filter((c) => !c.email && c.clientId).map((c) => c.clientId!);
    const phoneOnly = batch.filter((c) => !c.email && c.phone).map((c) => c.phone!);

    const liveLinks = new Set<string>();
    if (linkIds.length > 0) {
      const linked = await tx.client.findMany({
        where: { shopId: slot.shopId, id: { in: linkIds }, archivedAt: null },
        select: { id: true },
      });
      for (const cl of linked) liveLinks.add(cl.id);
    }

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
      scanTrace?.push(c.id);
      try {
        if (blocks.covers({ clientId: c.clientId, phone: c.phone, email: c.email })) {
          logger.debug(
            { shopId: slot.shopId, entryId: c.id, code: "booking_blocked" },
            "waitlist match: candidate skipped",
          );
          continue;
        }
        if (
          (c.email && priorEmails.has(c.email.trim().toLowerCase())) ||
          (c.clientId && priorClients.has(c.clientId))
        ) {
          logger.debug(
            { shopId: slot.shopId, entryId: c.id, code: "same_person_same_slot" },
            "waitlist match: candidate skipped",
          );
          continue;
        }
        if (
          (c.email && outsiders.emails.has(c.email.trim().toLowerCase())) ||
          (c.clientId && outsiders.clientIds.has(c.clientId))
        ) {
          logger.debug(
            { shopId: slot.shopId, entryId: c.id, code: "already_had_it" },
            "waitlist match: candidate skipped",
          );
          continue;
        }
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
        const clientId =
          c.clientId && liveLinks.has(c.clientId)
            ? c.clientId
            : c.phone
              ? pushable.get(c.phone)
              : undefined;
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
    /**
     * When given, the send first checks the hold is still live and its entry
     * still on the list. Production callers always pass it.
     */
    offerId?: string;
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
  // 🔴 A hold minted in the same instant its person LEFT is let go right
  // after (releaseRacedOffers) - but the caller of offerFreedSlot was already
  // on its way here. Without this check the person who had just left was
  // told "this spot is being held for you", and their link said expired.
  if (offer.offerId) {
    const live = await prisma.waitlistOffer.findFirst({
      where: { id: offer.offerId, shopId: shop.id, status: "OFFERED" },
      select: { entry: { select: { status: true } } },
    });
    if (!live || !(ACTIVE_WAITLIST_STATUSES as readonly string[]).includes(live.entry.status)) {
      logger.info(
        { shopId: shop.id, offerId: offer.offerId, code: "hold_gone_before_send" },
        "waitlist offer not sent: the hold ended before it could be announced",
      );
      return;
    }
  }
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
      // The REAL hold: capped at the slot's start, so it can be under 30.
      holdMinutes: Math.max(1, Math.round((offer.expiresAt.getTime() - now.getTime()) / 60_000)),
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
  | { outcome: "deposit_required" }
  /**
   * The shop is ENFORCING an outbound mirror and the chair cannot be
   * protected, so redeeming would confirm a slot the external calendar still
   * shows as free. The offer is left alone: this is a shop-configuration
   * problem, and burning the customer's hold over it would be unfair to them.
   */
  | { outcome: "unavailable_external" }
  /**
   * The shop blocked this client from booking online after the offer went out
   * (offers skip blocked clients, so only a block landing mid-hold reaches
   * this). The offer is RELEASED, as for a deposit, and nothing is written.
   */
  | { outcome: "contact_shop" };

/**
 * Redeem a claim token: revalidate and book ATOMICALLY.
 *
 * The slot is re-asserted under the SAME advisory-lock protocol as every other
 * Appointment write (this offer's own hold excluded so it cannot block its own
 * redemption), and THEN the offer row is locked FOR UPDATE - the order every
 * barber write takes them in, so the two queue instead of deadlocking. A
 * concurrent claim of the same token, the expiry worker's compare-and-set, a
 * leave and an admin release all serialize on the row: exactly one of them
 * decides the offer's fate.
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
  let claimOutboxIds: string[] = [];
  let claimedApptId: string | null = null;
  // A hold this claim ENDED without booking it (arrived too late, or the shop
  // has since blocked the client): after commit it goes to the next person,
  // exactly as if the sweep had found it. Before this, a late tap ended the
  // line there - the sweep only ever looks at OFFERED rows.
  let endedHold: OfferSpan | null = null;

  try {
    const claimResult = await prisma.$transaction(async (tx) => {
      endedHold = null;
      // 🔴 LOCK ORDER: the barber's STAFF lock before this offer's ROW (the
      // order every booking write takes them in - bookingWrite.ts header).
      // Locking the row first deadlocked against a barber booking over the
      // hold: it holds the staff lock and then releases this row, while this
      // claim held the row and waited for the staff lock. Postgres killed one
      // of them and the loser got a 500. So: read unlocked, guard, then lock.
      const offer = await tx.waitlistOffer.findUnique({
        where: { tokenHash: hash },
        include: {
          entry: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              instagram: true,
              phone: true,
              email: true,
              status: true,
            },
          },
        },
      });
      if (!offer) return { outcome: "invalid" as const };
      if (offer.status !== "OFFERED") return { outcome: "expired" as const };
      // Whoever holds the row decides this offer's fate. Branches that only
      // END the hold take the row alone (no staff lock, like a leave); the
      // booking branch takes it after the guard.
      const lockRow = async () => {
        const [row] = await tx.$queryRaw<{ status: string; expiresAt: Date }[]>(
          Prisma.sql`SELECT status, "expiresAt" FROM "WaitlistOffer" WHERE id = ${offer.id} FOR UPDATE`,
        );
        return row?.status === "OFFERED" ? row : null;
      };
      if (offer.expiresAt.getTime() <= now.getTime()) {
        if (!(await lockRow())) return { outcome: "expired" as const };
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
        endedHold = spanOf(offer);
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
            requireCardToBook: true,
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

      // Money re-check at REDEMPTION: offers are never created for paid (or
      // card-required) services, but the shop can change that mid-hold.
      // Refuse rather than mint an unpaid or card-less appointment; release
      // the hold so the slot returns to the pool and the entry stays WAITING.
      if (claimWouldRequirePayment(shop, slotPrice(service, offer.startsAt, shop.timezone))) {
        if (!(await lockRow())) return { outcome: "expired" as const };
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

      const firstName = params.customer?.firstName?.trim() || offer.entry.firstName;
      const lastName = params.customer?.lastName?.trim() || offer.entry.lastName || null;
      const email = params.customer?.email?.trim() || offer.entry.email || null;
      const phone = params.customer?.phone?.trim() || offer.entry.phone || null;

      // A client the shop blocked since the offer went out books nothing -
      // checked against the joined contact AND the claim form's, since either
      // would land the booking. Released like a deposit refusal, so the time
      // goes back rather than sitting held for someone who can't take it.
      const blocks = await loadBookingBlocks(tx, offer.shopId);
      if (
        blocks.covers({ phone: offer.entry.phone, email: offer.entry.email }) ||
        blocks.covers({ phone, email })
      ) {
        if (!(await lockRow())) return { outcome: "expired" as const };
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
          metadata: { code: "contact_shop", via: "claim" },
        });
        endedHold = spanOf(offer);
        return { outcome: "contact_shop" as const };
      }

      // Same guard as every booking write; our own hold must not block us.
      await lockStaffAndAssertSlotFree(tx, {
        walkInCapacity: "enforce",
        staffId: offer.staffId,
        shopId: offer.shopId,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
        bufferMin: shop.bookingBufferMin,
        waitlistOfferIdToIgnore: offer.id,
        serviceDayLimit: { serviceId: offer.serviceId, timezone: shop.timezone },
        now,
      });
      // Now the row: a leave, a decline, the sweep or a barber may have ended
      // the hold while this claim waited for the barber's lock.
      const live = await lockRow();
      if (!live) return { outcome: "expired" as const };
      if (live.expiresAt.getTime() <= now.getTime()) {
        await tx.waitlistOffer.update({ where: { id: offer.id }, data: { status: "EXPIRED" } });
        await recordWaitlistEvent(tx, {
          shopId: offer.shopId,
          entryId: offer.entryId,
          offerId: offer.id,
          type: "offer.expired",
          actor: CUSTOMER_ACTOR,
          metadata: { at: "claim" },
        });
        endedHold = spanOf(offer);
        return { outcome: "expired" as const };
      }
      // The handle the customer gave when they joined. The claim itself asks
      // for nothing new: a held slot is never refused over a name, and entries
      // from before the last-name-or-Instagram rule simply carry neither.
      const instagram = offer.entry.instagram;

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
          instagram,
          phone,
          email,
          source: "manual",
        },
        // 🔴 Never overwrite an existing client from a public claim - a shared
        // phone is not the same person (services/clientFill.ts).
        update: {},
        select: { id: true },
      });
      await fillBlankClientFields(tx, client.id, { firstName, lastName, phone, email });
      // FILL a missing handle, never replace one: the claim's phone is typed,
      // not proven, and the barber is the one who corrects a handle.
      if (instagram) {
        await tx.client.updateMany({
          where: { id: client.id, instagram: null },
          data: { instagram },
        });
      }

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
      claimOutboxIds = await recordMirrorIntent(tx, {
        shopId: offer.shopId,
        now,
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
    if (claimOutboxIds.length > 0 && claimedApptId) {
      await dispatchAfterCommit(claimOutboxIds, {
        shopId: claimResult && "shopId" in claimResult ? String(claimResult.shopId) : "",
        appointmentId: claimedApptId,
        via: "waitlist_claim",
      });
    }
    // The hold became a real booking. Same slot, different reason - but the
    // cached public day was built before either existed.
    if (claimResult && "shopId" in claimResult) {
      await noteAvailabilityChanged(String(claimResult.shopId));
    }
    // Best-effort: the customer's answer is already decided, and a failure to
    // reach the next person must not turn it into a 500.
    // (Assigned inside the transaction callback, which TS cannot follow.)
    const ended = endedHold as OfferSpan | null;
    if (ended) {
      await advanceFreedSlot(ended, now).catch((err) =>
        logger.error({ err, offerId: ended.id }, "waitlist: advance after claim-time end failed"),
      );
    }
    return claimResult;
  } catch (err) {
    if (err instanceof ServiceDayFullError) return { outcome: "day_full" };
    if (isMirrorNotConfigured(err)) {
      logger.error(
        { token: "redacted", staffId: err.staffId, mirror: mirrorNotConfiguredSource(err) },
        "mirror: ENFORCE with an unmapped chair - waitlist claim refused",
      );
      return { outcome: "unavailable_external" };
    }
    if (err instanceof SlotTakenError) {
      // The physical time is gone (admin override, block, or a ghost). The
      // hold can never be redeemed now - release it so the row's state says
      // what happened. Post-tx: the claim tx above rolled back.
      //
      // The release and its audit row go in ONE transaction of their own, so
      // the two cannot disagree - but the whole thing is swallowed, because
      // the customer is already being told slot_taken and a failure here must
      // not turn that into a 500.
      //
      // The guard now runs BEFORE the offer row is locked, so a second tap of
      // the same link that queued behind the first lands here (the first one's
      // appointment is in the way). That is not "taken by someone else": the
      // hold is simply over, and it says so.
      let holdStillLive = true;
      await prisma
        .$transaction(async (tx) => {
          const released = await tx.waitlistOffer.findFirst({
            where: { tokenHash: hash, status: "OFFERED" },
            select: { id: true, shopId: true, entryId: true },
          });
          if (!released) {
            holdStillLive = false;
            return;
          }
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
      // (Assigned inside the transaction callback, which TS cannot follow.)
      return (holdStillLive as boolean) ? { outcome: "slot_taken" } : { outcome: "expired" };
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
      if (await advanceFreedSlot(offer, now, opts)) advanced += 1;
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

/** Where a hold was, and whose: what moving it to the next person needs. */
export interface OfferSpan {
  id: string;
  shopId: string;
  entryId: string;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
}

function spanOf(o: OfferSpan): OfferSpan {
  return {
    id: o.id,
    shopId: o.shopId,
    entryId: o.entryId,
    staffId: o.staffId,
    serviceId: o.serviceId,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
  };
}

/**
 * A hold just ended without being booked - lapsed, passed on, left behind, or
 * let go by the barber. Offer the time to the NEXT person in line.
 *
 * 🔴 ONE FUNCTION FOR EVERY WAY A HOLD ENDS. The sweep used to be the only
 * thing that advanced, and it only sees OFFERED rows, so every other ending
 * (a late tap, a released hold, a customer leaving the list) left the time
 * public with nobody told. Every ending now calls this, so the gates below
 * cannot drift apart between them.
 *
 * Returns whether someone new was offered it. Called after the ending has
 * committed; throws only on a database failure, which callers log.
 */
export async function advanceFreedSlot(
  offer: OfferSpan,
  now: Date,
  opts?: { forceAdvance?: boolean },
): Promise<boolean> {
  // The hold ended, so the chair is FREE again - and the cached day was built
  // while it was held. Staleness in this direction costs the shop a booking
  // rather than double-booking it, which is why it went unnoticed.
  await noteAvailabilityChanged(offer.shopId);

  const next = await offerFreedSlotToWaitlist(offer, now, opts);
  if (!next) return false;
  // Best-effort: offerFreedSlot has already committed the new hold and
  // audited it as offer.created. This row only records that the new hold came
  // from an ended one, so the chain reads end to end.
  await recordWaitlistEventBestEffort({
    shopId: offer.shopId,
    entryId: next.entryId,
    offerId: next.offerId,
    type: "offer.advanced",
    actor: SYSTEM_ACTOR,
    metadata: { previousOfferId: offer.id },
  });
  return true;
}

/** A freed span on one barber, for one service. */
export interface FreedSpan {
  shopId: string;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Offer a freed span to the next person on the waitlist, through every gate
 * the waitlist has - DRY_RUN, a native calendar, the waitlist and its offers
 * switched on, the plan, a time still ahead - and tell them. The one way in
 * for anything that ends a hold: an ended waitlist hold (advanceFreedSlot),
 * and Auto-fill handing on after the tiers (engines/autoFill.ts).
 *
 * Returns the new offer, or null when nobody was offered it.
 */
export async function offerFreedSlotToWaitlist(
  span: FreedSpan,
  now: Date,
  opts?: { forceAdvance?: boolean },
): Promise<{ offerId: string; entryId: string } | null> {
  const advance = opts?.forceAdvance ?? advanceOverride ?? !apiEnv().DRY_RUN;
  if (!advance) {
    logger.info({ shopId: span.shopId }, "[dry-run] freed time not offered to the waitlist");
    return null;
  }
  const offer = span;

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
      plan: true,
    },
  });
  // Same gates the original offer honored - a shop that lapsed, dropped to a
  // plan without texts, or turned the feature off mid-hold gets no further
  // outreach.
  if (
    !shop ||
    shop.bookingMode !== "native" ||
    !shop.waitlistEnabled ||
    !shop.slotOpenedTextsEnabled ||
    !hasPremiumAccess(shop, { now })
  ) {
    return null;
  }
  if (offer.startsAt.getTime() <= now.getTime()) return null; // slot in the past

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
  if (next.outcome !== "offered") return null;

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
      offerId: next.offerId,
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
  return { offerId: next.offerId, entryId: next.entryId };
}

/** Advance each ended hold in turn; one failure never stops the rest. */
export async function advanceEach(spans: OfferSpan[], now: Date): Promise<number> {
  let advanced = 0;
  for (const span of spans) {
    try {
      if (await advanceFreedSlot(span, now)) advanced += 1;
    } catch (err) {
      logger.error({ err, offerId: span.id, shopId: span.shopId }, "waitlist: advance failed");
    }
  }
  return advanced;
}

/**
 * Let go of every live hold an entry has, inside the caller's transaction.
 *
 * 🔴 LOCK ORDER: the OFFER rows first, then (in the caller) the entry. That is
 * the order claimOffer takes them in - offer row, then the entry it books -
 * so a leave and a claim on the same hold queue instead of deadlocking.
 * Nothing here takes a staff lock.
 *
 * Holds still marked OFFERED after their expiry (the sweep has not reached
 * them) are let go too, and returned like the rest: the caller advances them,
 * because the sweep never will once they are not OFFERED.
 */
export async function releaseLiveOffersForEntry(
  tx: Prisma.TransactionClient,
  params: {
    shopId: string;
    entryId: string;
    /** Why, as a machine code: "left", "declined", "removed", "booked", "expired". */
    code: string;
    via: string;
    actor: WaitlistActor;
  },
): Promise<OfferSpan[]> {
  const locked = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM "WaitlistOffer"
               WHERE "entryId" = ${params.entryId} AND "shopId" = ${params.shopId}
                 AND status = 'OFFERED'
               ORDER BY id
               FOR UPDATE`,
  );
  const ended: OfferSpan[] = [];
  for (const { id } of locked) {
    const cas = await tx.waitlistOffer.updateMany({
      where: { id, status: "OFFERED" },
      data: { status: "RELEASED" },
    });
    if (cas.count === 0) continue;
    const row = await tx.waitlistOffer.findUnique({
      where: { id },
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
    if (!row) continue;
    await recordWaitlistEvent(tx, {
      shopId: params.shopId,
      entryId: params.entryId,
      offerId: id,
      type: "offer.released",
      actor: params.actor,
      metadata: { code: params.code, via: params.via },
    });
    ended.push(spanOf(row));
  }
  return ended;
}

/**
 * The second pass after an entry LEFT the list (customer or barber): let go of
 * any hold minted for it in the same instant.
 *
 * offerFreedSlot re-reads the entry under a share lock before minting, so it
 * never holds for someone who has already left. But a leave that began AFTER
 * that re-read waits for the offer to commit, and its own pass over the
 * entry's holds ran before the offer existed. This pass runs once the leave
 * has committed, sees that offer, and lets it go. It does nothing when the
 * entry is active again (the barber put it back meanwhile).
 */
export async function releaseRacedOffers(params: {
  shopId: string;
  entryId: string;
  code: string;
  via: string;
  actor: WaitlistActor;
}): Promise<OfferSpan[]> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.waitlistEntry.findFirst({
      where: { id: params.entryId, shopId: params.shopId },
      select: { status: true },
    });
    if (!entry || (ACTIVE_WAITLIST_STATUSES as readonly string[]).includes(entry.status)) {
      return [];
    }
    return releaseLiveOffersForEntry(tx, params);
  });
}

/**
 * A customer takes themselves off the waitlist: the emailed cancel link, the
 * offer page's "Take me off the waitlist", and (later) their own list.
 *
 * 🔴 LEAVING FREES THE TIME. It used to mark the entry REMOVED and nothing
 * else, so a live hold for them stayed live: the time was hidden from
 * everyone for up to half an hour, the link still booked it for someone who
 * had left, and the next person in line never heard. Now the hold is let go
 * in the same transaction and offered onward once it commits.
 *
 * Returns whether an active entry was found and removed. Callers that answer
 * a bearer token keep their response constant regardless.
 */
export async function leaveWaitlistEntry(params: {
  where: { cancelTokenHash: string } | { id: string; shopId: string };
  /** Where they left from, for the audit trail. */
  source: string;
  now?: Date;
}): Promise<{ left: boolean; shopId: string | null; advanced: number }> {
  const now = params.now ?? new Date();
  const result = await prisma.$transaction(async (tx) => {
    const entry = await tx.waitlistEntry.findFirst({
      where: { ...params.where, status: { in: [...ACTIVE_WAITLIST_STATUSES] } },
      select: { id: true, shopId: true, status: true },
    });
    if (!entry) return null;
    const ended = await releaseLiveOffersForEntry(tx, {
      shopId: entry.shopId,
      entryId: entry.id,
      code: "left",
      via: params.source,
      actor: CUSTOMER_ACTOR,
    });
    const cas = await tx.waitlistEntry.updateMany({
      where: { id: entry.id, status: { in: [...ACTIVE_WAITLIST_STATUSES] } },
      // dedupeKey is cleared so the same person can rejoin for the same thing.
      // The partial index only covers active rows, but clearing it also stops
      // a cancelled row colliding if it is ever reactivated by hand.
      data: { status: "REMOVED", dedupeKey: null },
    });
    if (cas.count > 0) {
      await recordWaitlistEvent(tx, {
        shopId: entry.shopId,
        entryId: entry.id,
        type: "entry.cancelled_by_customer",
        actor: CUSTOMER_ACTOR,
        metadata: { source: params.source, fromStatus: entry.status, toStatus: "REMOVED" },
      });
    }
    return { entry, ended, left: cas.count > 0 };
  });
  if (!result) return { left: false, shopId: null, advanced: 0 };

  const raced = result.left
    ? await releaseRacedOffers({
        shopId: result.entry.shopId,
        entryId: result.entry.id,
        code: "left",
        via: params.source,
        actor: CUSTOMER_ACTOR,
      }).catch((err) => {
        logger.error({ err, shopId: result.entry.shopId }, "waitlist leave: raced-offer pass failed");
        return [] as OfferSpan[];
      })
    : [];
  const advanced = await advanceEach([...result.ended, ...raced], now);
  return { left: result.left, shopId: result.entry.shopId, advanced };
}

export type DeclineResult =
  /** The hold is let go and offered onward. `left` = also off the waitlist. */
  | { outcome: "declined"; left: boolean }
  | { outcome: "invalid" }
  /** Expired, released, or already claimed - nothing left to pass on. */
  | { outcome: "expired" };

/**
 * "No thanks" from the offer page: pass the held time to the next person now
 * rather than make them wait out the hold. With `leave`, also take the
 * customer off the waitlist entirely (the offer email is the only message
 * most of them have, and it had no way out).
 *
 * Same row-lock-first discipline as claimOffer, so a decline and a claim on
 * one token serialize: exactly one of them decides the hold.
 */
export async function declineOffer(params: {
  token: string;
  leave: boolean;
  now?: Date;
}): Promise<DeclineResult> {
  const now = params.now ?? new Date();
  const hash = sha256Hex(params.token);
  let ended: OfferSpan | null = null;
  let leftEntry: { shopId: string; entryId: string } | null = null;

  const result = await prisma.$transaction(async (tx): Promise<DeclineResult> => {
    ended = null;
    leftEntry = null;
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM "WaitlistOffer" WHERE "tokenHash" = ${hash} FOR UPDATE`,
    );
    if (locked.length === 0) return { outcome: "invalid" };
    const offer = await tx.waitlistOffer.findUnique({
      where: { id: locked[0]!.id },
      select: {
        id: true,
        shopId: true,
        entryId: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        endsAt: true,
        status: true,
        expiresAt: true,
        entry: { select: { status: true } },
      },
    });
    if (!offer) return { outcome: "invalid" };

    // Pass the hold on, if it is still one.
    let passed = false;
    if (offer.status === "OFFERED") {
      if (offer.expiresAt.getTime() <= now.getTime()) {
        // Too late to pass on - it already lapsed. Record it as the lapse it
        // is, and still hand it onward (the sweep would have; it won't now).
        await tx.waitlistOffer.update({ where: { id: offer.id }, data: { status: "EXPIRED" } });
        await recordWaitlistEvent(tx, {
          shopId: offer.shopId,
          entryId: offer.entryId,
          offerId: offer.id,
          type: "offer.expired",
          actor: CUSTOMER_ACTOR,
          metadata: { at: "decline" },
        });
      } else {
        await tx.waitlistOffer.update({ where: { id: offer.id }, data: { status: "RELEASED" } });
        await recordWaitlistEvent(tx, {
          shopId: offer.shopId,
          entryId: offer.entryId,
          offerId: offer.id,
          type: "offer.released",
          actor: CUSTOMER_ACTOR,
          metadata: { code: "declined", via: "offer_page" },
        });
        passed = true;
      }
      ended = spanOf(offer);
    }

    // 🔴 LEAVING WORKS FROM ANY OFFER LINK, live or not. The offer email is
    // the only message most waitlisters have, and most of them read it after
    // the hold has lapsed; the token is the same proof of who they are either
    // way. Offer row first, entry second: claimOffer's order.
    if (params.leave) {
      const cas = await tx.waitlistEntry.updateMany({
        where: { id: offer.entryId, status: { in: [...ACTIVE_WAITLIST_STATUSES] } },
        data: { status: "REMOVED", dedupeKey: null },
      });
      if (cas.count > 0) {
        await recordWaitlistEvent(tx, {
          shopId: offer.shopId,
          entryId: offer.entryId,
          type: "entry.cancelled_by_customer",
          actor: CUSTOMER_ACTOR,
          metadata: { source: "offer_page", fromStatus: offer.entry.status, toStatus: "REMOVED" },
        });
        leftEntry = { shopId: offer.shopId, entryId: offer.entryId };
        return { outcome: "declined", left: true };
      }
    }
    return passed ? { outcome: "declined", left: false } : { outcome: "expired" };
  });

  // (Assigned inside the transaction callback, which TS cannot follow.)
  const endedSpan = ended as OfferSpan | null;
  const left = leftEntry as { shopId: string; entryId: string } | null;
  const spans: OfferSpan[] = endedSpan ? [endedSpan] : [];
  if (left) {
    const raced = await releaseRacedOffers({
      ...left,
      code: "left",
      via: "offer_page",
      actor: CUSTOMER_ACTOR,
    }).catch((err) => {
      logger.error({ err, shopId: left.shopId }, "waitlist decline: raced-offer pass failed");
      return [] as OfferSpan[];
    });
    spans.push(...raced);
  }
  await advanceEach(spans, now);
  return result;
}
