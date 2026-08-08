import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { notifySyncedVisitReminder } from "../services/appointmentNotify.js";

/** How far ahead of a visit we send the reminder. Matches the native job. */
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Send the ~24h reminder for every SCHEDULED SYNCED booking (Acuity / Square)
 * starting in the next 24h that hasn't been reminded yet.
 *
 * WHY THIS EXISTS: runAppointmentReminders reads `Appointment`, which only
 * exists for NATIVE bookings. A shop that kept its own calendar has `Visit`
 * rows instead, so it received no appointment reminders whatsoever - while the
 * product's pitch to exactly those shops is "keep your calendar, get everything
 * else." Reminders are the most expected feature in the category.
 *
 * 🔴 THE ONE INVARIANT: skip any Visit that has a linked `appointment`. A native
 * booking is promoted into a Visit once it completes, and those rows are already
 * covered by the native job - reminding both would text the client twice for one
 * haircut. `appointment: { is: null }` is doing real work, not tidying.
 *
 * Everything else mirrors the native job deliberately: same 24h window, same
 * "within 24h" (not "exactly 24h") semantics so a quiet-hours deferral is
 * re-picked on the next tick, same per-channel stamps, idempotent, never throws.
 * The same KNOWN GAP applies: an early-morning visit whose window opens entirely
 * inside quiet hours can miss its reminder.
 */
export async function runSyncedVisitReminders(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_WINDOW_MS);
  const due = await prisma.visit.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { gt: now, lte: horizon },
      // Either channel still pending; notifySyncedVisitReminder guards each by
      // its own stamp, so a row with one channel done can't re-send that one.
      OR: [{ reminderSentAt: null }, { reminderEmailSentAt: null }],
      // NEVER a promoted native booking - see the invariant above.
      appointment: { is: null },
    },
    select: { id: true, shopId: true },
  });
  if (due.length === 0) return 0;

  let sent = 0;
  for (const v of due) {
    const ok = await notifySyncedVisitReminder({
      shopId: v.shopId,
      visitId: v.id,
      now,
    });
    if (ok) sent++;
  }

  logger.info({ candidates: due.length, sent }, "synced visit reminders run");
  return sent;
}
