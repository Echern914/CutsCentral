import { LOYALTY_TIERS, apiEnv, randomToken } from "@chairback/config";
import { Prisma, prisma, runAsOwner, runWithShop, type LoyaltyTier } from "@chairback/db";
import { logger } from "../logger.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import { bookingBlockedFor } from "../services/clientBookingBlock.js";
import { settleClientLinks } from "../services/customerIdentity.js";
import { sendPushToClient } from "../messaging/push.js";
import { formatApptTime } from "../messaging/templates.js";
import { dispatchAfterCommit, recordMirrorIntent } from "./acuityMirror.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";
import { isMirrorNotConfigured } from "./mirrorNotConfigured.js";
import { inQuietHours } from "./quietHours.js";
import { ServiceDayFullError } from "./serviceDailyLimit.js";
import { PUBLIC_SERVICE } from "./serviceVisibility.js";
import { computeOpenSlots } from "./slots.js";
import { claimWouldRequirePayment, offerLockKey, slotPrice } from "./waitlistOffer.js";

/**
 * OPENINGS HELD FOR A LOYALTY TIER.
 *
 * The barber has a free slot and wants his best customers to get first pick:
 * "Gold members, Tuesday 3pm is yours until noon." The slot is held, the tier's
 * members are told in the My ChairBack app, one of them books it there - or
 * nobody does, the hold lapses, and it is back on the booking page for anyone.
 *
 * 🔴 IT IS A HOLD LIKE EVERY OTHER HOLD, NOT A NEW KIND OF BOOKING RULE.
 * The two places that decide whether a time is free both know about it:
 *   - the slot grid (engines/slots.ts) subtracts a live hold for everyone, so
 *     the public page never offers it;
 *   - the booking guard (engines/bookingWrite.ts) refuses any write over it,
 *     under the barber's advisory lock, except the claim - which excludes its
 *     own row - and barber-driven writes, which release it.
 * Nothing about the public booking page is personalised: a Gold member does
 * not see the slot there, they book it in the app. That keeps every cached,
 * anonymous read exactly as safe as it was.
 *
 * 🔴 WHO MAY CLAIM IS A LIST, FROZEN WHEN THE HOLD IS MADE. Not a tier looked up
 * at claim time, and never a phone number typed into a form: the invitations
 * are My ChairBack accounts actively linked to a record at this shop whose tier
 * qualified at that moment. Everyone who was told can book it; nobody who
 * wasn't can; a tier that changed overnight changes nothing about a promise
 * already made. The claim still re-derives the account's link to the record,
 * so a record the shop has since corrected cannot be booked by the wrong person.
 *
 * "Then anyone" needs no job. Past heldUntil, the grid and the guard both stop
 * matching the row; the status stays HELD because nothing is left to do.
 */

/** How long a barber can hold an opening for a tier. */
export const TIER_HOLD_MINUTES = [30, 60, 120, 240, 480] as const;
export type TierHoldMinutes = (typeof TIER_HOLD_MINUTES)[number];

/** A hold shorter than this is not worth telling anyone about. */
const MIN_HOLD_MS = 10 * 60_000;

const TIER_ORDER: LoyaltyTier[] = ["BRONZE", "SILVER", "GOLD"];

/** GOLD -> [GOLD]; SILVER -> [SILVER, GOLD]; BRONZE -> every tier. */
export function tiersAtOrAbove(minTier: LoyaltyTier): LoyaltyTier[] {
  return TIER_ORDER.slice(TIER_ORDER.indexOf(minTier));
}

/** "Gold", "Silver and Gold", "every tier" - how the invitation is described. */
export function audienceLabel(minTier: LoyaltyTier): string {
  if (minTier === "GOLD") return "Gold members";
  if (minTier === "SILVER") return "Silver and Gold members";
  return "members of every tier";
}

function timeOnly(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(at);
  } catch {
    return at.toUTCString();
  }
}

/**
 * The people to invite: My ChairBack accounts ACTIVELY linked to a live record
 * at this shop whose stored tier qualifies. One invitation per account - a
 * person linked to two records here books as the higher-tier one.
 *
 * Reads platform-owned tables, so it runs on an owner transaction.
 */
