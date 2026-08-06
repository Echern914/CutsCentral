import { prisma, runWithShop } from "@chairback/db";
import {
  localMinutesOfDay,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@chairback/config";
import { logger } from "../logger.js";
import { formatApptTime } from "../messaging/templates.js";
import {
  resolveNotifyPrefs,
  sendToBarber,
  type NotifyPrefs,
} from "../services/barberNotify.js";

/**
 * The barber's own reminders. Everything else in the system tells the CUSTOMER
 * what's coming; nothing told the barber. Two jobs, one tick:
 *
 *  NEXT UP  - "Next up: Sam Cole, 2:30 PM - Fade." Fires `nextUpLeadMin`
 *             before each appointment starts. This is the feature barbers
 *             actually ask for: who is walking in, and what they booked.
 *  DAY AHEAD - "Tomorrow: 6 cuts, 9:00 AM to 4:30 PM. First: Sam - Fade."
 *             Sent the evening before at the barber's chosen hour, so he can
 *             plan the night before rather than discovering it at 8am.
 *
 * Both are per-BARBER, not per-shop: in a multi-chair shop each barber gets
 * only his own chair's appointments (recipient = staff.userId, owner as the
 * fallback for unassigned chairs).
 *
 * Idempotency: next-up claims each appointment with a conditional update on
 * `barberNextUpSentAt IS NULL`, so a double tick or a second replica can never
 * double-send. The digest claims (shop, user, local date) the same way, using
 * the appointment rows' own stamp is impossible there - see claimDigest.
 */

/** How far past the ideal moment we'll still send, before it's just noise. */
const NEXT_UP_GRACE_MIN = 15;

interface ApptRow {
  id: string;
  startsAt: Date;
  firstName: string;
  lastName: string | null;
  service: { name: string };
  staff: { name: string; userId: string | null };
}

function clientName(a: ApptRow): string {
  return [a.firstName, a.lastName].filter(Boolean).join(" ").trim() || "A client";
}

/**
 * "Next up" for every appointment whose lead window opened since the last tick.
 *
 * The lead time is per-barber, so the query can't filter on a single cutoff:
 * it reads the next couple of hours once, then decides per row against that
 * barber's own preference. Cheap (a handful of rows) and keeps the preference
 * authoritative rather than baking one shop-wide number into SQL.
 */
async function runNextUp(shopId: string, ownerId: string, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + 2 * 60 * 60_000); // widest lead we allow
  const rows = (await runWithShop(shopId, (tx) =>
    tx.appointment.findMany({
      where: {
        shopId,
        status: "BOOKED",
        holdExpiresAt: null,
        barberNextUpSentAt: null,
        startsAt: { gt: new Date(now.getTime() - NEXT_UP_GRACE_MIN * 60_000), lte: horizon },
      },
      orderBy: { startsAt: "asc" },
      take: 100,
      select: {
        id: true,
        startsAt: true,
        firstName: true,
        lastName: true,
        service: { select: { name: true } },
        staff: { select: { name: true, userId: true } },
      },
    }),
  )) as ApptRow[];
  if (rows.length === 0) return 0;

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true },
  });
  const tz = shop?.timezone ?? "America/New_York";
  const prefsCache = new Map<string, NotifyPrefs>();
  let sent = 0;

  for (const a of rows) {
    const userId = a.staff.userId ?? ownerId;
    let prefs = prefsCache.get(userId);
    if (!prefs) {
      prefs = await resolveNotifyPrefs(shopId, userId);
      prefsCache.set(userId, prefs);
    }
    if (!prefs.nextUpEnabled) continue;

    const dueAt = a.startsAt.getTime() - prefs.nextUpLeadMin * 60_000;
    if (now.getTime() < dueAt) continue; // its lead window hasn't opened yet

    // Claim BEFORE sending: the stamp is the mutex, so a crash after this
    // point costs one missed alert rather than risking a duplicate every tick.
    const claimed = await runWithShop(shopId, (tx) =>
      tx.appointment.updateMany({
        where: { id: a.id, shopId, barberNextUpSentAt: null },
        data: { barberNextUpSentAt: now },
      }),
    );
    if (claimed.count === 0) continue; // another tick/replica got it

    await sendToBarber({
      shopId,
      userId,
      kind: "nextUp",
      prefs,
      message: {
        title: `Next up: ${clientName(a)}`,
        body: `${clientName(a)} - ${a.service.name} at ${formatApptTime(a.startsAt, tz)}`,
        tag: `next-up-${a.id}`,
      },
    });
    sent++;
  }
  return sent;
}

/**
 * Claim "this shop+user's digest for this local date" so the evening send
 * happens at most once even though the job ticks every 5 minutes.
 *
 * Appointment stamps can't express this (a digest spans many rows, and a day
 * with zero bookings still needs claiming so we don't re-check forever), so it
 * borrows the counter table the receptionist cap alert uses: an insert that
 * loses the unique race means somebody already sent it.
 */
async function claimDigest(key: string): Promise<boolean> {
  // ON CONFLICT DO NOTHING: 1 row affected = we claimed it, 0 = someone else
  // already did. One atomic statement, pooler-safe, and the same
  // `now() AT TIME ZONE 'UTC'` convention as capAlert.ts / lease.ts.
  const affected = await prisma.$executeRaw`
    INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
    VALUES (
      ${key},
      1,
      (now() AT TIME ZONE 'UTC') + interval '2 days',
      now() AT TIME ZONE 'UTC'
    )
    ON CONFLICT ("key") DO NOTHING
  `;
  return affected > 0;
}

