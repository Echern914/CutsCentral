import { apiEnv } from "@chairback/config";
import { bookNowUrl } from "@chairback/config/bookingLinks";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { emailDispatchMode, ResendSendError, sendEmail } from "../messaging/email.js";
import { buildPickAnotherTimeEmail } from "../messaging/templates.js";
import { firstNameKey, takenByABooking } from "./unfinishedBookings.js";

/**
 * "EMAIL THEM TO PICK A NEW TIME" - from "Didn't finish booking".
 *
 * A client started booking, left the card step, and someone else has since
 * booked that time. Many of them believe they are booked. The barber can't
 * text everyone (texting is off), so one tap sends them one email: the time
 * was taken, you're not booked, here is the booking page with your service
 * and staff already picked.
 *
 * 🔴 EVERY WORD OF THAT EMAIL IS RE-CHECKED HERE, not trusted from a screen
 * that may be minutes old: the time is still ahead and someone ELSE's booking
 * holds it (not a card step in progress, not their own), they haven't booked
 * since, the row wasn't dismissed. A repeating try, a client who paid, one the
 * shop blocked, or one who unsubscribed is refused - each is a conversation,
 * not this email.
 *
 * 🔴 AT MOST ONCE PER ATTEMPT. `Appointment.unfinishedInvitedAt` is claimed
 * with a compare-and-set BEFORE the send, so two taps send one email. A send
 * Resend definitely refused lets the claim go; one whose answer was lost keeps
 * it (it may have gone out) and rides a stable Idempotency-Key, so even a
 * retry inside Resend's window cannot become a second email.
 */

export type InviteOutcome =
  | { outcome: "sent"; invitedAt: Date }
  | { outcome: "not_found" }
  /** A live hold: they may still finish in a minute. */
  | { outcome: "still_finishing" }
  /** Invited already - once is the promise. */
  | { outcome: "already_invited"; invitedAt: Date | null }
  | { outcome: "no_email" }
  /** They unsubscribed from this shop's emails. */
  | { outcome: "unsubscribed" }
  /** The shop blocked them from booking. */
  | { outcome: "blocked" }
  /** A repeating booking: a conversation, not this email. */
  | { outcome: "repeating" }
  /** Their payment came in: a refund question, not an invitation. */
  | { outcome: "paid" }
  /** Nothing about the time is as the email would say any more. */
  | { outcome: "stale" }
  /** No booking page to send them to (switched off, or no usable link). */
  | { outcome: "no_booking_page" }
  /** No email can go out right now (unconfigured, DRY_RUN, or the shop's access lapsed). */
  | { outcome: "email_unavailable" }
  /** Resend refused it; the claim was let go, so trying again is safe. */
  | { outcome: "send_failed" }
  /** The answer was lost: it may have gone out. The claim stands. */
  | { outcome: "unknown" };

const PAID = new Set(["succeeded", "requires_capture", "processing", "refunded", "partially_refunded"]);

function isValidEmail(email: string): boolean {
  const e = email.trim();
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@")) return false;
  const domain = e.slice(at + 1);
  return domain.length >= 3 && domain.includes(".") && !e.includes(" ");
}

