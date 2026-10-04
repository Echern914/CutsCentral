import { runWithShop } from "@chairback/db";
import { findConflicts } from "../engines/bookingConflict.js";
import { SLOT_SERVICES_SELECT, slotOffersService } from "../engines/targetedSlotServices.js";
import { staffSpanBlocked } from "../engines/blockedTime.js";

/**
 * "DIDN'T FINISH BOOKING" - THE PEOPLE A PAYMENT HOLD LEFT BEHIND.
 *
 * A shop that takes a card (or a deposit) writes a booking as a ten-minute
 * hold while the client saves a card. When the card never arrives - they left,
 * or Cash App never approved - the sweep cancels the hold and the time goes
 * back on sale. The client picked a time and pressed Confirm, so they may well
 * think they are booked. The shop could not see any of it: the agenda hides
 * every payment hold (`holdExpiresAt: null`), and an owner expecting a double
 * booking told us "I can't see who it is".
 *
 * This is the list that owner asked for: who, the time they wanted, how to
 * reach them, and whether that time is still free.
 *
 * 🔴 WHAT COUNTS AS UNFINISHED. A row still carrying `holdReason "payment"`
 * that never became a booking (promotion clears holdReason; see
 * unfinishedCheckout.ts `neverBooked`), for a FUTURE time:
 *   - PENDING with a live hold: they are on the card step right now ("live").
 *   - PENDING with an expired hold: lapsed, but the sweep (every 5 minutes)
 *     has not released it yet - "releasing". Status alone would call it live;
 *     the deadline decides. Not bookable from here until it is released: the
 *     booking guard would cancel it without giving back its special, its
 *     Acuity block or its payment (bookingWrite.ts ghost-clear).
 *   - CANCELED at or after its deadline: lapsed. A hold cancelled BEFORE its
 *     deadline was not abandoned - an Acuity refusal the client was told about
 *     on the spot, or a decline - so it is left out.
 *
 * 🔴 A PERSON IS A CLIENT RECORD *AND* A FIRST NAME. The public booking keys
 * the client record by phone, so a family on one number - a parent booking
 * for a teenager - shares one record (clientFill.ts). Keyed on the record
 * alone, the mother's booking would hide her son's unfinished one, and two
 * people's tries would merge into one row that Dismiss clears together. Hiding
 * a real lead is the expensive mistake here: an extra row costs one text, a
 * missing one is a client who turns up for a time that was sold. So "booked
 * since", grouping and Dismiss all match the record and the first name typed.
 * A nickname ("Mike" for "Michael") then shows as its own row - cheap, and
 * visible. A shared phone or email with NO shared record is never enough.
 *
 * One row per person: their LATEST attempt, with the other times they tried
 * listed under it. A repeating booking counts as one attempt.
 *
 * 🔴 NOTHING HERE IS LOGGED. The rows carry phone numbers and emails.
 */

/** The most rows one read returns. The rest are counted in `more`. */
export const UNFINISHED_LIST_LIMIT = 50;
/** How many candidate rows are read at all - a backstop, far above real use. */
const CANDIDATE_CAP = 500;
/**
 * The list is one transaction: the reads, then a "still free?" check per row
 * (findConflicts, three queries each). A handful of rows takes well under a
 * second; a full list of 50 is ~150 round trips, too close to Prisma's 5s
 * default for a read a barber is waiting on.
 */
const LIST_TIMEOUT_MS = 15_000;

/**
 * What we know about why it didn't finish. Nothing records Stripe's own
 * reason, so this is only what the rows themselves can prove.
 */
export type UnfinishedReason =
  | "card_not_saved"
  | "card_saved_late"
  | "not_paid"
  /** Money arrived after the hold ran out and was refunded. */
  | "paid_late_refunded"
  /** Money arrived after the hold ran out and has NOT been refunded (yet). */
  | "paid_late"
  | "not_finished";

export interface UnfinishedOtherTime {
  startsAt: Date;
  serviceName: string;
}