/**
 * The evening "here's tomorrow" digest, per barber, at that barber's chosen
 * shop-local hour.
 */
async function runDayAhead(shopId: string, ownerId: string, now: Date): Promise<number> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true },
  });
  const tz = shop?.timezone ?? "America/New_York";
  const localNow = zonedDateParts(now, tz);
  // zonedDateParts has no hour - derive it from minutes-since-local-midnight.
  const localHour = Math.floor(localMinutesOfDay(now, tz) / 60);

  // Everyone who could receive one: staff with a linked login, plus the owner.
  const staffRows = (await runWithShop(shopId, (tx) =>
    tx.staff.findMany({
      where: { shopId, active: true },
      select: { id: true, userId: true },
    }),
  )) as { id: string; userId: string | null }[];
  const recipients = new Set<string>([ownerId]);
  for (const s of staffRows) if (s.userId) recipients.add(s.userId);

  // Tomorrow as a real UTC range. It MUST be the instant the shop's local
  // midnight happens, not a UTC-midnight marker: for New York those differ by
  // 4-5 hours, so a marker-based window would include tonight's 8pm-midnight
  // and miss tomorrow's. zonedWallTimeToUtc is the one helper that gets this
  // right across DST.
  const startOfTomorrowUtc = zonedWallTimeToUtc(
    localNow.year,
    localNow.month0,
    localNow.day + 1, // Date.UTC inside the helper normalizes month overflow
    0,
    tz,
  );
  const endOfTomorrowUtc = zonedWallTimeToUtc(
    localNow.year,
    localNow.month0,
    localNow.day + 2,
    0,
    tz,
  );
  // The claim key is the LOCAL date, so it reads as the day the barber means.
  const tomorrowKey = new Date(
    Date.UTC(localNow.year, localNow.month0, localNow.day + 1),
  )
    .toISOString()
    .slice(0, 10);

  let sent = 0;
  for (const userId of recipients) {
    const prefs = await resolveNotifyPrefs(shopId, userId);
    if (!prefs.dayAheadEnabled) continue;
    // Only in the hour the barber picked (the job ticks every 5 min, so the
    // claim below is what makes it once).
    if (localHour !== prefs.dayAheadHour) continue;

    const staffIds = staffRows.filter((s) => s.userId === userId).map((s) => s.id);
    const rows = (await runWithShop(shopId, (tx) =>
      tx.appointment.findMany({
        where: {
          shopId,
          status: "BOOKED",
          holdExpiresAt: null,
          startsAt: { gte: startOfTomorrowUtc, lt: endOfTomorrowUtc },
          // A barber sees his own chair; the owner sees the whole shop (which
          // is also what a solo barber wants).
          ...(userId === ownerId && staffIds.length === 0 ? {} : { staffId: { in: staffIds } }),
        },
        orderBy: { startsAt: "asc" },
        take: 100,
        select: {
          id: true,
          startsAt: true,
          firstName: true,
          lastName: true,
          service: { select: { name: true } },
          staff: { select: { name: true, userId: true } },
        },
      }),
    )) as ApptRow[];

    if (!(await claimDigest(`barber-digest:${shopId}:${userId}:${tomorrowKey}`))) continue;
    // A day with nothing on it still gets claimed above (so we stop checking)
    // but says nothing - an empty-day push every night is how a barber learns
    // to swipe notifications away without reading them.
    if (rows.length === 0) continue;

    const first = rows[0]!;
    const last = rows[rows.length - 1]!;
    const count = rows.length;
    const span =
      count === 1
        ? formatApptTime(first.startsAt, tz)
        : `${formatApptTime(first.startsAt, tz)} to ${formatApptTime(last.startsAt, tz)}`;
    await sendToBarber({
      shopId,
      userId,
      kind: "dayAhead",
      prefs,
      message: {
        title: `Tomorrow: ${count} ${count === 1 ? "cut" : "cuts"}`,
        body: `${count} booked, ${span}. First up: ${clientName(first)} - ${first.service.name}.`,
        tag: `day-ahead-${tomorrowKey}`,
      },
    });
    sent++;
  }
  return sent;
}

/**
 * Both reminders for ONE shop. The sweep below is a loop over this, and it's
 * also the entry point tests and any "run it now" action should use - scoping
 * to a shop keeps the blast radius (and the assertion surface) to that shop.
 */
export async function runBarberRemindersForShop(
  shopId: string,
  ownerId: string,
  now = new Date(),
): Promise<number> {
  return (await runNextUp(shopId, ownerId, now)) + (await runDayAhead(shopId, ownerId, now));
}

/**
 * Scheduler entry: run both barber reminders for every shop. Never throws out
 * of one shop's failure - one bad shop must not silence the rest.
 */
export async function runBarberReminders(now = new Date()): Promise<number> {
  const shops = await prisma.shop.findMany({ select: { id: true, ownerId: true } });
  let sent = 0;
  for (const shop of shops) {
    try {
      sent += await runBarberRemindersForShop(shop.id, shop.ownerId, now);
    } catch (err) {
      logger.error({ err, shopId: shop.id }, "barber reminders failed for shop");
    }
  }
  if (sent > 0) logger.info({ sent }, "barber reminders sent");
  return sent;
}