export async function inviteUnfinishedClient(shopId: string, id: string, now: Date): Promise<InviteOutcome> {
  // Shop has RLS with no policy: read as the owner.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      name: true,
      timezone: true,
      bookingMode: true,
      bookingUrl: true,
      slug: true,
      publicPageEnabled: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      compAccess: true,
    },
  });
  if (!shop) return { outcome: "not_found" };

  const appt = await runWithShop(shopId, (tx) =>
    tx.appointment.findFirst({
      // Only an unfinished booking the list could show: a payment hold that
      // never became a booking, still ahead, not dismissed.
      where: { id, shopId, holdReason: "payment", status: { in: ["PENDING", "CANCELED"] } },
      select: {
        id: true,
        status: true,
        holdExpiresAt: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        firstName: true,
        email: true,
        clientId: true,
        serviceId: true,
        staffId: true,
        seriesId: true,
        unfinishedInvitedAt: true,
        unfinishedDismissedAt: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
        client: { select: { email: true, emailOptedOut: true, archivedAt: true, bookingBlockedAt: true } },
        payments: {
          where: { purpose: "booking" },
          orderBy: { createdAt: "desc" },
          select: { status: true },
          take: 1,
        },
      },
    }),
  );
  if (!appt) return { outcome: "not_found" };
  if (appt.status === "PENDING" && appt.holdExpiresAt !== null && appt.holdExpiresAt.getTime() > now.getTime()) {
    return { outcome: "still_finishing" };
  }
  if (appt.unfinishedInvitedAt !== null) return { outcome: "already_invited", invitedAt: appt.unfinishedInvitedAt };
  if (appt.startsAt.getTime() <= now.getTime() || appt.unfinishedDismissedAt !== null) return { outcome: "stale" };
  if (appt.seriesId !== null) return { outcome: "repeating" };
  if (appt.payments.some((p) => PAID.has(p.status))) return { outcome: "paid" };
  if (appt.client?.bookingBlockedAt) return { outcome: "blocked" };

  const to = (appt.email ?? appt.client?.email ?? "").trim();
  if (!to || !isValidEmail(to) || appt.client?.archivedAt) return { outcome: "no_email" };
  if (appt.client?.emailOptedOut) return { outcome: "unsubscribed" };

  // The facts the email states, as they stand NOW.
  const stillTrue = await runWithShop(shopId, async (tx) => {
    if (
      !(await takenByABooking(tx, {
        shopId,
        staffId: appt.staffId,
        start: appt.startsAt,
        end: appt.endsAt,
        now,
        clientId: appt.clientId,
      }))
    ) {
      return false;
    }
    // Booked since, by this same person (a family on one phone is not one person).
    if (appt.clientId) {
      const since = await tx.appointment.findMany({
        where: {
          shopId,
          clientId: appt.clientId,
          createdAt: { gt: appt.createdAt },
          status: { in: ["BOOKED", "COMPLETED"] },
        },
        select: { firstName: true },
      });
      const who = firstNameKey(appt.firstName);
      if (since.some((s) => firstNameKey(s.firstName) === who)) return false;
    }
    return true;
  });
  if (!stillTrue) return { outcome: "stale" };

  if (emailDispatchMode() !== "live" || !hasActiveAccess(shop, { now })) return { outcome: "email_unavailable" };

  const base = bookNowUrl(shop, apiEnv().APP_BASE_URL);
  if (!base) return { outcome: "no_booking_page" };
  // On a ChairBack booking page, land them on the service and staff they
  // wanted (the page ignores ids it no longer offers). Another system's link
  // is used as it is.
  const bookUrl =
    shop.bookingMode === "native"
      ? `${base}?service=${encodeURIComponent(appt.serviceId)}&staff=${encodeURIComponent(appt.staffId)}`
      : base;

  // Claim BEFORE sending: two taps send one email.
  const claimed = await runWithShop(shopId, (tx) =>
    tx.appointment.updateMany({
      where: { id: appt.id, shopId, unfinishedInvitedAt: null },
      data: { unfinishedInvitedAt: now },
    }),
  );
  if (claimed.count === 0) return { outcome: "already_invited", invitedAt: null };

  const email = buildPickAnotherTimeEmail({
    firstName: appt.firstName,
    shopName: shop.name,
    bookUrl,
    serviceName: appt.service?.name ?? "appointment",
    startsAt: appt.startsAt,
    timezone: shop.timezone,
    staffName: appt.staff?.name ?? null,
  });
  const release = () =>
    runWithShop(shopId, (tx) =>
      tx.appointment.updateMany({
        where: { id: appt.id, shopId, unfinishedInvitedAt: now },
        data: { unfinishedInvitedAt: null },
      }),
    );
  try {
    const result = await sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      fromName: shop.name,
      stream: "transactional",
      // One attempt, one email: Resend collapses a retry under the same key.
      idempotencyKey: `unfinished-invite:${appt.id}`,
      meta: { shopId, kind: "unfinished_invite", appointmentId: appt.id },
    });
    if (result.status === "sent") return { outcome: "sent", invitedAt: now };
    // Not sent, and nothing reached a provider (switched off since the check).
    await release();
    return { outcome: "email_unavailable" };
  } catch (err) {
    // Fixed classification, no address: a provider error can echo the payload.
    logger.error(
      { shopId, appointmentId: appt.id, reason: "email_send_failed", status: err instanceof ResendSendError ? err.status : null },
      "pick-another-time email failed",
    );
    // Resend definitely refused it (a 4xx): nothing went out - let the claim go.
    if (err instanceof ResendSendError && err.status < 500) {
      await release();
      return { outcome: "send_failed" };
    }
    // A timeout, a reset, a 5xx: it may well have gone out. Keep the claim.
    return { outcome: "unknown" };
  }
}