async function invitees(
  tx: Prisma.TransactionClient,
  shopId: string,
  minTier: LoyaltyTier,
): Promise<{ accountId: string; clientId: string }[]> {
  const tiers = tiersAtOrAbove(minTier);
  const links = await tx.customerClientLink.findMany({
    where: {
      shopId,
      status: "active",
      account: { isDemo: false },
      // Never someone the shop blocked from booking: an invitation they could
      // not use is a time held for nobody.
      client: { shopId, archivedAt: null, bookingBlockedAt: null, loyaltyTier: { in: tiers } },
    },
    orderBy: [{ linkedAt: "asc" }, { id: "asc" }],
    select: { accountId: true, clientId: true, client: { select: { loyaltyTier: true } } },
  });
  const best = new Map<string, { clientId: string; rank: number }>();
  for (const l of links) {
    const rank = TIER_ORDER.indexOf(l.client.loyaltyTier!);
    const seen = best.get(l.accountId);
    if (!seen || rank > seen.rank) best.set(l.accountId, { clientId: l.clientId, rank });
  }
  return [...best].map(([accountId, v]) => ({ accountId, clientId: v.clientId }));
}

export interface TierOpeningPreview {
  /** Records at this shop holding a qualifying tier. */
  members: number;
  /** Of those, the people who have the app linked and would be invited. */
  inApp: number;
}

export async function previewTierOpening(shopId: string, minTier: LoyaltyTier): Promise<TierOpeningPreview> {
  const tiers = tiersAtOrAbove(minTier);
  const [members, people] = await Promise.all([
    runWithShop(shopId, (tx) =>
      tx.client.count({
        where: { shopId, archivedAt: null, bookingBlockedAt: null, loyaltyTier: { in: tiers } },
      }),
    ),
    runAsOwner((tx) => invitees(tx, shopId, minTier)),
  ]);
  return { members, inApp: people.length };
}

export type CreateTierOpeningResult =
  | { outcome: "held"; openingId: string; heldUntil: Date; recipients: number }
  /** Tiers are a rewards feature; with rewards off nobody can see one. */
  | { outcome: "rewards_off" }
  /** Only a shop booking through ChairBack can hold a slot here. */
  | { outcome: "not_native" }
  /** Not a time the booking page would offer right now: taken, closed, past, full. */
  | { outcome: "unavailable" }
  /** Claiming it would owe a deposit, and a hold carries no checkout. */
  | { outcome: "requires_payment" }
  /** The appointment starts too soon for a hold to mean anything. */
  | { outcome: "too_soon" }
  /** Nobody in that tier has the app - holding it would only hide it. */
  | { outcome: "no_members" };

