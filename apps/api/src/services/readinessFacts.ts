import { apiEnv, hasShopAddress, vocabularyForShop } from "@chairback/config";
import { prisma, runAsOwner, runWithShop } from "@chairback/db";
import { connectEnabled, hasActiveAccess } from "../billing/stripe.js";
import { emailEnabled } from "../messaging/email.js";
import { pushEnabled } from "../messaging/push.js";
import { smsConfigured } from "../messaging/twilio.js";
import { hasReceptionistEntitlement, receptionistConfigured } from "../receptionist/config.js";
import { countMessagingServices } from "../ops/preflight.js";
import { parseServiceHours } from "../engines/pricing.js";
import { isMappingStale } from "../engines/acuityCalendarMap.js";
import { NOTIFY_DEFAULTS } from "./barberNotify.js";
import {
  MIN_SERVICE_MINUTES,
  type ReadinessCapabilities,
  type ReadinessFacts,
  type RecipientFacts,
  type StaffFacts,
} from "../engines/readiness.js";

/**
 * Gathers everything engines/readiness.ts needs, and nothing else.
 *
 * READ-ONLY. Every statement below is a read. The readiness feature never
 * repairs what it reports.
 *
 * THREE ROUND TRIPS, and they cannot collapse further:
 *
 *   1. plain `prisma` - Shop, its integration rows and the owner. Shop and User
 *      carry RLS with NO policy (default-deny), so reading them INSIDE
 *      runWithShop returns NULL - the documented Shop/User RLS gotcha. They must
 *      be read as the connection owner.
 *   2. ONE `runWithShop` transaction - every tenant table at once. Deliberately
 *      not eight `forShop()` calls: each of those opens its own transaction
 *      (the PR #183 lesson, where the agenda went from 9 round trips to 1).
 *   3. ONE `runAsOwner` transaction - push devices and the recipients' emails.
 *      Device rows are user-keyed and CROSS-SHOP by design (one phone, several
 *      shops), so a shop-scoped read would miss a manager's device registered
 *      under another of their shops. This is the same reason
 *      routes/notifications.ts reads them as owner.
 *
 * Step 3 cannot merge into step 2 because it needs userIds that only step 2
 * produces. It is skipped entirely when a shop has no recipients to look up.
 */

/** Every weekday absent-or-empty means the service is never offered. */
function isClosedEveryWeekday(hoursWindows: unknown): boolean {
  const map = parseServiceHours(hoursWindows);
  // An entirely absent map is "unrestricted", not closed - the default for
  // every service that has never touched its hours.
  if (map.size === 0) return false;
  for (let weekday = 0; weekday < 7; weekday++) {
    const windows = map.get(weekday);
    // Absent weekday = unrestricted = bookable, so this is not closed-all-week.
    if (windows === undefined) return false;
    if (windows.length > 0) return false;
  }
  return true;
}

/** Does this runtime recognise the zone? A bad one silently shifts every slot. */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The platform capability booleans, from the same helpers ops/preflight uses. */
export function collectCapabilities(): ReadinessCapabilities {
  const env = apiEnv();
  return {
    email: emailEnabled(),
    // VAPID. WEB push only - an Expo token needs no server key, so a native
    // device stays deliverable on a deployment with no VAPID at all.
    webPush: pushEnabled(),
    sms: smsConfigured(),
    connect: connectEnabled(),
    receptionist: receptionistConfigured(),
    dryRun: env.DRY_RUN,
    messagingCampaigns: countMessagingServices(env.TWILIO_MESSAGING_SERVICE_SID),
  };
}

