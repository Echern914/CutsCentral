import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { sendPushToClient } from "../messaging/push.js";

/**
 * The "book your next one?" push, fired ~30 minutes after the chair empties.
 *
 * Thirty minutes is the whole idea: the client is still holding the phone,
 * still looking at the fade in a car mirror, and has not yet gone back to their
 * week. A win-back text three weeks later is a different, colder product (the
 * nudge engine already does that one) - this is the warm moment.
 *
 * 🔴 TWO ROW TYPES, ONE NUDGE. Native bookings are `Appointment`. Shops that
 * kept Acuity/Square have `Visit` rows and NO Appointment row at all, so an
 * engine that reads only Appointment reaches none of them - that was exactly
 * the #212 reminder bug. Both are swept here, and any Visit with a linked
 * `appointment` is SKIPPED, because a completed native booking is promoted into
 * a Visit and would otherwise be nudged twice for one haircut.
 *
 * 🔴 THE FLOOR IS NOT OPTIONAL. The sweep only looks back MAX_AGE_MS. Without
 * it, the deploy that first adds `rebookPromptSentAt` would find every
 * completed appointment in the shop's entire history sitting at `null` and
 * push-notify all of them at once. The floor makes the feature start from
 * "haircuts that just happened" instead of "haircuts, ever".
 *
 * Never nudges a cancellation or a no-show ("hope you loved it" to someone who
 * never sat down), and never nudges a client who already has their next
 * appointment on the books - they did the thing we are asking for.
 *
 * Idempotency mirrors pushReminders.ts: the stamp is CLAIMED atomically
 * (updateMany WHERE null) before the send, so a concurrent run sends nothing
 * twice; a crash between claim and send loses that one push, which is the right
 * trade for a nicety channel. A shop with the toggle OFF is skipped WITHOUT
 * stamping, so flipping it on later still works for anyone still in window.
 *
 * Push only - no SMS, no email, no quiet-hours gate (matches every other push
 * path; a 30-minutes-after-your-4pm push lands at 4:30pm by construction, and
 * shops do not cut hair at 3am).
 */

const MINUTE_MS = 60_000;

/** How long after the appointment ENDS the nudge fires. */
const DELAY_MS = 30 * MINUTE_MS;
/** How far back a single sweep will look. See the floor note in the header. */
const MAX_AGE_MS = 6 * 60 * MINUTE_MS;

interface Candidate {
  kind: "appointment" | "visit";
  id: string;
  shopId: string;
  clientId: string;
  serviceName: string | null;
}

/** Shop slice the nudge needs (owner read - Shop is default-deny in tenant tx). */
interface NudgeShop {
  name: string;
  slug: string | null;
  rebookPushEnabled: boolean;
}

export async function runRebookNudges(now = new Date()): Promise<number> {
  // The window: ended at least DELAY_MS ago, but not more than MAX_AGE_MS ago.
  const until = new Date(now.getTime() - DELAY_MS);
  const since = new Date(now.getTime() - MAX_AGE_MS);

  const [appts, visits] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        // BOOKED or COMPLETED only. CANCELED and NO_SHOW are excluded by
        // construction, and canceledAt guards a row mid-cancellation.
        status: { in: ["BOOKED", "COMPLETED"] },
        canceledAt: null,
        rebookPromptSentAt: null,
        clientId: { not: null },
        endsAt: { gt: since, lte: until },
      },
      select: {
        id: true,
        shopId: true,
        clientId: true,
        service: { select: { name: true } },
      },
      take: 500,
    }),
    prisma.visit.findMany({
      where: {
        status: "COMPLETED",
        noShow: false,
        rebookPromptSentAt: null,
        endAt: { gt: since, lte: until },
        // NEVER a promoted native booking - see the invariant in the header.
        appointment: { is: null },
      },
      select: { id: true, shopId: true, clientId: true, serviceName: true },
      take: 500,
    }),
  ]);

  const candidates: Candidate[] = [
    ...appts.map((a) => ({
      kind: "appointment" as const,
      id: a.id,
      shopId: a.shopId,
      clientId: a.clientId!,
      serviceName: a.service?.name ?? null,
    })),
    ...visits.map((v) => ({
      kind: "visit" as const,
      id: v.id,
      shopId: v.shopId,
      clientId: v.clientId,
      serviceName: v.serviceName,
    })),
  ];
  if (candidates.length === 0) return 0;

  const shopCache = new Map<string, NudgeShop | null>();
  let sent = 0;

  for (const c of candidates) {
    let shop = shopCache.get(c.shopId);
    if (shop === undefined) {
      shop = await prisma.shop.findUnique({
        where: { id: c.shopId },
        select: { name: true, slug: true, rebookPushEnabled: true },
      });
      shopCache.set(c.shopId, shop);
    }
    // Toggle off -> skip WITHOUT stamping (see header).
    if (!shop || !shop.rebookPushEnabled) continue;

    // Already rebooked? Then this nudge is noise. Checked per candidate rather
    // than batched: the set is small, and a client who books during the sweep
    // should still be spared.
    const upcoming = await prisma.appointment.count({
      where: {
        shopId: c.shopId,
        clientId: c.clientId,
        status: { in: ["BOOKED", "PENDING"] },
        startsAt: { gt: now },
      },
    });
    if (upcoming > 0) continue;

    // Atomic claim: only the run that flips null -> now sends.
    const claimed =
      c.kind === "appointment"
        ? await prisma.appointment.updateMany({
            where: { id: c.id, rebookPromptSentAt: null },
            data: { rebookPromptSentAt: now },
          })
        : await prisma.visit.updateMany({
            where: { id: c.id, rebookPromptSentAt: null },
            data: { rebookPromptSentAt: now },
          });
    if (claimed.count === 0) continue;

    // Deep-link to the shop's own booking page when it has a slug; the app
    // handles the rest. No slug (rare, legacy) -> the client's home.
    const base = apiEnv().APP_BASE_URL;
    const url = shop.slug ? `${base}/book/${shop.slug}` : base;
    const res = await sendPushToClient({
      shopId: c.shopId,
      clientId: c.clientId,
      kind: "rebook",
      payload: {
        title: `Thanks for coming in to ${shop.name}`,
        body: c.serviceName
          ? `Want to lock in your next ${c.serviceName}?`
          : "Want to lock in your next visit?",
        url,
        tag: `rebook-${c.id}`,
      },
    });
    if (res.anyDelivered) sent++;
  }

  if (sent > 0) logger.info({ candidates: candidates.length, sent }, "rebook nudges run");
  return sent;
}