export async function createTierOpening(params: {
  shopId: string;
  userId: string | null;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  minTier: LoyaltyTier;
  holdMinutes: TierHoldMinutes;
  now?: Date;
}): Promise<CreateTierOpeningResult> {
  const now = params.now ?? new Date();

  // Shop is read on the owner connection: a tenant session sees no Shop rows.
  const shop = await prisma.shop.findUnique({
    where: { id: params.shopId },
    select: {
      id: true,
      name: true,
      timezone: true,
      bookingBufferMin: true,
      bookingMode: true,
      rewardsEnabled: true,
      requireBookingApproval: true,
      paymentsMode: true,
      connectChargesEnabled: true,
      stripeConnectAccountId: true,
      depositAmountCents: true,
      requireCardToBook: true,
    },
  });
  if (!shop) return { outcome: "unavailable" };
  if (!shop.rewardsEnabled) return { outcome: "rewards_off" };
  if (shop.bookingMode !== "native") return { outcome: "not_native" };

  // 🔑 THE SLOT MUST BE ONE THE BOOKING PAGE WOULD OFFER RIGHT NOW - read off
  // the live timeline, so its end comes from the same duration rules the
  // picker used, and a taken, closed or past time is refused before anything
  // is held. The guard below re-checks taken-ness under the lock.
  const target = params.startsAt.getTime();
  const slots = await computeOpenSlots({
    shopId: shop.id,
    staffId: params.staffId,
    serviceId: params.serviceId,
    fromDate: new Date(target - 24 * 60 * 60_000),
    toDate: new Date(target + 24 * 60 * 60_000),
    now,
  });
  const slot = slots.find((s) => s.startsAt.getTime() === target);
  if (!slot) return { outcome: "unavailable" };

  const service = await prisma.service.findFirst({
    where: { id: params.serviceId, shopId: shop.id },
    select: { price: true, priceOverrides: true, dateOverrides: true, timeOverrides: true },
  });
  if (claimWouldRequirePayment(shop, slotPrice(service, slot.startsAt, shop.timezone))) {
    return { outcome: "requires_payment" };
  }

  // Never past the appointment itself: a hold that outlasted its slot would
  // never become "then anyone".
  const heldUntil = new Date(Math.min(now.getTime() + params.holdMinutes * 60_000, slot.startsAt.getTime()));
  if (heldUntil.getTime() - now.getTime() < MIN_HOLD_MS) return { outcome: "too_soon" };

  let created: { id: string; recipients: number } | null;
  try {
    created = await runAsOwner(async (tx) => {
      // The same guard as every booking: serialises on the barber, and refuses
      // an appointment, a waitlist hold, ANOTHER tier hold, a walk-in, a synced
      // visit or blocked time in the span. Customer rules, because a customer
      // is who will book it.
      await lockStaffAndAssertSlotFree(tx, {
        staffId: params.staffId,
        shopId: shop.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        bufferMin: shop.bookingBufferMin,
        serviceDayLimit: { serviceId: params.serviceId, timezone: shop.timezone },
        walkInCapacity: "enforce",
        now,
      });
      // Every invitation at this shop is written under this lock, so the
      // per-member cap Auto-fill reads (engines/autoFill.ts) counts this one.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${offerLockKey(shop.id)}))`);

      const people = await invitees(tx, shop.id, params.minTier);
      if (people.length === 0) return null;

      const opening = await tx.tierOpening.create({
        data: {
          shopId: shop.id,
          staffId: params.staffId,
          serviceId: params.serviceId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          minTier: params.minTier,
          heldUntil,
          createdByUserId: params.userId,
          recipientCount: people.length,
        },
        select: { id: true },
      });
      await tx.tierOpeningRecipient.createMany({
        // createdAt from the engine's clock, not the database's DEFAULT now():
        // the resend window is measured against this `now`, and Postgres and
        // the API are different clocks.
        data: people.map((p) => ({ openingId: opening.id, accountId: p.accountId, clientId: p.clientId, createdAt: now })),
      });
      return { id: opening.id, recipients: people.length };
    });
  } catch (err) {
    if (err instanceof SlotTakenError || err instanceof ServiceDayFullError) return { outcome: "unavailable" };
    throw err;
  }
  if (!created) return { outcome: "no_members" };

  // The public page may be serving a cached day that still shows this time.
  await noteAvailabilityChanged(shop.id);
  void notifyInvitees(created.id).catch((err) => {
    logger.error({ err, shopId: shop.id, openingId: created!.id }, "tier opening notifications failed");
  });
  logger.info(
    { shopId: shop.id, openingId: created.id, minTier: params.minTier, recipients: created.recipients },
    "tier opening held",
  );
  return { outcome: "held", openingId: created.id, heldUntil, recipients: created.recipients };
}

/** Re-read the opening after this many sends, and stop if it has ended. */
const RECHECK_EVERY = 10;

/** Is this hold still one a member could book? The same test every reader uses. */
function holdIsLive(o: { status: string; heldUntil: Date }, now: Date): boolean {
  return o.status === "HELD" && o.heldUntil.getTime() > now.getTime();
}

/**
 * Tell each invited member who has not been told yet. After commit, never
 * inside the hold's transaction: a push provider being slow must not hold the
 * barber's calendar lock.
 *
 * 🔴 AT MOST ONE PUSH PER INVITATION, EVER. Each send is CLAIMED first - a
 * compare-and-set from notifiedAt NULL to now - and only the caller that wins
 * it sends. So the first send and the resend sweep (resendUnnotifiedOpenings)
 * can overlap without anyone hearing twice. A process that dies between the
 * claim and the send loses that one push rather than risking two; the claim is
 * the promise kept.
 *
 * 🔴 IT STOPS WHEN THE OPENING ENDS. A member books it, or the barber lets it
 * go, and the people not yet reached are not told about a time that is gone.
 * The opening is re-read before the first send and every RECHECK_EVERY sends.
 *
 * `now` is for tests; a live send reads the clock as it goes.
 */
