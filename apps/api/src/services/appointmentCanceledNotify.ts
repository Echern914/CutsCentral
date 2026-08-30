import { runAsOwner } from "@chairback/db";
import { buildAppointmentCanceledEmail } from "../messaging/templates.js";
import { sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";

/**
 * "Your appointment was canceled" - the message the customer never got.
 *
 * Until now a cancellation notified the BARBER (a push and a text) and told
 * the customer nothing at all, on every path: manage-link cancel, dashboard
 * cancel, no-show, series cancel, the AI receptionist. A customer who cancels
 * their own booking may not need telling, but a customer whose barber cancels
 * has no idea their haircut is gone until they turn up for it.
 *
 * 🔴 CLAIM, THEN SEND - never send, then stamp. Two people can hit cancel at
 * the same moment (the barber on the dashboard while the customer taps the
 * manage link), a retry can follow an ambiguous provider failure, and a
 * cancel-restore-cancel cycle passes through here twice. The claim is an
 * atomic `updateMany` on `cancellationEmailSentAt IS NULL`: exactly one caller
 * gets `count === 1` and may send, everyone else returns silently. Losing the
 * message on a provider failure is the deliberate trade - one missed email
 * beats telling a customer twice that the same appointment is gone.
 *
 * The cancellation itself has ALREADY committed before this runs. Nothing in
 * here can roll it back: every path returns rather than throwing.
 */

/** Statuses whose cancellation is worth telling the customer about. */
const NOTIFIABLE = new Set(["CANCELED"]);

export async function notifyAppointmentCanceled(params: {
  shopId: string;
  appointmentId: string;
  now?: Date;
}): Promise<"sent" | "skipped" | "already_sent" | "failed"> {
  const now = params.now ?? new Date();
  try {
    // Owner read: this runs post-commit from engine code with no request
    // tenant context, and every field below is filtered to this shop anyway.
    const appt = await runAsOwner((tx) =>
      tx.appointment.findFirst({
        where: { id: params.appointmentId, shopId: params.shopId },
        select: {
          id: true,
          status: true,
          startsAt: true,
          firstName: true,
          email: true,
          cancellationEmailSentAt: true,
          client: { select: { email: true, firstName: true } },
          service: { select: { name: true } },
          staff: { select: { name: true } },
          shop: {
            select: { id: true, name: true, slug: true, timezone: true },
          },
        },
      }),
    );
    if (!appt) return "skipped";

    // A stale or repeated call for something that is no longer a cancellation
    // (restored to BOOKED, or a NO_SHOW, which is a different conversation)
    // must send nothing.
    if (!NOTIFIABLE.has(appt.status)) return "skipped";
    if (appt.cancellationEmailSentAt) return "already_sent";

    const to = appt.email ?? appt.client?.email ?? null;
    if (!to) return "skipped"; // no address is not a failure

    // 🔴 THE CLAIM. Whoever flips the null owns the send.
    const claimed = await runAsOwner((tx) =>
      tx.appointment.updateMany({
        where: {
          id: appt.id,
          shopId: params.shopId,
          status: "CANCELED",
          cancellationEmailSentAt: null,
        },
        data: { cancellationEmailSentAt: now },
      }),
    );
    if (claimed.count !== 1) return "already_sent";

    const email = buildAppointmentCanceledEmail({
      firstName: appt.firstName ?? appt.client?.firstName ?? null,
      shopName: appt.shop.name,
      shopSlug: appt.shop.slug,
      serviceName: appt.service?.name ?? "your appointment",
      startsAt: appt.startsAt,
      timezone: appt.shop.timezone,
      staffName: appt.staff?.name ?? null,
    });

    const result = await sendEmail({
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      fromName: appt.shop.name,
      stream: "transactional",
      meta: { shopId: params.shopId, appointmentId: appt.id, kind: "cancellation" },
    });
    return result.status === "sent" || result.status === "dry_run"
      ? "sent"
      : "skipped";
  } catch {
    // 🔴 Fixed classification only, and no address: a provider error can echo
    // the whole payload. The claim stays taken on purpose - see the header.
    logger.error(
      {
        shopId: params.shopId,
        appointmentId: params.appointmentId,
        reason: "cancellation_email_failed",
      },
      "cancellation email failed",
    );
    return "failed";
  }
}