export interface UnfinishedBooking {
  /** The appointment row of their latest attempt. */
  id: string;
  clientId: string | null;
  /** What THIS person typed - on a shared phone the record carries someone else's name. */
  firstName: string;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  /** False once they texted STOP. Calling is unaffected. */
  canText: boolean;
  /**
   * The client record's name, only when its first name differs from the one
   * they typed: someone else's record, reached through a shared phone or
   * email. Booking them onto it would put the booking - and that person's
   * saved card - under the other name, so the list does not offer it.
   */
  profileName: string | null;
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceName: string;
  addOns: { id: string; name: string }[];
  startsAt: Date;
  endsAt: Date;
  /** When they tried (their latest attempt). */
  triedAt: Date;
  /** Attempts on the list for this person, a repeating booking counted once. */
  attempts: number;
  state: "live" | "lapsed";
  /** For a live hold: when the time goes back on sale. */
  heldUntil: Date | null;
  /**
   * Their hold - or another lapsed payment hold at the same chair and start -
   * ran out but the sweep has not released it yet. Not bookable until it is.
   */
  releasing: boolean;
  /** Someone else now holds that time. Only ever true for a lapsed attempt. */
  timeTaken: boolean;
  /** Time blocked on the shop's other calendar (Acuity), with nobody in it. */
  blockedElsewhere: boolean;
  reason: UnfinishedReason | null;
  /** They tried for one of the shop's specials. */
  wantedSpecial: boolean;
  /** That special, still on offer for their service: book it AS that special. */
  targetedSlotId: string | null;
  /** They asked for a repeating booking. */
  repeating: boolean;
  /** Other future times this person tried for and didn't finish. */
  otherTimes: UnfinishedOtherTime[];
}

export interface UnfinishedList {
  rows: UnfinishedBooking[];
  /** People not returned because of UNFINISHED_LIST_LIMIT. */
  more: number;
}

/**
 * The first word of a typed first name, folded so typing differences are not
 * a different person: case, accents and punctuation go.
 * "  JOSÉ maria" -> "jose", "D'Andre" -> "dandre".
 */