export async function notifyInvitees(
  openingId: string,
  opts: { now?: Date } = {},
): Promise<{ recipients: number; sent: number; delivered: number; stoppedEarly: boolean }> {
  const clock = () => opts.now ?? new Date();
  const opening = await prisma.tierOpening.findUnique({
    where: { id: openingId },
    select: {
      id: true,
      shopId: true,
      staffId: true,
      serviceId: true,
      startsAt: true,
      heldUntil: true,
      status: true,
      minTier: true,
      source: true,
      shop: { select: { name: true, timezone: true, requireBookingApproval: true } },
    },
  });
  if (!opening) return { recipients: 0, sent: 0, delivered: 0, stoppedEarly: false };
  const [invited, names] = await Promise.all([
    runAsOwner((tx) =>
      tx.tierOpeningRecipient.findMany({
        where: { openingId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, clientId: true, notifiedAt: true, client: { select: { magicToken: true } } },
      }),
    ),
    runWithShop(opening.shopId, async (tx) => ({
      staff: await tx.staff.findFirst({ where: { id: opening.staffId, shopId: opening.shopId }, select: { name: true } }),
      service: await tx.service.findFirst({
        where: { id: opening.serviceId, shopId: opening.shopId },
        select: { name: true },
      }),
    })),
  ]);
  const unsent = invited.filter((r) => r.notifiedAt === null);

  const tz = opening.shop.timezone;
  const label = LOYALTY_TIERS[opening.minTier].label;
  const what = [names.service?.name, names.staff?.name ? `with ${names.staff.name}` : null].filter(Boolean).join(" ");
  const verb = opening.shop.requireBookingApproval ? "request" : "book";
  const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
  // An Auto-fill opening is not marketing and its only action is in the app
  // (messaging/push.ts `ledger` and `appOnly`). A manual one keeps the
  // behaviour it shipped with.
  const auto = opening.source === "auto";
  // 🔴 Nobody chose to send an Auto-fill push at this hour, so none is sent
  // in quiet hours (a barber holding a slot by hand chose to). The invitation
  // stands - it is in the app - it just does not wake anyone.
  if (auto && unsent.length > 0 && inQuietHours(tz, clock())) {
    logger.info({ shopId: opening.shopId, openingId, left: unsent.length }, "tier opening: quiet hours, not pushed");
    return { recipients: invited.length, sent: 0, delivered: 0, stoppedEarly: false };
  }
  const title = auto
    ? opening.minTier === "GOLD"
      ? `${opening.shop.name}: first pick for Gold members`
      : `${opening.shop.name}: an opening for Silver and Gold members`
    : `${opening.shop.name}: an opening for ${label}${opening.minTier === "GOLD" ? "" : " and up"}`;

  let sent = 0;
  let delivered = 0;
  let live: { status: string; heldUntil: Date } | null = { status: opening.status, heldUntil: opening.heldUntil };
  for (const [i, r] of unsent.entries()) {
    if (i > 0 && i % RECHECK_EVERY === 0) {
      live = await prisma.tierOpening.findUnique({
        where: { id: openingId },
        select: { status: true, heldUntil: true },
      });
    }
    if (!live || !holdIsLive(live, clock())) {
      logger.info(
        { shopId: opening.shopId, openingId, sent, left: unsent.length - i },
        "tier opening ended; remaining invitations not sent",
      );
      return { recipients: invited.length, sent, delivered, stoppedEarly: true };
    }
    const claimedAt = clock();
    const claimed = await runAsOwner((tx) =>
      tx.tierOpeningRecipient.updateMany({
        where: { id: r.id, notifiedAt: null },
        data: { notifiedAt: claimedAt },
      }),
    );
    if (claimed.count === 0) continue; // someone else is telling them
    const result = await sendPushToClient({
      shopId: opening.shopId,
      clientId: r.clientId,
      kind: "promo",
      ...(auto ? { ledger: false, appOnly: true } : {}),
      payload: {
        title,
        body: `${formatApptTime(opening.startsAt, tz)}${what ? ` · ${what}` : ""}. Yours to ${verb} in the app until ${timeOnly(live.heldUntil, tz)}.`,
        // The web rewards page for a browser subscription; the app reads the
        // `opening` parameter and opens Profile, where the opening is.
        url: `${base}/r/${r.client.magicToken}?opening=${encodeURIComponent(opening.id)}`,
        tag: `tier-opening-${opening.id}`,
      },
    });
    sent += 1;
    if (result.anyDelivered) delivered += 1;
    await runAsOwner((tx) =>
      tx.tierOpeningRecipient.update({ where: { id: r.id }, data: { delivered: result.anyDelivered } }),
    ).catch((err: unknown) => {
      // The push already went out (or didn't); a stamp failure must not throw.
      logger.error({ err, shopId: opening.shopId, openingId }, "tier opening delivery stamp failed");
    });
  }
  logger.info(
    { shopId: opening.shopId, openingId, recipients: invited.length, sent, delivered },
    "tier opening notified",
  );
  return { recipients: invited.length, sent, delivered, stoppedEarly: false };
}

