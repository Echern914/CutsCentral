import { apiEnv } from "@chairback/config";
import { bookNowUrl } from "@chairback/config/bookingLinks";
import { prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { emailDispatchMode, sendEmail } from "../messaging/email.js";
import { buildPickAnotherTimeEmail } from "../messaging/templates.js";

/**
 * "EMAIL THEM TO PICK A NEW TIME" - from "Didn't finish booking".
 *
 * A client started booking, left the card step, and someone else has since
 * booked that time. Many of them believe they are booked. The barber can't
 * text everyone (texting is off), so one tap sends them one email: the time
 * was taken, you're not booked, here is the booking page with your service
 * and staff already picked.
 *
 * 🔴 AT MOST ONCE PER ATTEMPT. `Appointment.unfinishedInvitedAt` is claimed
 * with a compare-and-set BEFORE the send, so two taps (two phones, a retry)
 * send one email; a send that fails clears the claim so it can be tried again.
 *
 * 🔴 IT ASKS SOMEONE TO BOOK, so unlike a confirmation it respects an email
 * unsubscribe (Client.emailOptedOut). And it is never claimed as sent when no
 * email can go out: under DRY_RUN or with email unconfigured it is refused.
 */

export type InviteOutcome =
  | { outcome: "sent"; invitedAt: Date }
  | { outcome: "not_found" }
  /** A live hold: they may still finish in a minute. */
  | { outcome: "still_finishing" }
  /** Invited already - once is the promise. */
  | { outcome: "already_invited" }
  | { outcome: "no_email" }
  /** They unsubscribed from this shop's emails. */
  | { outcome: "unsubscribed" }
  /** No booking page to send them to (switched off, or no usable link). */
  | { outcome: "no_booking_page" }
  /** No email can go out right now (unconfigured, DRY_RUN, or the shop's access lapsed). */
  | { outcome: "email_unavailable" }
  /** The send itself failed; the claim was let go, so trying again is safe. */
  | { outcome: "send_failed" };

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
      // never became a booking.
      where: { id, shopId, holdReason: "payment", status: { in: ["PENDING", "CANCELED"] } },
      select: {
        id: true,
        status: true,
        holdExpiresAt: true,
        startsAt: true,
        firstName: true,
        email: true,
        serviceId: true,
        staffId: true,
        unfinishedInvitedAt: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
        client: { select: { email: true, emailOptedOut: true, archivedAt: true } },
      },
    }),
  );
  if (!appt) return { outcome: "not_found" };
  if (appt.status === "PENDING" && appt.holdExpiresAt !== null && appt.holdExpiresAt.getTime() > now.getTime()) {
    return { outcome: "still_finishing" };
  }
  if (appt.unfinishedInvitedAt !== null) return { outcome: "already_invited" };

  const to = (appt.email ?? appt.client?.email ?? "").trim();
  if (!to || !isValidEmail(to) || appt.client?.archivedAt) return { outcome: "no_email" };
  if (appt.client?.emailOptedOut) return { outcome: "unsubscribed" };
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
  if (claimed.count === 0) return { outcome: "already_invited" };

  const email = buildPickAnotherTimeEmail({
    firstName: appt.firstName,
    shopName: shop.name,
    bookUrl,
    serviceName: appt.service?.name ?? "appointment",
    startsAt: appt.startsAt,
    timezone: shop.timezone,
    staffName: appt.staff?.name ?? null,
  });
  let sent = false;
  try {
    const result = await sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      fromName: shop.name,
      stream: "transactional",
      meta: { shopId, kind: "unfinished_invite", appointmentId: appt.id },
    });
    sent = result.status === "sent";
  } catch {
    // Fixed classification, no address: a provider error can echo the payload.
    logger.error({ shopId, appointmentId: appt.id, reason: "email_send_failed" }, "pick-another-time email failed");
  }
  if (!sent) {
    // Let the claim go so the barber can try again.
    await runWithShop(shopId, (tx) =>
      tx.appointment.updateMany({
        where: { id: appt.id, shopId, unfinishedInvitedAt: now },
        data: { unfinishedInvitedAt: null },
      }),
    );
    return { outcome: "send_failed" };
  }
  return { outcome: "sent", invitedAt: now };
}
