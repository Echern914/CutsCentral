import { LOYALTY_TIERS, apiEnv, randomToken } from "@chairback/config";
import { Prisma, prisma, runAsOwner, runWithShop, type LoyaltyTier } from "@chairback/db";
import { logger } from "../logger.js";
import { noteAvailabilityChanged } from "../services/availabilityCache.js";
import { settleClientLinks } from "../services/customerIdentity.js";
import { sendPushToClient } from "../messaging/push.js";
import { formatApptTime } from "../messaging/templates.js";
import { dispatchAfterCommit, recordMirrorIntent } from "./acuityMirror.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "./bookingWrite.js";
import { isMirrorNotConfigured } from "./mirrorNotConfigured.js";
import { effectivePriceAt } from "./pricing.js";
import { ServiceDayFullError } from "./serviceDailyLimit.js";
import { computeOpenSlots } from "./slots.js";
import { claimWouldRequirePayment } from "./waitlistOffer.js";

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
      client: { shopId, archivedAt: null, loyaltyTier: { in: tiers } },
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
      tx.client.count({ where: { shopId, archivedAt: null, loyaltyTier: { in: tiers } } }),
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
    select: { price: true },
  });
  if (claimWouldRequirePayment(shop, service?.price == null ? null : Number(service.price))) {
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
        data: people.map((p) => ({ openingId: opening.id, accountId: p.accountId, clientId: p.clientId })),
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

/**
 * Tell each invited member. After commit, never inside the hold's transaction:
 * a push provider being slow must not hold the barber's calendar lock.
 */
export async function notifyInvitees(openingId: string): Promise<{ delivered: number; recipients: number }> {
  const opening = await prisma.tierOpening.findUnique({
    where: { id: openingId },
    select: {
      id: true,
      shopId: true,
      staffId: true,
      serviceId: true,
      startsAt: true,
      heldUntil: true,
      minTier: true,
      shop: { select: { name: true, timezone: true, requireBookingApproval: true } },
    },
  });
  if (!opening) return { delivered: 0, recipients: 0 };
  const [recipients, names] = await Promise.all([
    runAsOwner((tx) =>
      tx.tierOpeningRecipient.findMany({
        where: { openingId },
        select: { clientId: true, client: { select: { magicToken: true } } },
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

  const tz = opening.shop.timezone;
  const label = LOYALTY_TIERS[opening.minTier].label;
  const what = [names.service?.name, names.staff?.name ? `with ${names.staff.name}` : null].filter(Boolean).join(" ");
  const verb = opening.shop.requireBookingApproval ? "request" : "book";
  const base = apiEnv().APP_BASE_URL.replace(/\/$/, "");
  let delivered = 0;
  for (const r of recipients) {
    const result = await sendPushToClient({
      shopId: opening.shopId,
      clientId: r.clientId,
      kind: "promo",
      payload: {
        title: `${opening.shop.name}: an opening for ${label}${opening.minTier === "GOLD" ? "" : " and up"}`,
        body: `${formatApptTime(opening.startsAt, tz)}${what ? ` · ${what}` : ""}. Yours to ${verb} in the app until ${timeOnly(opening.heldUntil, tz)}.`,
        // The web rewards page for a browser subscription; the app reads the
        // `opening` parameter and opens Profile, where the opening is.
        url: `${base}/r/${r.client.magicToken}?opening=${encodeURIComponent(opening.id)}`,
        tag: `tier-opening-${opening.id}`,
      },
    });
    if (result.anyDelivered) delivered += 1;
  }
  logger.info({ shopId: opening.shopId, openingId, recipients: recipients.length, delivered }, "tier opening notified");
  return { delivered, recipients: recipients.length };
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
        client: { customerLinks: { some: { accountId, status: "active" } } },
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
  | { outcome: "unavailable_external" };

/**
 * Book an opening as one of its invited members - revalidated and written
 * ATOMICALLY.
 *
 * The opening row is locked FOR UPDATE first, so two members tapping Book at
 * the same moment serialise on it: the first books, the second finds CLAIMED.
 * The slot is then re-asserted under the same guard as every appointment, with
 * this opening's own hold excluded.
 */
export async function claimTierOpening(params: {
  accountId: string;
  openingId: string;
  now?: Date;
}): Promise<ClaimTierOpeningResult> {
  const now = params.now ?? new Date();
  let outboxId: string | null = null;
  let result: ClaimTierOpeningResult;

  try {
    result = await runAsOwner(async (tx): Promise<ClaimTierOpeningResult> => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM "TierOpening" WHERE id = ${params.openingId} FOR UPDATE`,
      );
      if (locked.length === 0) return { outcome: "not_found" };

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

      // The shop turned deposits on mid-hold: never an unpaid booking. The hold
      // goes back to the pool so the slot is not lost to everyone.
      if (claimWouldRequirePayment(shop, service?.price == null ? null : Number(service.price))) {
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

      const priceAtBooking = service
        ? effectivePriceAt(service.price === null ? null : Number(service.price), {
            at: opening.startsAt,
            timezone: shop.timezone,
            weekdayOverrides: service.priceOverrides,
            dateOverrides: service.dateOverrides,
            timeWindows: service.timeOverrides,
          })
        : null;
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
      outboxId = await recordMirrorIntent(tx, {
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
    if (err instanceof SlotTakenError) return { outcome: "slot_taken" };
    throw err;
  }

  if (result.outcome === "claimed") {
    if (outboxId) {
      await dispatchAfterCommit(outboxId, {
        shopId: result.shopId,
        appointmentId: result.appointmentId,
        via: "tier_opening_claim",
      });
    }
    await noteAvailabilityChanged(result.shopId);
  }
  return result;
}