/**
 * Pick up invitations a restart lost. The first send runs after the hold's
 * transaction commits, fire-and-forget; a deploy at that moment left a member
 * invited and never told, with the time held for them. This finds invitations
 * at least a minute old (so it does not race a send in flight - the claim makes
 * that harmless anyway) and at most fifteen (an invitation older than that has
 * had its chance; telling someone late about a short hold is worse than not),
 * on openings still live, and sends them.
 *
 * 🔴 AUTO-FILL OPENINGS ONLY. A build from before send stamps existed sends to
 * everyone and records nothing, so an opening it makes - while it is still
 * serving during a deploy, after the migration has run - looks entirely unsent.
 * Resending those would push every member a second time. That build never
 * makes an Auto-fill opening, so the resend is safe there; a manual opening
 * keeps the one send it always had.
 *
 * Rides the waitlist sweep's lease (scheduler.ts). Never throws per opening.
 */
export async function resendUnnotifiedOpenings(now: Date = new Date()): Promise<number> {
  const stale = await runAsOwner((tx) =>
    tx.tierOpeningRecipient.findMany({
      where: {
        notifiedAt: null,
        createdAt: { gte: new Date(now.getTime() - 15 * 60_000), lte: new Date(now.getTime() - 60_000) },
        opening: { source: "auto", status: "HELD", heldUntil: { gt: now } },
      },
      distinct: ["openingId"],
      select: { openingId: true },
      take: 50,
    }),
  );
  let resent = 0;
  for (const { openingId } of stale) {
    try {
      const r = await notifyInvitees(openingId, { now });
      resent += r.sent;
    } catch (err) {
      logger.error({ err, openingId }, "tier opening resend failed");
    }
  }
  if (resent > 0) logger.info({ openings: stale.length, resent }, "tier opening invitations resent");
  return resent;
}

export type TierOpeningState = "held" | "claimed" | "released" | "open";

export interface ShopTierOpening {
  id: string;
  staffName: string | null;
  serviceName: string | null;
  startsAt: string;
  endsAt: string;
  minTier: LoyaltyTier;
  heldUntil: string;
  /** held = still theirs · claimed = a member booked it · released = you ended it · open = hold ran out, anyone's now */
  state: TierOpeningState;
  recipients: number;
  claimedBy: string | null;
}

/** The barber's list: upcoming openings, newest first. */
export async function listShopTierOpenings(shopId: string, now = new Date()): Promise<ShopTierOpening[]> {
  return runWithShop(shopId, async (tx) => {
    const rows = await tx.tierOpening.findMany({
      where: { shopId, startsAt: { gt: new Date(now.getTime() - 60 * 60_000) } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        endsAt: true,
        minTier: true,
        heldUntil: true,
        status: true,
        recipientCount: true,
        claimedAppointment: { select: { firstName: true, lastName: true } },
      },
    });
    const [staff, services] = await Promise.all([
      tx.staff.findMany({ where: { shopId, id: { in: rows.map((r) => r.staffId) } }, select: { id: true, name: true } }),
      tx.service.findMany({ where: { shopId, id: { in: rows.map((r) => r.serviceId) } }, select: { id: true, name: true } }),
    ]);
    const staffName = new Map(staff.map((s) => [s.id, s.name]));
    const serviceName = new Map(services.map((s) => [s.id, s.name]));
    return rows.map((r) => ({
      id: r.id,
      staffName: staffName.get(r.staffId) ?? null,
      serviceName: serviceName.get(r.serviceId) ?? null,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      minTier: r.minTier,
      heldUntil: r.heldUntil.toISOString(),
      state:
        r.status === "CLAIMED"
          ? "claimed"
          : r.status === "RELEASED"
            ? "released"
            : r.heldUntil.getTime() > now.getTime()
              ? "held"
              : "open",
      recipients: r.recipientCount,
      claimedBy: r.claimedAppointment
        ? [r.claimedAppointment.firstName, r.claimedAppointment.lastName].filter(Boolean).join(" ")
        : null,
    }));
  });
}

