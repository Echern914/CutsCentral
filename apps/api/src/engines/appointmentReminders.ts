import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { notifyAppointmentReminder } from "../services/appointmentNotify.js";

/** How far ahead of an appointment we send the reminder. */
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Send the ~24h appointment reminder for every BOOKED native appointment that
 * (a) starts within the next 24h and (b) hasn't had its reminder sent yet.
 *
 * Runs across all shops; idempotent via reminderSentAt (the notify helper stamps
 * it only on a real send). Quiet hours DEFER rather than skip: the notify gate
 * returns without stamping, so the next post-quiet tick re-picks the same row.
 * That is why the window is "within 24h" rather than "exactly 24h" - a reminder
 * due at 2am goes out at the 8am tick instead.
 *
 * KNOWN GAP (acceptable for v1): an early-morning appointment (e.g. 7:30am) that
 * only enters the 24h window during quiet hours can have its window close
 * (startsAt <= now) before a non-quiet tick runs, so its reminder may never send.
 * Such bookers still got the booking confirmation. Widening this (drop the
 * startsAt > now floor, or pre-quiet send) is a future improvement.
 */
export async function runAppointmentReminders(now = new Date()): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_WINDOW_MS);
  const due = await prisma.appointment.findMany({
    where: {
      status: "BOOKED",
      // Either reminder channel still pending: an SMS-dark shop with email on
      // reminds by email (reminderSentAt stays null, reminderEmailSentAt fills);
      // once BOTH stamps are set the row drops out. notifyAppointmentReminder
      // guards each channel by its own stamp, so no duplicates.
      OR: [{ reminderSentAt: null }, { reminderEmailSentAt: null }],
      startsAt: { gt: now, lte: horizon },
      clientId: { not: null },
    },
    select: { id: true, shopId: true },
  });
  if (due.length === 0) return 0;

  let sent = 0;
  for (const a of due) {
    const ok = await notifyAppointmentReminder({
      shopId: a.shopId,
      appointmentId: a.id,
      now,
    });
    if (ok) sent++;
  }

  logger.info({ candidates: due.length, sent }, "appointment reminders run");
  return sent;
}