export function firstNameKey(first: string | null | undefined): string {
  const word = (first ?? "").trim().split(/\s+/)[0]!;
  return word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function personKey(a: { id: string; clientId: string | null; firstName: string }): string {
  return a.clientId ? `${a.clientId}|${firstNameKey(a.firstName)}` : `appointment:${a.id}`;
}

function addOnsOf(snapshot: unknown): { id: string; name: string }[] {
  if (!Array.isArray(snapshot)) return [];
  const out: { id: string; name: string }[] = [];
  for (const item of snapshot) {
    if (item && typeof item === "object") {
      const { id, name } = item as { id?: unknown; name?: unknown };
      if (typeof id === "string" && typeof name === "string") out.push({ id, name });
    }
  }
  return out;
}

/** Money statuses that mean the client's payment came in. */
const PAID = new Set(["succeeded", "requires_capture", "processing", "refunded", "partially_refunded"]);

/**
 * Why, from what the rows prove. `seriesCard` is a repeating booking's card,
 * filed against its first date only - which may already be past.
 */
export function reasonFor(
  a: {
    cardOnFile: { savedAt: Date | null } | null;
    payments: { status: string; refundedAmount: number }[];
  },
  seriesCard: { savedAt: Date | null } | null = null,
): UnfinishedReason {
  const card = a.cardOnFile ?? seriesCard;
  if (card) return card.savedAt ? "card_saved_late" : "card_not_saved";
  const p = a.payments[0];
  if (p) {
    if (p.refundedAmount > 0 || p.status === "refunded" || p.status === "partially_refunded") {
      return "paid_late_refunded";
    }
    // Paid, and the refund that should have followed has not (a refusal, or
    // an outcome still being reconciled). Never "didn't pay".
    return PAID.has(p.status) ? "paid_late" : "not_paid";
  }
  return "not_finished";
}

export async function listUnfinishedBookings(
  shopId: string,
  now: Date,
  timezone: string,
): Promise<UnfinishedList> {
  const list = await runWithShop(shopId, async (tx): Promise<UnfinishedList> => {
    const candidates = await tx.appointment.findMany({
      where: {
        shopId,
        holdReason: "payment",
        status: { in: ["PENDING", "CANCELED"] },
        startsAt: { gt: now },
        unfinishedDismissedAt: null,
      },
      orderBy: [{ createdAt: "desc" }, { startsAt: "asc" }],
      take: CANDIDATE_CAP,
      select: {
        id: true,
        clientId: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        status: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        canceledAt: true,
        holdExpiresAt: true,
        seriesId: true,
        bookedVia: true,
        addOns: true,
        staff: { select: { name: true } },
        service: { select: { name: true } },
        client: {
          select: { firstName: true, lastName: true, optedOut: true, optOutSource: true },
        },
        cardOnFile: { select: { savedAt: true } },
        payments: {
          where: { purpose: "booking" },
          orderBy: { createdAt: "desc" },
          select: { status: true, refundedAmount: true },
          take: 1,
        },
      },
    });

    const unfinished = candidates.filter((a) => {
      // A client who deleted their data: their rows were anonymised on purpose.
      if (a.client?.optOutSource === "deleted") return false;
      // Every payment hold is written with a deadline; promotion clears it.
      if (!a.holdExpiresAt) return false;
      if (a.status === "PENDING") return true;
      return a.canceledAt === null || a.canceledAt.getTime() >= a.holdExpiresAt.getTime();
    });
    if (unfinished.length === 0) return { rows: [], more: 0 };

    // Hidden: anyone with a real booking made AFTER the attempt, by the same
    // person (record + first name): booked, done, a no-show, a request
    // waiting for approval, or a real booking that was later cancelled (the
    // client was told either way). Never a row that was only ever refused or
    // undone - an Acuity refusal, a forced booking taken back - since nothing
    // is booked for them; only cancelAppointment counts a cancellation.
    const clientIds = [
      ...new Set(unfinished.map((a) => a.clientId).filter((id): id is string => id !== null)),
    ];
    const oldest = unfinished.reduce(
      (min, a) => (a.createdAt.getTime() < min.getTime() ? a.createdAt : min),
      unfinished[0]!.createdAt,
    );
    const later =
      clientIds.length === 0
        ? []
        : await tx.appointment.findMany({
            where: {
              shopId,
              clientId: { in: clientIds },
              createdAt: { gt: oldest },
              OR: [
                { status: { in: ["BOOKED", "COMPLETED", "NO_SHOW"] } },
                { status: "PENDING", holdReason: null, holdExpiresAt: null },
                {
                  status: "CANCELED",
                  holdReason: null,
                  holdExpiresAt: null,
                  cancellationRevision: { gt: 0 },
                },
              ],
            },
            select: {
              id: true,
              clientId: true,
              firstName: true,
              createdAt: true,
              status: true,
              staffId: true,
              startsAt: true,
            },
          });
    const lastBooked = new Map<string, number>();
    // 🔑 THE EXACT TIME THEY WANTED, booked on their record since, settles it
    // whatever name the booking carries. A booking made with the record picked
    // (New appointment, a text to the receptionist, a tier opening) is written
    // in the RECORD's name, which may not be the name they typed ("Michael" on
    // the profile, "Mike" on the form). Nobody else on that record can hold
    // that chair at that minute.
    const exactTimeBooked = new Map<string, number>();
    const timeOnRecord = (a: { clientId: string | null; staffId: string; startsAt: Date }) =>
      `${a.clientId}|${a.staffId}|${a.startsAt.getTime()}`;
    for (const b of later) {
      const key = personKey(b);
      lastBooked.set(key, Math.max(lastBooked.get(key) ?? 0, b.createdAt.getTime()));
      if (b.status !== "CANCELED") {
        const at = timeOnRecord(b);
        exactTimeBooked.set(at, Math.max(exactTimeBooked.get(at) ?? 0, b.createdAt.getTime()));
      }
    }
    const open = unfinished.filter(
      (a) =>
        !(
          a.clientId &&
          ((lastBooked.get(personKey(a)) ?? 0) > a.createdAt.getTime() ||
            (exactTimeBooked.get(timeOnRecord(a)) ?? 0) > a.createdAt.getTime())
        ),
    );

    // One row per person. `candidates` is newest first, so each group's first
    // row is the latest attempt.
    const people = new Map<string, typeof open>();
    for (const a of open) {
      const key = personKey(a);
      const group = people.get(key);
      if (group) group.push(a);
      else people.set(key, [a]);
    }

    type Candidate = (typeof open)[number];
    const reps = new Map<string, Candidate>();
    const rows: UnfinishedBooking[] = [];
    for (const group of people.values()) {
      const latest = group[0]!;
      const attemptKey = (a: Candidate) => a.seriesId ?? a.id;
      // A repeating booking is many rows: it is wanted from its FIRST time.
      const sameAttempt = group.filter((a) => attemptKey(a) === attemptKey(latest));
      const rep = sameAttempt.reduce((first, a) =>
        a.startsAt.getTime() < first.startsAt.getTime() ? a : first,
      );
      const expired = rep.holdExpiresAt!.getTime() <= now.getTime();
      const live = rep.status === "PENDING" && !expired;

      // Each attempt is wanted from its first time (a repeating booking's later
      // dates are not separate tries). The other TIMES are listed once each:
      // trying the same time twice is still one time.
      const firstOfEach = new Map<string, Candidate>();
      for (const a of group) {
        const seen = firstOfEach.get(attemptKey(a));
        if (!seen || a.startsAt.getTime() < seen.startsAt.getTime()) firstOfEach.set(attemptKey(a), a);
      }
      const timeKey = (a: Candidate) => `${a.staffId}|${a.startsAt.getTime()}`;
      const seenTimes = new Set<string>([timeKey(rep)]);
      const otherTimes: UnfinishedOtherTime[] = [];
      for (const a of firstOfEach.values()) {
        if (seenTimes.has(timeKey(a))) continue;
        seenTimes.add(timeKey(a));
        otherTimes.push({ startsAt: a.startsAt, serviceName: a.service.name });
      }
      otherTimes.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());

      const profileName =
        rep.client && firstNameKey(rep.client.firstName) !== firstNameKey(rep.firstName)
          ? `${rep.client.firstName ?? ""} ${rep.client.lastName ?? ""}`.trim() || null
          : null;

      reps.set(rep.id, rep);
      rows.push({
        id: rep.id,
        clientId: rep.clientId,
        firstName: rep.firstName,
        lastName: rep.lastName,
        phone: rep.phone,
        email: rep.email,
        canText: !(rep.client?.optedOut ?? false),
        profileName,
        staffId: rep.staffId,
        staffName: rep.staff.name,
        serviceId: rep.serviceId,
        serviceName: rep.service.name,
        addOns: addOnsOf(rep.addOns),
        startsAt: rep.startsAt,
        endsAt: rep.endsAt,
        triedAt: latest.createdAt,
        attempts: new Set(group.map(attemptKey)).size,
        state: live ? "live" : "lapsed",
        heldUntil: live ? rep.holdExpiresAt : null,
        releasing: rep.status === "PENDING" && expired,
        timeTaken: false,
        blockedElsewhere: false,
        reason: null,
        wantedSpecial: rep.bookedVia === "targeted_slot",
        targetedSlotId: null,
        repeating: rep.seriesId !== null,
        otherTimes,
      });
    }

    rows.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime() || x.id.localeCompare(y.id));
    const shown = rows.slice(0, UNFINISHED_LIST_LIMIT);

    for (const row of shown) {
      // A live attempt is the one holding the time: nothing to ask yet.
      if (row.state === "live") continue;
      const rep = reps.get(row.id)!;

      // A repeating booking's card sits on its first date, which may be past.
      const seriesCard =
        !rep.cardOnFile && rep.seriesId
          ? await tx.cardOnFile.findFirst({
              where: { shopId, seriesId: rep.seriesId },
              select: { savedAt: true },
            })
          : null;
      row.reason = reasonFor(rep, seriesCard);

      // Is the time they wanted still free? The same occupancy rule the
      // conflict inbox and the grid use (occupyingWhere): a booking, a live
      // hold, a synced visit. The lapsed row itself never counts - it is
      // cancelled or expired.
      const conflicts = await findConflicts(tx, {
        shopId,
        staffId: row.staffId,
        start: row.startsAt,
        end: row.endsAt,
        now,
      });
      row.timeTaken = conflicts.length > 0;

      // Anyone's payment hold at this exact chair and start that ran out and
      // is not swept yet: booking now would have the guard cancel it without
      // the release the sweep does (its special, Acuity block, payment). The
      // guard clears by exact start, so that is the key.
      if (!row.releasing) {
        const unswept = await tx.appointment.count({
          where: {
            shopId,
            staffId: row.staffId,
            startsAt: row.startsAt,
            status: "PENDING",
            holdReason: "payment",
            holdExpiresAt: { lte: now },
          },
        });
        row.releasing = unswept > 0;
      }

      // Blocked on the shop's other calendar with nobody in it: findConflicts
      // leaves a lone block out on purpose (it is not a double booking), but
      // the booking guard refuses it, so the list must not say "Time open".
      if (!row.timeTaken) {
        const blocks = await tx.externalBlock.count({
          where: { shopId, startsAt: { lt: row.endsAt }, endsAt: { gt: row.startsAt } },
        });
        row.blockedElsewhere = blocks > 0;
      }

      // A special they tried for went back on sale with the lapse
      // (releasePaymentHoldRow). Booking the time plainly would collide with
      // it, or book a different special, or price it as the menu service - so
      // Book them books it AS the special they wanted: same chair, same start,
      // offered for their service, same length.
      if (!row.timeTaken && row.wantedSpecial && !row.releasing) {
        const specials = await tx.targetedSlot.findMany({
          where: {
            shopId,
            staffId: row.staffId,
            startsAt: row.startsAt,
            active: true,
            bookedAppointmentId: null,
          },
          orderBy: { createdAt: "asc" },
          select: { id: true, serviceId: true, durationMin: true, services: SLOT_SERVICES_SELECT },
        });
        const span = Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000);
        const theirs = specials.filter((s) => slotOffersService(s, row.serviceId));
        const special = theirs.find((s) => s.durationMin === span) ?? (theirs.length === 1 ? theirs[0] : null);
        row.targetedSlotId = special?.id ?? null;
      }
    }

    return { rows: shown, more: rows.length - shown.length };
  }, { timeout: LIST_TIMEOUT_MS });

  // A special inside time the shop has since blocked off is not on offer -
  // every read surface drops it (dropBlockedTargetedSlots), and the booking
  // would refuse it. Checked after the transaction: blocked time is read
  // through its own shop-scoped queries.
  for (const row of list.rows) {
    if (!row.targetedSlotId) continue;
    if (
      await staffSpanBlocked({
        shopId,
        staffId: row.staffId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        timezone,
      })
    ) {
      row.targetedSlotId = null;
    }
  }
  return list;
}