/** End a hold early: the slot goes straight back on the booking page. */
export async function releaseTierOpening(shopId: string, openingId: string, now = new Date()): Promise<boolean> {
  const released = await runWithShop(shopId, (tx) =>
    tx.tierOpening.updateMany({
      where: { id: openingId, shopId, status: "HELD", heldUntil: { gt: now } },
      data: { status: "RELEASED" },
    }),
  );
  if (released.count === 0) return false;
  await noteAvailabilityChanged(shopId);
  return true;
}

export interface CustomerTierOpening {
  id: string;
  shop: { name: string; logoUrl: string | null; timezone: string };
  startsAt: string;
  endsAt: string;
  serviceName: string | null;
  staffName: string | null;
  /** The service's listed price, or null when the shop has not priced it. */
  price: number | null;
  /** "Gold members", "Silver and Gold members" */
  audience: string;
  tierLabel: string;
  heldUntil: string;
  /** The shop approves bookings: claiming sends a request, not a booking. */
  requiresApproval: boolean;
}

/**
 * The live openings this account was invited to. A hold that has lapsed, was
 * claimed or released is simply not here; and neither is one whose record the
 * account is no longer linked to.
 */
export async function openingsForAccount(accountId: string, now = new Date()): Promise<CustomerTierOpening[]> {
  const rows = await runAsOwner((tx) =>
    tx.tierOpeningRecipient.findMany({
      where: {
        accountId,
        opening: { status: "HELD", heldUntil: { gt: now }, startsAt: { gt: now } },
        // A record the shop has since blocked from booking: its invitation
        // goes quietly, as one for an unlinked record does.
        client: { customerLinks: { some: { accountId, status: "active" } }, bookingBlockedAt: null },
      },
      orderBy: { opening: { startsAt: "asc" } },
      take: 20,
      select: {
        opening: {
          select: {
            id: true,
            shopId: true,
            staffId: true,
            serviceId: true,
            startsAt: true,
            endsAt: true,
            heldUntil: true,
            minTier: true,
            shop: { select: { name: true, logoUrl: true, timezone: true, requireBookingApproval: true } },
          },
        },
      },
    }),
  );
  if (rows.length === 0) return [];
  return runAsOwner(async (tx) => {
    const [staff, services] = await Promise.all([
      tx.staff.findMany({ where: { id: { in: rows.map((r) => r.opening.staffId) } }, select: { id: true, name: true } }),
      tx.service.findMany({
        where: { id: { in: rows.map((r) => r.opening.serviceId) } },
        select: { id: true, name: true, price: true },
      }),
    ]);
    const staffById = new Map(staff.map((s) => [s.id, s]));
    const serviceById = new Map(services.map((s) => [s.id, s]));
    return rows.map(({ opening: o }) => {
      const svc = serviceById.get(o.serviceId);
      return {
        id: o.id,
        shop: { name: o.shop.name, logoUrl: o.shop.logoUrl, timezone: o.shop.timezone },
        startsAt: o.startsAt.toISOString(),
        endsAt: o.endsAt.toISOString(),
        serviceName: svc?.name ?? null,
        staffName: staffById.get(o.staffId)?.name ?? null,
        price: svc?.price == null ? null : Number(svc.price),
        audience: audienceLabel(o.minTier),
        tierLabel: LOYALTY_TIERS[o.minTier].label,
        heldUntil: o.heldUntil.toISOString(),
        requiresApproval: o.shop.requireBookingApproval,
      };
    });
  });
}

