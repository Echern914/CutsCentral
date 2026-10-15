import { createHash } from "node:crypto";
import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { resolveWaitlistClient } from "./waitlistClientLink.js";
import { walkInExpiryBoundary } from "./walkInExpiryRule.js";
import { estimateQueue, type EntryForEstimate } from "./walkInEstimate.js";
import {
  nextPosition,
  snapshotServices,
  WalkInDuplicateEntryError,
  WalkInQueueFullError,
  WalkInStaffError,
  WALK_IN_MAX_ACTIVE,
} from "./walkInQueue.js";
import { ACTIVE_STATUSES, QUEUE_ORDER } from "./walkInLifecycle.js";
import {
  recordWalkInEvent,
  recordWalkInEventBestEffort,
  WALK_IN_CUSTOMER_ACTOR,
} from "./walkInAudit.js";

/**
 * Walk-In Mode: the PUBLIC kiosk check-in. Runs as the connection owner
 * (the waitlist-join trust model - there is no authenticated shop context on
 * a public tablet), with the shop resolved by its kiosk credential and the
 * phone proven by the OTP flow before this module is ever called.
 *
 * 🔑 THE DEDUPE IS THE PRIVACY MECHANISM. One live spot per phone is a
 * partial unique index (PR 1); when it fires, this module does NOT say so -
 * it ROTATES the existing entry's tracking token, re-texts the same entry's
 * link, and hands the route the same success shape a fresh join gets. The
 * old link stops working (hash overwritten, session cleared) because the
 * credential is hash-only and cannot be re-texted verbatim - rotation IS the
 * re-send, by design.
 */

/** The consent sentence shown at the kiosk, versioned like every other
 * consent text (never edit a version in place - add v2). */
export const WALK_IN_SMS_CONSENT_VERSION = "v1";
export const WALK_IN_SMS_CONSENT_TEXT =
  "Text me my place in line and updates about today's visit. Message and " +
  "data rates may apply. Reply STOP to opt out at any time.";
export const CONSENT_SOURCE_KIOSK = "walk_in_kiosk";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/** Tracking token: 32 bytes (256 bits) of entropy, hash-only at rest. */
export function mintTrackToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}

const ACTIVE = [...ACTIVE_STATUSES];

/** The active queue in board order, shaped for the estimate engine. */
export async function activeQueueForEstimate(
  shopId: string,
): Promise<EntryForEstimate[]> {
  const entries = await prisma.walkInEntry.findMany({
    where: { shopId, status: { in: ACTIVE } },
    orderBy: [...QUEUE_ORDER],
    select: {
      id: true,
      status: true,
      position: true,
      joinedAt: true,
      preferredStaffId: true,
      assignedStaffId: true,
      services: { select: { serviceId: true, durationMinAtJoin: true } },
    },
  });
  return entries.map((e) => ({
    id: e.id,
    status: e.status,
    position: e.position,
    joinedAt: e.joinedAt,
    preferredStaffId: e.preferredStaffId,
    assignedStaffId: e.assignedStaffId,
    totalDurationMin: e.services.reduce((s, x) => s + x.durationMinAtJoin, 0),
    serviceIds: e.services.map((x) => x.serviceId),
  }));
}

/**
 * The quote the kiosk shows BEFORE confirmation: what would a joiner at the
 * end of today's line wait? Same engine, same calendar, one synthetic tail
 * entry - so the number on the tablet is the number the board will show.
 */
export async function estimateForNewEntry(opts: {
  shopId: string;
  now: Date;
  totalDurationMin: number;
  serviceIds: string[];
  preferredStaffId: string | null;
}): Promise<{ waitMin: number | null; ahead: number }> {
  const queue = await activeQueueForEstimate(opts.shopId);
  const synthetic: EntryForEstimate = {
    id: "__candidate__",
    status: "WAITING",
    position: Number.MAX_SAFE_INTEGER,
    joinedAt: opts.now,
    preferredStaffId: opts.preferredStaffId,
    assignedStaffId: null,
    totalDurationMin: Math.max(1, opts.totalDurationMin),
    serviceIds: opts.serviceIds,
  };
  const est = await estimateQueue({
    shopId: opts.shopId,
    now: opts.now,
    queue: [...queue, synthetic],
  });
  return {
    waitMin: est.get("__candidate__")?.waitMin ?? null,
    ahead: queue.length,
  };
}