export type DismissOutcome = "dismissed" | "not_found" | "still_finishing";

/**
 * Take a person off the list: every unfinished attempt of theirs that has run
 * out, not just the row tapped - otherwise their previous attempt would take
 * its place. "Theirs" is the same record AND first name, so on a shared phone
 * it never takes someone else off.
 *
 * 🔴 NEVER A NEWER TRY THAN THE ONE TAPPED. The row shown is the person's
 * latest try as of the last read; a phone left locked shows an old read, and
 * a try made since would otherwise be cleared unseen - the client who may
 * think they're booked for it never reaches the list. So only tries made no
 * later than the tapped one (and the rest of its repeating booking) go; a
 * newer one stays listed. A live hold is refused: they may finish in minutes.
 */
export async function dismissUnfinishedBooking(
  shopId: string,
  id: string,
  now: Date,
): Promise<DismissOutcome> {
  return runWithShop(shopId, async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id, shopId, holdReason: "payment", status: { in: ["PENDING", "CANCELED"] } },
      select: {
        id: true,
        clientId: true,
        firstName: true,
        status: true,
        holdExpiresAt: true,
        createdAt: true,
        seriesId: true,
      },
    });
    if (!appt) return "not_found";
    if (
      appt.status === "PENDING" &&
      appt.holdExpiresAt !== null &&
      appt.holdExpiresAt.getTime() > now.getTime()
    ) {
      return "still_finishing";
    }
    const ranOut = [{ status: "CANCELED" as const }, { status: "PENDING" as const, holdExpiresAt: { lte: now } }];
    let ids = [appt.id];
    if (appt.clientId) {
      const theirs = await tx.appointment.findMany({
        where: {
          shopId,
          clientId: appt.clientId,
          holdReason: "payment",
          unfinishedDismissedAt: null,
          OR: ranOut,
        },
        select: { id: true, firstName: true, createdAt: true, seriesId: true },
      });
      const who = firstNameKey(appt.firstName);
      ids = theirs
        .filter((r) => firstNameKey(r.firstName) === who)
        .filter(
          (r) =>
            r.createdAt.getTime() <= appt.createdAt.getTime() ||
            (appt.seriesId !== null && r.seriesId === appt.seriesId),
        )
        .map((r) => r.id);
    }
    if (ids.length > 0) {
      await tx.appointment.updateMany({
        where: { shopId, id: { in: ids }, holdReason: "payment", unfinishedDismissedAt: null, OR: ranOut },
        data: { unfinishedDismissedAt: now },
      });
    }
    return "dismissed";
  });
}