export type ClaimTierOpeningResult =
  | {
      outcome: "claimed";
      appointmentId: string;
      manageToken: string;
      shopId: string;
      startsAt: Date;
      endsAt: Date;
      pending: boolean;
    }
  /** Not an opening this account was invited to - or no such opening. */
  | { outcome: "not_found" }
  /** Claimed by another member, released, or the hold ran out. */
  | { outcome: "ended" }
  /** The account is no longer linked to the record it was invited as. */
  | { outcome: "not_linked" }
  | { outcome: "slot_taken" }
  | { outcome: "day_full" }
  | { outcome: "deposit_required" }
  | { outcome: "unavailable_external" }
  /** The shop blocked this client from booking online since the invitation. */
  | { outcome: "contact_shop" };

/**
 * Book an opening as one of its invited members - revalidated and written
 * ATOMICALLY.
 *
 * The slot is re-asserted under the same guard as every appointment (this
 * opening's own hold excluded), and THEN the opening row is locked FOR UPDATE
 * and re-checked - the order every barber write takes them in, so the two
 * queue instead of deadlocking. Two members tapping Book at the same moment
 * serialise on the barber's lock and the row: the first books, the second
 * finds it ended.
 */
export async function claimTierOpening(params: {
  accountId: string;
  openingId: string;
  now?: Date;
}): Promise<ClaimTierOpeningResult> {
  const now = params.now ?? new Date();
  let outboxIds: string[] = [];
  let result: ClaimTierOpeningResult;

  try {
    result = await runAsOwner(async (tx): Promise<ClaimTierOpeningResult> => {
      // 🔴 LOCK ORDER: the barber's STAFF lock before this opening's ROW (the
      // order every booking write takes them in - bookingWrite.ts header).
      // Locking the row first deadlocked against a barber booking over the
      // hold, or tapping Undo on the cancel that freed it: that write holds the
      // staff lock and then releases this row. So: read unlocked, guard, then
      // lock the row and re-check it.
      const lockRow = async () => {
        const [row] = await tx.$queryRaw<{ status: string; heldUntil: Date }[]>(
          Prisma.sql`SELECT status, "heldUntil" FROM "TierOpening" WHERE id = ${params.openingId} FOR UPDATE`,
        );
        return row?.status === "HELD" && row.heldUntil.getTime() > now.getTime() ? row : null;
      };

      const invite = await tx.tierOpeningRecipient.findUnique({
        where: { openingId_accountId: { openingId: params.openingId, accountId: params.accountId } },
        select: { clientId: true },
      });
      // Uninvited and nonexistent read the same: an opening is nobody else's business.
      if (!invite) return { outcome: "not_found" };

      const opening = await tx.tierOpening.findUnique({ where: { id: params.openingId } });
      if (!opening) return { outcome: "not_found" };
      if (opening.status !== "HELD" || opening.heldUntil.getTime() <= now.getTime()) return { outcome: "ended" };

      // Re-derived, not trusted: the shop may have corrected the record since
      // the invitation, and then it is no longer this person's to book as.
      await settleClientLinks(tx, [invite.clientId], now);
      const link = await tx.customerClientLink.findFirst({
        where: { accountId: params.accountId, clientId: invite.clientId, status: "active" },
        select: { id: true },
      });
      if (!link) return { outcome: "not_linked" };

      // 🔴 An Auto-fill opening re-offers whatever was cancelled, and nobody
      // chose the service by hand: if the barber has since hidden or retired
      // it, nobody books it through the app. The hold goes, so the time is
      // not lost to everyone. (A manual opening is the barber's own choice.)
      if (
        opening.source === "auto" &&
        !(await tx.service.findFirst({
          where: { id: opening.serviceId, shopId: opening.shopId, ...PUBLIC_SERVICE },
          select: { id: true },
        }))
      ) {
        if (await lockRow()) {
          await tx.tierOpening.update({ where: { id: opening.id }, data: { status: "RELEASED" } });
        }
        return { outcome: "not_found" };
      }

      const [shop, service, client] = await Promise.all([
        tx.shop.findUnique({
          where: { id: opening.shopId },
          select: {
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
          where: { id: opening.serviceId, shopId: opening.shopId },
          select: { price: true, priceOverrides: true, dateOverrides: true, timeOverrides: true },
        }),
        tx.client.findFirst({
          where: { id: invite.clientId, shopId: opening.shopId },
          select: { id: true, firstName: true, lastName: true, phone: true, email: true },
        }),
      ]);
      if (!shop || !client) return { outcome: "not_found" };
      // Blocked since the invitation - this record, or anyone holding its
      // phone or email (services/clientBookingBlock.ts). Nothing is written and
      // the hold stays for the other members.
      if (
        await bookingBlockedFor(tx, opening.shopId, {
          clientId: client.id,
          phone: client.phone,
          email: client.email,
        })
      ) {
        return { outcome: "contact_shop" };
      }

      // The shop turned on deposits (or a required card) mid-hold: never an
      // unpaid or card-less booking. The hold goes back to the pool so the
      // slot is not lost to everyone. Only the row is taken, like any other
      // write that just ends a hold.
      const priceAtBooking = slotPrice(service, opening.startsAt, shop.timezone);
      if (claimWouldRequirePayment(shop, priceAtBooking)) {
        if (!(await lockRow())) return { outcome: "ended" };
        await tx.tierOpening.update({ where: { id: opening.id }, data: { status: "RELEASED" } });
        return { outcome: "deposit_required" };
      }

      await lockStaffAndAssertSlotFree(tx, {
        staffId: opening.staffId,
        shopId: opening.shopId,
        startsAt: opening.startsAt,
        endsAt: opening.endsAt,
        bufferMin: shop.bookingBufferMin,
        tierOpeningIdToIgnore: opening.id,
        serviceDayLimit: { serviceId: opening.serviceId, timezone: shop.timezone },
        walkInCapacity: "enforce",
        now,
      });
      // Now the row: two members tapping Book serialise here (and on the
      // barber's lock above); the second finds it CLAIMED. A barber who booked
      // over it or ended it meanwhile has RELEASED it.
      if (!(await lockRow())) return { outcome: "ended" };
      const status = shop.requireBookingApproval ? "PENDING" : "BOOKED";
      const appt = await tx.appointment.create({
        data: {
          shopId: opening.shopId,
          staffId: opening.staffId,
          serviceId: opening.serviceId,
          clientId: client.id,
          // The shop's own record of this person is the name on the booking.
          firstName: client.firstName?.trim() || "Customer",
          lastName: client.lastName,
          phone: client.phone,
          email: client.email,
          status,
          startsAt: opening.startsAt,
          endsAt: opening.endsAt,
          priceAtBooking: priceAtBooking ?? undefined,
          manageToken: randomToken(),
          bookedVia: "tier_opening",
        },
        select: { id: true, manageToken: true },
      });
      outboxIds = await recordMirrorIntent(tx, {
        shopId: opening.shopId,
        now,
        appointmentId: appt.id,
        staffId: opening.staffId,
        startsAt: opening.startsAt,
        endsAt: opening.endsAt,
        occupancy: {
          status,
          startsAt: opening.startsAt,
          endsAt: opening.endsAt,
          holdExpiresAt: null,
          visitId: null,
        },
      });
      await tx.tierOpening.update({
        where: { id: opening.id },
        data: { status: "CLAIMED", claimedAppointmentId: appt.id },
      });
      return {
        outcome: "claimed",
        appointmentId: appt.id,
        manageToken: appt.manageToken,
        shopId: opening.shopId,
        startsAt: opening.startsAt,
        endsAt: opening.endsAt,
        pending: shop.requireBookingApproval,
      };
    });
  } catch (err) {
    if (err instanceof ServiceDayFullError) return { outcome: "day_full" };
    if (isMirrorNotConfigured(err)) return { outcome: "unavailable_external" };
    if (err instanceof SlotTakenError) {
      // The guard runs before the row is locked, so a second member who
      // queued behind the first's booking lands here. For them the opening
      // has simply ended - it is not a time someone else took.
      const after = await runAsOwner((tx) =>
        tx.tierOpening.findUnique({ where: { id: params.openingId }, select: { status: true } }),
      ).catch(() => null);
      return after && after.status !== "HELD" ? { outcome: "ended" } : { outcome: "slot_taken" };
    }
    throw err;
  }

  if (result.outcome === "claimed") {
    if (outboxIds.length > 0) {
      await dispatchAfterCommit(outboxIds, {
        shopId: result.shopId,
        appointmentId: result.appointmentId,
        via: "tier_opening_claim",
      });
    }
    await noteAvailabilityChanged(result.shopId);
  }
  return result;
}