export interface KioskCheckInResult {
  entryId: string;
  /** The line the entry is in. At a team desk a kept spot can be another
   * business's line than the one just picked. */
  shopId: string;
  /** The raw tracking token for the SMS - exists here and in the text,
   * nowhere else, ever. */
  trackToken: string;
  /** The quote stamped on the entry (null = honest "estimate unavailable"). */
  waitMin: number | null;
  /** True when the phone already had a live spot: the existing entry was
   * kept, its token rotated. The ROUTE's answer must not differ. */
  deduped: boolean;
  clientLinked: boolean;
}

/**
 * Create the queue entry for a VERIFIED phone (the OTP proof was consumed by
 * the route before calling this). Exactly one active entry per phone under
 * any concurrency - the partial unique index decides, this module absorbs it.
 */
export async function kioskCheckIn(opts: {
  shopId: string;
  timezone: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  serviceIds: string[];
  preferredStaffId: string | null;
  smsConsent: boolean;
  now: Date;
  /**
   * The TEAM front desk this check-in came through (services/teamWalkIns.ts),
   * when it did. The entry still belongs to `shopId` - the business they
   * chose - and also carries the desk, so that desk's owner sees it in the
   * desk's line. One live spot per phone per desk: a phone already waiting
   * for ANY business from this desk keeps that spot (rotated, below).
   */
  viaTeamShopId?: string | null;
}): Promise<KioskCheckInResult> {
  const { shopId, timezone, phone, now } = opts;
  const viaTeamShopId = opts.viaTeamShopId ?? null;

  // Already waiting at this desk - for this business or another one: the
  // same answer a duplicate gets at one shop's own kiosk (see below).
  if (viaTeamShopId) {
    const atDesk = await prisma.walkInEntry.findFirst({
      where: { viaTeamShopId, phone, status: { in: ACTIVE } },
      select: { id: true },
    });
    if (atDesk) return rotateExisting(atDesk.id, null);
  }

  // Associate an existing client ONLY within this shop, by the one link rule
  // the waitlist already uses (unambiguous, non-archived, exact phone).
  // The phone was proven with a text code before this ran.
  const link = await resolveWaitlistClient(prisma, shopId, phone, { contact: "vouched" });
  const client = link.clientId
    ? await prisma.client.findFirst({
        where: { id: link.clientId, shopId },
        select: { id: true, firstName: true, optedOut: true },
      })
    : null;

  const firstName =
    opts.firstName?.trim() || client?.firstName?.trim() || null;
  if (!firstName) {
    // Post-verification, own-data: an honest 400 is fine here.
    throw new WalkInServiceInputError("name_required");
  }

  const { token, hash } = mintTrackToken();
  const boundary = walkInExpiryBoundary(now, timezone);
  const consent =
    opts.smsConsent && phone
      ? {
          smsConsentAt: now,
          smsConsentSource: CONSENT_SOURCE_KIOSK,
          smsConsentVersion: WALK_IN_SMS_CONSENT_VERSION,
          smsConsentPhone: phone,
        }
      : {};

  try {
    const created = await prisma.$transaction(async (tx) => {
      const active = await tx.walkInEntry.count({
        where: { shopId, status: { in: ACTIVE } },
      });
      if (active >= WALK_IN_MAX_ACTIVE) throw new WalkInQueueFullError();

      if (opts.preferredStaffId) {
        const staff = await tx.staff.findFirst({
          where: { id: opts.preferredStaffId, shopId },
          select: { active: true },
        });
        if (!staff) throw new WalkInStaffError("staff_not_found");
        if (!staff.active) throw new WalkInStaffError("staff_inactive");
      }

      const services = await snapshotServices(
        tx,
        shopId,
        timezone,
        opts.serviceIds,
        now,
      );
      const totalDurationMin = services.reduce(
        (s, x) => s + x.durationMinAtJoin,
        0,
      );
      // Quote from inside the tx's view of the queue - close enough, and the
      // stamp is ops-health data, never re-read as a live estimate.
      const quote = await estimateForNewEntry({
        shopId,
        now,
        totalDurationMin,
        serviceIds: services.map((s) => s.serviceId),
        preferredStaffId: opts.preferredStaffId ?? null,
      });

      const position = await nextPosition(tx, shopId);
      const entry = await tx.walkInEntry.create({
        data: {
          shopId,
          clientId: client?.id ?? null,
          firstName,
          lastName: opts.lastName?.trim() || null,
          phone,
          source: "KIOSK",
          status: "WAITING",
          position,
          preferredStaffId: opts.preferredStaffId ?? null,
          viaTeamShopId,
          quotedWaitMin: quote.waitMin,
          quotedAt: now,
          trackTokenHash: hash,
          trackTokenExpiresAt: boundary,
          joinedAt: now,
          ...consent,
        },
        select: { id: true },
      });
      await tx.walkInEntryService.createMany({
        data: services.map((s) => ({ ...s, shopId, entryId: entry.id })),
      });
      await recordWalkInEvent(tx, {
        shopId,
        entryId: entry.id,
        type: "entry.checked_in",
        actor: WALK_IN_CUSTOMER_ACTOR,
        metadata: {
          position,
          serviceCount: services.length,
          source: "KIOSK",
          waitMin: quote.waitMin,
          ...(viaTeamShopId ? { via: "team_desk" } : {}),
        },
      });
      return { id: entry.id, waitMin: quote.waitMin };
    });
    return {
      entryId: created.id,
      shopId,
      trackToken: token,
      waitMin: created.waitMin,
      deduped: false,
      clientLinked: Boolean(client),
    };
  } catch (err) {
    if (
      !(
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      )
    ) {
      throw err;
    }
  }

  // The phone already holds a live spot - in this line, or (at a team desk)
  // in another line this desk filled. Lost a race on either partial unique.
  const existing = await prisma.walkInEntry.findFirst({
    where: {
      phone,
      status: { in: ACTIVE },
      OR: [{ shopId }, ...(viaTeamShopId ? [{ viaTeamShopId }] : [])],
    },
    select: { id: true },
  });
  if (!existing) throw new WalkInDuplicateEntryError(); // vanished mid-race
  return rotateExisting(existing.id, client);
}

