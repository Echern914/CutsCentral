import { randomToken } from "@chairback/config";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { inQuietHours } from "../engines/quietHours.js";
import { effectiveDurationForDate } from "../engines/pricing.js";
import { remainingMonthlySms } from "../billing/quota.js";
import {
  lockStaffAndAssertSlotFree,
  SlotTakenError,
} from "../engines/bookingWrite.js";
import { formatApptTime } from "../messaging/templates.js";
import { runAgentTurn } from "./agent.js";
import { renderPromptForShop } from "./prompt.js";
import {
  GAPFILL_HOLD_TTL_MS,
  RECEPTIONIST_TOOLS,
  encodeSlotId,
  makeToolExecutor,
} from "./tools.js";
import { appendMessage, findOrCreateConversation } from "./conversation.js";
import { sendReceptionistSms } from "./outbound.js";

/**
 * PROACTIVE gap-fill: a native appointment was just canceled/no-showed and the
 * freed slot is still bookable - reach out to the RIGHT client with a specific,
 * already-held offer. One candidate, one message, then silence ("one nudge"
 * rule); if they don't take it the hold lapses in 60 minutes and the slot
 * quietly frees itself (the hold sweep never fires slot-opened, so there is no
 * offer->hold->expire->offer loop).
 *
 * Candidate priority (product decision):
 *   1. loyalty/punch-card members due for a rebook by the slot's date
 *   2. anyone overdue by their own cadence
 *   3. waitlist entries matching the slot (earliest joiners first)
 *
 * This is MARKETING outbound on the shared number, so the full rails apply:
 * textability (consent + not opted out + phone), TCPA quiet hours (skip, don't
 * queue), the shop's dailySendCap (kind="receptionist" counts against it), and
 * a per-client 72h receptionist-offer suppression window. DRY_RUN is enforced
 * at the provider level like every send path.
 */

/** Don't re-offer to the same client within this window. */
export const GAPFILL_SUPPRESS_MS = 72 * 60 * 60 * 1000;

export interface GapFillInput {
  shop: {
    id: string;
    name: string;
    timezone: string;
    dailySendCap: number;
    /** The shop's own line (Shop.twilioNumber); null = shared platform number. */
    twilioNumber: string | null;
  };
  appt: {
    id: string; // the just-canceled appointment (its slot is what we offer)
    staffId: string;
    serviceId: string;
    startsAt: Date;
    serviceName: string | null;
    staffName: string | null;
  };
  now?: Date;
}

interface Candidate {
  clientId: string;
  firstName: string | null;
  phone: string;
  reason: "loyalty_due" | "overdue" | "waitlist";
}

/** Textable = the FULL marketing bar (unlike inbound conversational replies). */
const TEXTABLE = {
  archivedAt: null,
  optedOut: false,
  smsConsentAt: { not: null },
  phone: { not: null },
} as const;

