import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { notifyAppointmentReminder } from "../services/appointmentNotify.js";
import { isDashRunKey } from "./appointmentGroup.js";

/** How far ahead of an appointment we send the reminder. */
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Two members of a run this close are still one sitting. Moved further apart, each is its own visit. */
const RUN_GAP_MS = 60 * 60 * 1000;

interface RunMember {
  id: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * ONE REMINDER FOR A BACK-TO-BACK RUN. One client booked four in a row from the
 * shop's `- 1 +`, and four reminders about one sitting is noise. The first of a
 * sitting speaks and counts the rest; the others stay quiet.
 *
 * 🔴 A QUIET MEMBER IS NOT STAMPED. A stamp would say a reminder went out, and
 * the first one may still be waiting out quiet hours. If that first one is then
 * cancelled, the next is the first of the sitting and has to speak.
 *
 * 🔴 `members` HOLDS COMPLETED ONES TOO, only the cancelled are left out. When
 * the 3:00 is checked out at 3:30, the 3:30 is still ahead and still unstamped.
 * Read as "no earlier member", it would remind them of the visit they are at.
 */
function runSittingOf(me: RunMember, members: RunMember[]): { quiet: boolean; moreRightAfter: number } {
  const sorted = [...members].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const at = sorted.findIndex((m) => m.id === me.id);
  const follows = (earlier: RunMember, later: RunMember) =>
    later.startsAt.getTime() - earlier.endsAt.getTime() <= RUN_GAP_MS;
  if (at > 0 && follows(sorted[at - 1]!, me)) return { quiet: true, moreRightAfter: 0 };
  let moreRightAfter = 0;
  for (let i = at; i + 1 < sorted.length && follows(sorted[i]!, sorted[i + 1]!); i++) moreRightAfter++;
  return { quiet: false, moreRightAfter };
}

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
    select: {
      id: true,
      shopId: true,
      groupId: true,
      startsAt: true,
      endsAt: true,
      group: { select: { idempotencyKey: true } },
    },
  });
  if (due.length === 0) return 0;

  // Only runs: a party's members are different people, and each is told.
  const runIds = [...new Set(due.filter((a) => isDashRunKey(a.group?.idempotencyKey)).map((a) => a.groupId!))];
  const membersByRun = new Map<string, RunMember[]>();
  if (runIds.length > 0) {
    const members = await prisma.appointment.findMany({
      where: { groupId: { in: runIds }, status: { not: "CANCELED" } },
      select: { id: true, groupId: true, startsAt: true, endsAt: true },
    });
    for (const m of members) {
      const list = membersByRun.get(m.groupId!) ?? [];
      list.push(m);
      membersByRun.set(m.groupId!, list);
    }
  }

  let sent = 0;
  for (const a of due) {
    const run = a.groupId ? membersByRun.get(a.groupId) : undefined;
    const sitting = run ? runSittingOf(a, run) : null;
    if (sitting?.quiet) continue;
    const ok = await notifyAppointmentReminder({
      shopId: a.shopId,
      appointmentId: a.id,
      now,
      moreRightAfter: sitting?.moreRightAfter,
    });
    if (ok) sent++;
  }

  logger.info({ candidates: due.length, sent }, "appointment reminders run");
  return sent;
}