/**
 * Keep the spot the phone already holds, ROTATE its credential (hash-only
 * storage means re-texting the old link is impossible by construction), kill
 * any live tracking session, and hand back the same success the fresh path
 * gets. The entry may be in another business's line (a team desk), so its
 * own shop and timezone are read here.
 */
async function rotateExisting(
  entryId: string,
  client: { id: string } | null,
): Promise<KioskCheckInResult> {
  const existing = await prisma.walkInEntry.findUnique({
    where: { id: entryId },
    select: { id: true, shopId: true, joinedAt: true, quotedWaitMin: true, clientId: true, shop: { select: { timezone: true } } },
  });
  if (!existing) throw new WalkInDuplicateEntryError(); // vanished mid-race
  const rotated = mintTrackToken();
  await prisma.walkInEntry.update({
    where: { id: existing.id },
    data: {
      trackTokenHash: rotated.hash,
      trackTokenExpiresAt: walkInExpiryBoundary(existing.joinedAt, existing.shop.timezone),
      trackTokenRevokedAt: null,
      trackSessionHash: null,
      trackSessionExpiresAt: null,
    },
  });
  await recordWalkInEventBestEffort({
    shopId: existing.shopId,
    entryId: existing.id,
    type: "entry.check_in_deduped",
    actor: WALK_IN_CUSTOMER_ACTOR,
    metadata: { source: "KIOSK" },
  });
  await recordWalkInEventBestEffort({
    shopId: existing.shopId,
    entryId: existing.id,
    type: "entry.link_regenerated",
    actor: WALK_IN_CUSTOMER_ACTOR,
  });
  return {
    entryId: existing.id,
    shopId: existing.shopId,
    trackToken: rotated.token,
    waitMin: existing.quotedWaitMin,
    deduped: true,
    clientLinked: Boolean(client ?? existing.clientId),
  };
}

/** Post-verification input problems (own-data; an honest 400). */
export class WalkInServiceInputError extends Error {
  constructor(message: "name_required") {
    super(message);
    this.name = "WalkInServiceInputError";
  }
}