async function pickCandidate(input: GapFillInput, now: Date): Promise<Candidate | null> {
  const db = forShop(input.shop.id);

  // Tier 1+2 pool: textable clients with a cadence expectation.
  const clients = await db.client.findMany({
    where: { ...TEXTABLE, nextExpectedAt: { not: null } },
    orderBy: { nextExpectedAt: "asc" }, // most overdue first
    take: 200,
    select: {
      id: true,
      firstName: true,
      phone: true,
      loyaltyTier: true,
      nextExpectedAt: true,
    },
  });

  // Punch balances for the loyalty tier-1 check, one grouped query.
  const sums = await runWithShop(input.shop.id, (tx) =>
    tx.punchLedger.groupBy({
      by: ["clientId"],
      where: { clientId: { in: clients.map((c) => c.id) } },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    }),
  );
  const balances = new Map(
    sums.map((s) => [
      s.clientId,
      (s._sum.punchesEarned ?? 0) - (s._sum.punchesRedeemed ?? 0),
    ]),
  );

  const tier1: Candidate[] = [];
  const tier2: Candidate[] = [];
  for (const c of clients) {
    const isLoyalty = c.loyaltyTier !== null || (balances.get(c.id) ?? 0) > 0;
    const dueBySlot = c.nextExpectedAt!.getTime() <= input.appt.startsAt.getTime();
    const overdueNow = c.nextExpectedAt!.getTime() < now.getTime();
    const cand: Candidate = {
      clientId: c.id,
      firstName: c.firstName,
      phone: c.phone!,
      reason: isLoyalty && dueBySlot ? "loyalty_due" : "overdue",
    };
    if (isLoyalty && dueBySlot) tier1.push(cand);
    else if (overdueNow) tier2.push(cand);
  }

  // Tier 3: waitlist entries matching the freed slot, resolved to textable clients.
  const entries = await db.waitlistEntry.findMany({
    where: {
      status: "WAITING",
      AND: [
        { OR: [{ serviceId: input.appt.serviceId }, { serviceId: null }] },
        { OR: [{ staffId: input.appt.staffId }, { staffId: null }, { staffId: "" }] },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 25,
    select: { phone: true, email: true },
  });
  const tier3: Candidate[] = [];
  for (const e of entries) {
    const or: { phone?: string; email?: string }[] = [];
    if (e.phone) or.push({ phone: e.phone });
    if (e.email) or.push({ email: e.email });
    if (or.length === 0) continue;
    const client = await db.client.findFirst({
      where: { ...TEXTABLE, OR: or },
      select: { id: true, firstName: true, phone: true },
    });
    if (client) {
      tier3.push({
        clientId: client.id,
        firstName: client.firstName,
        phone: client.phone!,
        reason: "waitlist",
      });
    }
  }

  // First candidate (in priority order) that clears the per-client gates.
  const suppressBefore = new Date(now.getTime() - GAPFILL_SUPPRESS_MS);
  const seen = new Set<string>();
  for (const cand of [...tier1, ...tier2, ...tier3]) {
    if (seen.has(cand.clientId)) continue;
    seen.add(cand.clientId);

    // Already coming in? Don't offer them a second chair.
    const upcoming = await runWithShop(input.shop.id, (tx) =>
      tx.appointment.findFirst({
        where: {
          clientId: cand.clientId,
          status: { in: ["BOOKED", "PENDING"] },
          startsAt: { gt: now },
        },
        select: { id: true },
      }),
    );
    if (upcoming) continue;

    // 72h receptionist-offer suppression (proactive kind only - replies don't
    // muzzle offers, and offers don't muzzle replies).
    const recent = await db.nudge.findFirst({
      where: {
        clientId: cand.clientId,
        kind: "receptionist",
        status: { in: ["SENT", "PENDING"] },
        createdAt: { gte: suppressBefore },
      },
      select: { id: true },
    });
    if (recent) continue;

    // Mid-conversation with the AI already? Don't interject an offer.
    const live = await prisma.receptionistConversation.findFirst({
      where: { phone: cand.phone, status: { in: ["active", "escalated"] } },
      select: { id: true },
    });
    if (live) continue;

    return cand;
  }
  return null;
}

/**
 * Offer the freed slot to the best candidate. Never throws - a gap-fill issue
 * must never affect the cancel that triggered it.
 */
export async function runGapFill(input: GapFillInput): Promise<void> {
  const now = input.now ?? new Date();
  const { shop, appt } = input;
  try {
    // TCPA quiet hours: proactive outreach SKIPS (an offer for a same-day slot
    // queued to 8am would usually be stale anyway).
    if (inQuietHours(shop.timezone, now)) {
      logger.info({ shopId: shop.id }, "gap-fill skipped: quiet hours");
      return;
    }

    // Shared daily marketing budget (same counting rule as nudge/winback/promo).
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const sentToday = await forShop(shop.id).nudge.count({
      where: {
        status: "SENT",
        createdAt: { gte: startOfDay },
        kind: { notIn: ["loyalty", "receptionist_reply"] },
        channel: "SMS",
      },
    });
    if (sentToday >= shop.dailySendCap) {
      logger.info({ shopId: shop.id, sentToday }, "gap-fill skipped: daily cap");
      return;
    }

    // Per-tier MONTHLY quota: the proactive offer is marketing-cost outbound
    // (kind="receptionist" counts), so it shares the monthly budget with
    // nudges/win-backs/promos. Infinity while billing is off.
    if ((await remainingMonthlySms(shop.id, now)) <= 0) {
      logger.info({ shopId: shop.id }, "gap-fill skipped: monthly SMS quota");
      return;
    }

    const candidate = await pickCandidate(input, now);
    if (!candidate) {
      logger.info({ shopId: shop.id, appointmentId: appt.id }, "gap-fill: no candidate");
      return;
    }

    // Service duration for the hold's endsAt (the canceled appt may have had
    // add-ons; the OFFER is for the plain service).
    const service = await forShop(shop.id).service.findFirst({
      where: { id: appt.serviceId },
      select: { durationMin: true, durationOverrides: true, price: true },
    });
    if (!service) return;
    const endsAt = new Date(
      appt.startsAt.getTime() +
        effectiveDurationForDate(
          service.durationMin,
          service.durationOverrides,
          appt.startsAt,
          shop.timezone,
        ) *
          60_000,
    );

    // HOLD the slot for the candidate (60 min - a human may take a while to
    // reply) under the same guard as every write. Losing the race here just
    // means the slot got legitimately re-booked - drop the offer.
    let holdId: string;
    try {
      const held = await prisma.$transaction(async (tx) => {
        await lockStaffAndAssertSlotFree(tx, {
          staffId: appt.staffId,
          startsAt: appt.startsAt,
          endsAt,
          bufferMin: 0,
          excludeAppointmentId: appt.id, // the just-canceled row
          now,
        });
        return tx.appointment.create({
          data: {
            shopId: shop.id,
            staffId: appt.staffId,
            serviceId: appt.serviceId,
            clientId: candidate.clientId,
            firstName: candidate.firstName ?? "Client",
            phone: candidate.phone,
            status: "PENDING",
            holdExpiresAt: new Date(now.getTime() + GAPFILL_HOLD_TTL_MS),
            bookedVia: "receptionist",
            startsAt: appt.startsAt,
            endsAt,
            manageToken: randomToken(),
          },
          select: { id: true },
        });
      });
      holdId = held.id;
    } catch (err) {
      if (err instanceof SlotTakenError) {
        logger.info({ shopId: shop.id }, "gap-fill: slot re-booked before offer");
        return;
      }
      throw err;
    }

    const slotId = encodeSlotId(appt.staffId, appt.serviceId, appt.startsAt);
    const when = formatApptTime(appt.startsAt, shop.timezone);

    // Shop-pinned conversation so the reply routes here deterministically.
    const conversation = await findOrCreateConversation({
      shopId: shop.id,
      phone: candidate.phone,
      clientId: candidate.clientId,
    });
    await appendMessage({
      shopId: shop.id,
      conversationId: conversation.id,
      role: "system_note",
      content:
        `gap-fill: a canceled ${appt.serviceName ?? "appointment"} freed ${when}` +
        `${appt.staffName ? ` with ${appt.staffName}` : ""}. A 60-minute hold ` +
        `(slot_id ${slotId}) is already placed for this client - if they accept, ` +
        `call book_appointment with that slot_id; do NOT hold again. Reason ` +
        `they were picked: ${candidate.reason}.`,
    });

    // Let the MODEL compose the offer in the shop's voice (catalog #10) - one
    // short message. Tools are available but the slot is already held.
    const system = await renderPromptForShop(shop.id);
    if (!system) {
      await releaseHold(holdId);
      return;
    }
    const outcome = await runAgentTurn({
      system,
      messages: [
        {
          role: "user",
          content:
            `[instruction - not from the client] It's ${when} territory: a ` +
            `${appt.serviceName ?? "appointment"} slot at ${when}` +
            `${appt.staffName ? ` with ${appt.staffName}` : ""} just opened up. ` +
            `Compose the ONE short gap-fill offer text to ` +
            `${candidate.firstName ?? "this client"} (picked because: ${candidate.reason}). ` +
            `The slot is ALREADY held for them - don't call hold_slot or ` +
            `book_appointment now; just write the offer per your GAP FILL example. ` +
            `One message, one nudge, no follow-up.`,
        },
      ],
      tools: RECEPTIONIST_TOOLS,
      executeTool: makeToolExecutor({
        shopId: shop.id,
        conversationId: conversation.id,
        phone: candidate.phone,
        clientId: candidate.clientId,
        now,
      }),
    });

    if (outcome.kind !== "reply") {
      logger.warn(
        { shopId: shop.id, reason: outcome.reason },
        "gap-fill: model turn failed; releasing hold",
      );
      await releaseHold(holdId);
      return;
    }

    const sent = await sendReceptionistSms({
      shopId: shop.id,
      clientId: candidate.clientId,
      phone: candidate.phone,
      body: outcome.text,
      kind: "receptionist",
      from: shop.twilioNumber,
    });
    if (!sent) {
      await releaseHold(holdId);
      return;
    }
    await appendMessage({
      shopId: shop.id,
      conversationId: conversation.id,
      role: "assistant",
      content: outcome.text,
      toolCalls: outcome.toolCalls,
    });
    logger.info(
      { shopId: shop.id, clientId: candidate.clientId, reason: candidate.reason },
      "gap-fill offer sent",
    );
  } catch (err) {
    logger.error({ err, shopId: shop.id, appointmentId: appt.id }, "runGapFill failed");
  }
}

/** Drop an offer's hold immediately (light flip, same as the expiry sweep). */
async function releaseHold(holdId: string): Promise<void> {
  await prisma.appointment
    .updateMany({
      where: { id: holdId, status: "PENDING" },
      data: { status: "CANCELED", canceledAt: new Date() },
    })
    .catch(() => {});
}