/** null when the shop does not exist. */
export async function collectReadinessFacts(
  shopId: string,
): Promise<ReadinessFacts | null> {
  // --- 1. Shop + integrations + owner (owner role; Shop/User are default-deny) ---
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      name: true,
      // Vocabulary inputs. Read HERE, outside runWithShop - Shop is RLS
      // default-deny, so a read inside the tenant scope returns null and every
      // shop would silently fall back to neutral wording in production only.
      industry: true,
      serviceNoun: true,
      businessTypeSelectedAt: true,
      timezone: true,
      slug: true,
      addressStreet: true,
      addressCity: true,
      publicPageEnabled: true,
      bookingMode: true,
      bookingUrl: true,
      bookingLeadHours: true,
      bookingMaxDays: true,
      ownerId: true,
      notifyPhone: true,
      // hasActiveAccess
      subscriptionStatus: true,
      trialEndsAt: true,
      compAccess: true,
      // conditional features
      paymentsMode: true,
      connectChargesEnabled: true,
      stripeConnectAccountId: true,
      depositAmountCents: true,
      payDirectEnabled: true,
      payDirectZelle: true,
      payDirectVenmo: true,
      payDirectCashApp: true,
      cancelWindowHours: true,
      cancelFeeBps: true,
      requireBookingApproval: true,
      waitlistEnabled: true,
      takesRequests: true,
      rewardsEnabled: true,
      receptionistEnabled: true,
      receptionistTermsAcceptedAt: true,
      // hasReceptionistEntitlement's required slice
      plan: true,
      receptionistCompAccess: true,
      receptionistSubscriptionStatus: true,
      aiTrialEndsAt: true,
      // integration presence, without pulling any token
      // 🔴 WIDER SELECT, SAME QUERY. `connectedAt` is what mapping staleness is
      // measured against, and `acuityWebhookIds` is how we know inbound sync is
      // alive. Neither adds a round trip - they are columns on rows this
      // collector was already reading.
      acuity: { select: { id: true, connectedAt: true } },
      square: { select: { id: true } },
      acuityWebhookIds: true,
      acuityOutboundMode: true,
    },
  });
  if (!shop) return null;

  // --- 2. Every tenant table, in ONE transaction ---
  const tenant = await runWithShop(shopId, async (tx) => {
    const [staff, services, offerings, availability, members, prefs, rewardCount, anyAppt] =
      await Promise.all([
        tx.staff.findMany({
          where: { shopId },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          // Chair identity only. No personal contact data belongs in a report.
          // Two more columns on the same row - see the note on the shop select.
          select: {
            id: true,
            name: true,
            active: true,
            imageUrl: true,
            bio: true,
            userId: true,
            acuityCalendarId: true,
            acuityCalendarMappedAt: true,
          },
        }),
        tx.service.findMany({
          where: { shopId },
          select: {
            id: true,
            name: true,
            active: true,
            durationMin: true,
            price: true,
            hoursWindows: true,
          },
        }),
        tx.serviceStaff.findMany({
          where: { shopId },
          select: { serviceId: true, staffId: true },
        }),
        tx.availabilityRule.groupBy({
          by: ["staffId"],
          where: { shopId },
          _count: { _all: true },
        }),
        tx.shopMember.findMany({
          where: { shopId },
          select: { userId: true, staffId: true },
        }),
        tx.barberNotifyPref.findMany({
          where: { shopId },
          select: {
            userId: true,
            pushEnabled: true,
            smsEnabled: true,
            emailEnabled: true,
            newBookingEnabled: true,
            notifyPhone: true,
          },
        }),
        tx.reward.count({ where: { shopId, active: true } }),
        // Existence only - never the appointment, and never the customer on it.
        tx.appointment.findFirst({ where: { shopId }, select: { id: true } }),
      ]);
    return { staff, services, offerings, availability, members, prefs, rewardCount, anyAppt };
  });

  // Read once, used by every chair below.
  const acuityConnected = shop.acuity !== null;
  const acuityConnectedAt = shop.acuity?.connectedAt ?? null;

  const activeStaffIds = new Set(
    tenant.staff.filter((s) => s.active).map((s) => s.id),
  );
  const activeServiceIds = new Set(
    tenant.services.filter((s) => s.active).map((s) => s.id),
  );
  // Services a customer could really book: active, long enough to have been
  // saved, and open on at least one weekday. A chair linked ONLY to a service
  // that is closed all week offers nothing, and an unrelated open service
  // elsewhere in the shop must not paper over that - hence a per-service set
  // rather than a shop-wide boolean.
  const bookableServiceIds = new Set(
    tenant.services
      .filter(
        (s) =>
          s.active &&
          s.durationMin >= MIN_SERVICE_MINUTES &&
          !isClosedEveryWeekday(s.hoursWindows),
      )
      .map((s) => s.id),
  );
  const rulesByStaff = new Map(
    tenant.availability.map((r) => [r.staffId, r._count._all]),
  );
  const seatByStaffId = new Map(
    tenant.members.filter((m) => m.staffId).map((m) => [m.staffId!, m.userId]),
  );

  // Who each chair's alerts go to. Mirrors the ONE rule every send path uses:
  // `staff.userId ?? shop.ownerId` (recipientForAppointment, barberNotify.ts).
  const staffFacts: StaffFacts[] = tenant.staff.map((s) => {
    const links = tenant.offerings.filter((o) => o.staffId === s.id);
    return {
      id: s.id,
      name: s.name,
      active: s.active,
      availabilityRuleCount: rulesByStaff.get(s.id) ?? 0,
      activeServiceLinkCount: links.filter((o) => activeServiceIds.has(o.serviceId)).length,
      bookableServiceLinkCount: links.filter((o) => bookableServiceIds.has(o.serviceId))
        .length,
      hasPhoto: Boolean(s.imageUrl),
      hasBio: Boolean(s.bio?.trim()),
      seatLinked: seatByStaffId.has(s.id),
      recipientUserId: s.userId ?? shop.ownerId,
      recipientIsOwnerFallback: s.userId === null,
      // The ONE staleness rule (engines/acuityCalendarMap.ts), applied here
      // rather than in the engine, which is deliberately Prisma-free. Only
      // meaningful while the shop actually mirrors outbound; a shop with no
      // Acuity has nothing to be stale.
      acuityMappingProblem: !acuityConnected
        ? null
        : !s.acuityCalendarId
          ? ("unmapped" as const)
          : isMappingStale(s.acuityCalendarMappedAt, acuityConnectedAt)
            ? ("stale" as const)
            : null,
    };
  });

  const recipientIds = [...new Set(staffFacts.map((s) => s.recipientUserId))];
  // The owner is always a possible recipient (the fallback), so include them
  // even in a shop with no chairs yet.
  if (!recipientIds.includes(shop.ownerId)) recipientIds.push(shop.ownerId);

  // --- 3. Devices + recipient emails (owner role; devices are cross-shop) ---
  const { devices, users } = recipientIds.length
    ? await runAsOwner(async (tx) => {
        const [devices, users] = await Promise.all([
          // Grouped by KIND as well as user: web and Expo subscriptions are not
          // interchangeable (web needs VAPID, Expo does not), so one
          // undifferentiated count cannot answer "is this person reachable".
          // Still ONE query - a second group-by column, not a second round trip,
          // and emphatically not a query per chair.
          tx.pushSubscription.groupBy({
            by: ["userId", "kind"],
            where: { userId: { in: recipientIds } },
            _count: { _all: true },
          }),
          tx.user.findMany({
            where: { id: { in: recipientIds } },
            // Presence of an address only - the address itself never leaves here.
            select: { id: true, email: true },
          }),
        ]);
        return { devices, users };
      })
    : { devices: [], users: [] };

  const webDevices = new Map<string, number>();
  const expoDevices = new Map<string, number>();
  for (const d of devices) {
    const target = d.kind === "expo" ? expoDevices : webDevices;
    const key = d.userId as string;
    target.set(key, (target.get(key) ?? 0) + d._count._all);
  }
  const emailByUser = new Map(users.map((u) => [u.id, Boolean(u.email?.trim())]));
  const prefsByUser = new Map(tenant.prefs.map((p) => [p.userId, p]));

  const recipients: RecipientFacts[] = recipientIds.map((userId) => {
    // Absent row = the documented defaults (push on, booking texts on, email
    // off), which is what resolveNotifyPrefs returns - not silence.
    const p = prefsByUser.get(userId);
    return {
      userId,
      pushEnabled: p?.pushEnabled ?? NOTIFY_DEFAULTS.pushEnabled,
      smsEnabled: p?.smsEnabled ?? NOTIFY_DEFAULTS.smsEnabled,
      emailEnabled: p?.emailEnabled ?? NOTIFY_DEFAULTS.emailEnabled,
      newBookingEnabled: p?.newBookingEnabled ?? NOTIFY_DEFAULTS.newBookingEnabled,
      webDeviceCount: webDevices.get(userId) ?? 0,
      expoDeviceCount: expoDevices.get(userId) ?? 0,
      // Their own alert number, else the shop-wide one - the same fallback
      // sendToBarber applies. Boolean only; the number never leaves this file.
      hasPhone: Boolean(p?.notifyPhone?.trim() || shop.notifyPhone?.trim()),
      hasEmail: emailByUser.get(userId) ?? false,
    };
  });

  const offeringPairs = tenant.offerings.filter(
    (o) => activeServiceIds.has(o.serviceId) && activeStaffIds.has(o.staffId),
  ).length;

  return {
    shopId: shop.id,
    name: shop.name,
    vocabulary: vocabularyForShop(shop),
    timezone: shop.timezone,
    timezoneValid: isValidTimezone(shop.timezone),
    slug: shop.slug,
    hasAddress: hasShopAddress(shop),
    publicPageEnabled: shop.publicPageEnabled,
    bookingMode: shop.bookingMode,
    bookingUrl: shop.bookingUrl,
    bookingLeadHours: shop.bookingLeadHours,
    bookingMaxDays: shop.bookingMaxDays,
    hasActiveAccess: hasActiveAccess(shop),

    staff: staffFacts,
    services: tenant.services.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      durationMin: s.durationMin,
      hasPrice: s.price !== null,
      activeStaffLinkCount: tenant.offerings.filter(
        (o) => o.serviceId === s.id && activeStaffIds.has(o.staffId),
      ).length,
      closedEveryWeekday: isClosedEveryWeekday(s.hoursWindows),
    })),
    activeOfferingPairs: offeringPairs,
    recipients,
    shopNotifyPhone: Boolean(shop.notifyPhone?.trim()),
    hasAnyAppointment: tenant.anyAppt !== null,

    paymentsMode: shop.paymentsMode,
    connectChargesEnabled: shop.connectChargesEnabled,
    hasConnectAccount: Boolean(shop.stripeConnectAccountId),
    depositAmountCents: shop.depositAmountCents,
    payDirectEnabled: shop.payDirectEnabled,
    payDirectHandleCount: [
      shop.payDirectZelle,
      shop.payDirectVenmo,
      shop.payDirectCashApp,
    ].filter((h) => Boolean(h?.trim())).length,
    cancelWindowHours: shop.cancelWindowHours,
    cancelFeeBps: shop.cancelFeeBps,
    requireBookingApproval: shop.requireBookingApproval,
    waitlistEnabled: shop.waitlistEnabled,
    takesRequests: shop.takesRequests,
    rewardsEnabled: shop.rewardsEnabled,
    activeRewardCount: tenant.rewardCount,
    receptionistEnabled: shop.receptionistEnabled,
    receptionistTermsAccepted: shop.receptionistTermsAcceptedAt !== null,
    receptionistEntitled: hasReceptionistEntitlement(shop),
    integrationConnected:
      shop.bookingMode === "acuity"
        ? shop.acuity !== null
        : shop.bookingMode === "square"
          ? shop.square !== null
          : false,
    acuityConnected,
    acuityWebhookCount: shop.acuityWebhookIds.length,
    acuityOutboundMode: shop.acuityOutboundMode,
  };
}
