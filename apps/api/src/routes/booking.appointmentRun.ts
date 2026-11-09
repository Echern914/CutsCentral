import type { Router } from "express";
import { z } from "zod";
import { Prisma, prisma } from "@chairback/db";
import { cancellationTermsSnapshot, randomToken } from "@chairback/config";
import { deriveAcuityClientKey, toE164 } from "../acuity/clientKey.js";
import { attachClientSavedCard } from "../billing/savedCard.js";
import {
  dispatchCreateEach,
  mirrorOutcomeOfRows,
  recordMirrorIntent,
  type DispatchOutcome,
} from "../engines/acuityMirror.js";
import {
  dashRunKey,
  groupExtraDurationMin,
  MAX_DASH_RUN,
  MIN_DASH_RUN,
  planGroupSequence,
  type GroupPlan,
  type GroupPlanService,
} from "../engines/appointmentGroup.js";
import { compensateGroup, sendGroupConfirmationOnce } from "../engines/appointmentGroupSettle.js";
import { lockStaffAndAssertSlotFree, occupiesSameTime } from "../engines/bookingWrite.js";
import { computeOpenSlots, isSlotBookable } from "../engines/slots.js";
import { logger } from "../logger.js";
import { notifyClientBookedByShop } from "../services/appointmentNotify.js";
import { blockedTimeIsTheOnlyObstacle, recordExternalBlockOverrides } from "../services/appointmentOverride.js";
import { fillBlankClientFieldsFromShop } from "../services/clientFill.js";
import { answerBookingRefusal } from "./booking.refusal.js";

/**
 * A BACK-TO-BACK RUN: New appointment's `- 1 +`.
 *
 * A live shop, 2026-11: "It takes me a minute to add 3 services back to back."
 * Four of one service from 3:00 blocks 3:00 to its end plus one buffer, and the
 * times after that stay open.
 *
 * Stored as a party (engines/appointmentGroup.ts), because a party already is
 * this: real appointments with no gaps, one overlap guard over the whole span,
 * the buffer only on the outside, one confirmation, one Acuity block per
 * member, and no partial success.
 *
 * Deliberately NOT createAppointmentCore in a loop. Separate writes could land
 * two of four and leave the barber to find out which, each would ask about the
 * previous one's buffer, and the client would get four emails.
 *
 * A run is a plain booking in everything else: no special, offer, add-on,
 * typed price or repeat. Each of those is priced for one visit, and the form
 * clears them when the count goes above 1.
 */

const runSchema = z
  .object({
    staffId: z.string().min(1),
    serviceId: z.string().min(1),
    startsAt: z.coerce.date(),
    count: z.number().int().min(MIN_DASH_RUN).max(MAX_DASH_RUN),
    clientId: z.string().min(1).optional(),
    firstName: z.string().trim().max(80).optional().or(z.literal("")),
    lastName: z.string().trim().max(80).optional().or(z.literal("")),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    note: z.string().trim().max(1000).optional().or(z.literal("")),
    customTime: z.boolean().optional(),
    externalBlockConfirmation: z.string().trim().min(1).max(200).optional(),
    overlapConfirmation: z.string().trim().min(1).max(200).optional(),
    notifyClient: z.boolean().optional(),
    /**
     * 🔴 REQUIRED, unlike a single booking's. A lost answer retried without one
     * books the whole run a second time, on top of itself.
     */
    operationId: z.string().trim().min(8).max(100),
  })
  .strict()
  .refine((d) => Boolean(d.clientId) || Boolean(d.firstName?.trim()), {
    message: "Pick a client or enter a name.",
    path: ["clientId"],
  });

type RunService = GroupPlanService & { name: string };

const RUN_SERVICE_SELECT = {
  id: true,
  name: true,
  durationMin: true,
  price: true,
  durationOverrides: true,
  priceOverrides: true,
  dateOverrides: true,
  timeOverrides: true,
} as const;

/**
 * The run laid out from one start. Each member's length and price are resolved
 * at its OWN start, so a run crossing a time window is priced as it sits.
 */
function planRun(service: RunService, count: number, startsAt: Date, timezone: string): GroupPlan {
  return planGroupSequence({
    // The name is the client's, resolved in the transaction. It plays no part
    // in the times or the price.
    attendees: Array.from({ length: count }, () => ({ firstName: "Client", serviceId: service.id })),
    startsAt,
    timezone,
    services: new Map([[service.id, service]]),
    maxAttendees: MAX_DASH_RUN,
  });
}

/**
 * 🔴 THE GRID MUST MATCH THE WRITER. Every time offered for a run of N is one
 * POST /appointments/run accepts: the same engine, asked for the same room. The
 * room is sized from one plan and re-checked at each candidate, because a
 * service can be shorter on one day than another.
 */
export async function dashRunOpenSlots(input: {
  shopId: string;
  staffId: string;
  serviceId: string;
  count: number;
  from: Date;
  to: Date;
  timezone: string;
  now: Date;
}): Promise<Array<{ startsAt: Date; endsAt: Date }>> {
  const service = await prisma.service.findFirst({
    where: { id: input.serviceId, shopId: input.shopId, active: true },
    select: RUN_SERVICE_SELECT,
  });
  if (!service) return [];
  const sized = planRun(service, input.count, input.from, input.timezone);
  const candidates = await computeOpenSlots({
    shopId: input.shopId,
    staffId: input.staffId,
    serviceId: input.serviceId,
    fromDate: input.from,
    toDate: input.to,
    now: input.now,
    extraDurationMin: groupExtraDurationMin(sized),
  });
  const slots: Array<{ startsAt: Date; endsAt: Date }> = [];
  for (const slot of candidates) {
    const at = planRun(service, input.count, slot.startsAt, input.timezone);
    const roomMin = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000;
    if (at.totalDurationMin > roomMin) continue;
    slots.push({ startsAt: at.startsAt, endsAt: at.endsAt });
  }
  return slots;
}

/** A first copy's refused run may still be mid-undo for this long. */
const UNDO_SETTLE_MS = 2 * 60_000;

interface RunRes {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Answer a retried run from what its first copy left: the SAVED run, never the
 * screen's idea of it. Same four answers as a single booking's replay. True
 * when it answered; false when nothing carries this id.
 */
async function answerRunReplay(
  res: RunRes,
  shopId: string,
  d: z.infer<typeof runSchema>,
  now: Date,
): Promise<boolean> {
  const group = await prisma.appointmentGroup.findFirst({
    where: { shopId, idempotencyKey: dashRunKey(shopId, d.operationId) },
    select: {
      id: true,
      status: true,
      staffId: true,
      clientId: true,
      firstName: true,
      mirrorPendingSince: true,
      appointments: {
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          status: true,
          serviceId: true,
          startsAt: true,
          endsAt: true,
          overlapForcedAt: true,
          outboundBlocks: { select: { state: true, updatedAt: true } },
        },
      },
    },
  });
  if (!group) return false;
  const live = group.appointments.filter((a) => a.status !== "CANCELED" && a.status !== "NO_SHOW");
  const first = group.appointments[0];
  if (group.status === "CANCELED" || live.length === 0 || !first) {
    res.status(409).json({
      error: "replay_not_booked",
      reason: "That booking didn't go through, or was cancelled since. Check the calendar before booking again.",
    });
    return true;
  }
  const booked = {
    id: live[0]!.id,
    startsAt: live[0]!.startsAt.toISOString(),
    endsAt: live[live.length - 1]!.endsAt.toISOString(),
    staffId: group.staffId,
    serviceId: first.serviceId,
  };
  const sameClient = d.clientId
    ? group.clientId === d.clientId
    : group.firstName.trim().toLowerCase() === (d.firstName ?? "").trim().toLowerCase();
  const sameSubmission =
    group.staffId === d.staffId &&
    first.serviceId === d.serviceId &&
    first.startsAt.getTime() === d.startsAt.getTime() &&
    group.appointments.length === d.count &&
    sameClient;
  if (!sameSubmission) {
    res.status(409).json({
      error: "operation_mismatch",
      reason:
        "Your earlier tap already booked a different time or service. Nothing new was booked - check that " +
        "booking before booking again.",
      booked,
    });
    return true;
  }
  const blocks = group.appointments
    .flatMap((a) => a.outboundBlocks)
    .filter((b) => b.state !== "RELEASING" && b.state !== "RELEASED");
  const settling =
    group.mirrorPendingSince !== null ||
    blocks.some(
      (b) =>
        b.state === "PENDING" ||
        (b.state === "FAILED" && now.getTime() - b.updatedAt.getTime() < UNDO_SETTLE_MS),
    );
  if (settling) {
    res.status(409).json({
      error: "operation_in_progress",
      reason: "That booking is still being confirmed with your calendar. Check the calendar in a moment before trying again.",
      booked,
    });
    return true;
  }
  res.status(200).json({
    ok: true,
    id: booked.id,
    groupId: group.id,
    startsAt: booked.startsAt,
    endsAt: booked.endsAt,
    run: { count: group.appointments.length },
    replayed: true,
    mirror: mirrorOutcomeOfRows(blocks),
    ...(group.appointments.some((a) => a.overlapForcedAt) ? { forced: true } : {}),
  });
  return true;
}

/**
 * Take back a run Acuity refused: every member, and the specials that came off
 * sale for it. Nobody was told about it, so nothing is sent. False means it
 * SURVIVES, and the caller must say so rather than "not booked".
 */
async function undoRefusedRun(input: {
  shopId: string;
  groupId: string;
  specialsTakenOffSale: string[];
  now: Date;
}): Promise<boolean> {
  const { shopId, groupId, now } = input;
  try {
    await compensateGroup(shopId, groupId, now);
  } catch (err) {
    logger.error({ err, shopId, groupId }, "acuity mirror: undo of a refused run FAILED - it survives unmirrored");
    return false;
  }
  // The barber is told it wasn't booked, so it must not sit on the calendar as
  // cancelled cards, and what it took goes back on sale. Neither may turn "not
  // booked" into an error: the run is already gone.
  await prisma.appointment
    .updateMany({ where: { groupId, shopId }, data: { dismissedAt: now } })
    .catch((err: unknown) => logger.warn({ err, shopId, groupId }, "refused run's cards not dismissed"));
  if (input.specialsTakenOffSale.length > 0) {
    await prisma.targetedSlot
      .updateMany({
        where: { id: { in: input.specialsTakenOffSale }, shopId, bookedAppointmentId: null, active: false },
        data: { active: true },
      })
      .catch((err: unknown) => logger.warn({ err, shopId, groupId }, "specials not put back after a refused run"));
  }
  return true;
}

export function registerAppointmentRun(router: Router, invalidateAvailability: (shopId: string) => unknown): void {
  router.post("/appointments/run", async (req, res) => {
    const now = new Date();
    const parsed = runSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const shopId = req.shop!.id;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        bookingMode: true,
        timezone: true,
        bookingBufferMin: true,
        cancelWindowHours: true,
        cancelFeeBps: true,
        chargeCardOnFileFees: true,
        cardFeeFlatCents: true,
      },
    });
    if (!shop) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (shop.bookingMode !== "native") {
      res.status(400).json({ error: "not_native" });
      return;
    }
    // Before any slot rule: by now a first copy's run occupies this very time.
    if (await answerRunReplay(res, shopId, d, now)) return;

    const service = await prisma.service.findFirst({
      where: { id: d.serviceId, shopId, active: true },
      select: RUN_SERVICE_SELECT,
    });
    const offering = await prisma.serviceStaff.findFirst({
      where: { shopId, serviceId: d.serviceId, staffId: d.staffId },
      select: { id: true },
    });
    const staff = await prisma.staff.findFirst({
      where: { id: d.staffId, shopId, active: true },
      select: { id: true },
    });
    if (!service || !offering || !staff) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }

    const plan = planRun(service, d.count, d.startsAt, shop.timezone);
    const extraDurationMin = groupExtraDurationMin(plan);
    // Same gate as a single booking, asked about the whole run. Custom time is
    // the barber's hand; the overlap guard below applies either way.
    if (
      !d.customTime &&
      !(await isSlotBookable({
        shopId,
        staffId: d.staffId,
        serviceId: d.serviceId,
        startsAt: d.startsAt,
        extraDurationMin,
      })) &&
      !(await blockedTimeIsTheOnlyObstacle({
        shopId,
        staffId: d.staffId,
        serviceId: d.serviceId,
        startsAt: d.startsAt,
        extraDurationMin,
      }))
    ) {
      res.status(400).json({ error: "invalid_slot" });
      return;
    }

    const phone = toE164(d.phone);
    if (d.phone?.trim() && !phone) {
      res.status(400).json({ error: "invalid_phone" });
      return;
    }

    // Nothing is announced when the barber unticked it, or for a run entered
    // after the fact. Marked up front, so the settlement sweep cannot send it
    // later on an ambiguous Acuity answer.
    const quiet = d.notifyClient === false || plan.startsAt.getTime() <= now.getTime();

    try {
      const created = await prisma.$transaction(
        async (tx) => {
          // 🔴 ONE GUARD OVER THE WHOLE SPAN, so the buffer pads only the
          // outside of the run: its own members never ask about each other.
          const guard = await lockStaffAndAssertSlotFree(tx, {
            externalBlocks: "enforce",
            externalBlockConfirmation: d.externalBlockConfirmation ?? null,
            walkInCapacity: "ignore",
            nativeBlocks: "ignore",
            staffId: d.staffId,
            shopId,
            startsAt: plan.startsAt,
            endsAt: plan.endsAt,
            bufferMin: shop.bookingBufferMin,
            bookedServiceId: null,
            serviceDayLimit: null,
            overrideWaitlistHolds: true,
            overlapConfirmation: d.overlapConfirmation ?? null,
          });

          let clientId = d.clientId ?? null;
          let cFirst = d.firstName?.trim() || "";
          let cLast = d.lastName?.trim() || null;
          if (clientId) {
            const existing = await tx.client.findFirst({
              where: { id: clientId, shopId },
              select: { id: true, firstName: true, lastName: true },
            });
            if (!existing) throw new Error("client_not_found");
            cFirst = existing.firstName ?? cFirst;
            cLast = existing.lastName ?? cLast;
          } else {
            const acuityClientKey = deriveAcuityClientKey({
              phone: d.phone,
              email: d.email,
              firstName: cFirst,
              lastName: cLast ?? undefined,
            });
            const client = await tx.client.upsert({
              where: { shopId_acuityClientKey: { shopId, acuityClientKey } },
              create: {
                shopId,
                acuityClientKey,
                magicToken: randomToken(),
                firstName: cFirst,
                lastName: cLast,
                phone,
                email: d.email || null,
                source: "manual",
              },
              // 🔴 Never rename whoever already holds this number: a phone is
              // not a person (services/clientFill.ts). Blanks fill, and the
              // booking rows keep what was typed.
              update: {},
              select: { id: true },
            });
            await fillBlankClientFieldsFromShop(tx, client.id, {
              firstName: cFirst,
              lastName: cLast,
              phone,
              email: d.email,
            });
            clientId = client.id;
          }

          const group = await tx.appointmentGroup.create({
            data: {
              shopId,
              staffId: d.staffId,
              clientId,
              firstName: cFirst || "Client",
              lastName: cLast,
              phone,
              email: d.email || null,
              manageToken: randomToken(),
              idempotencyKey: dashRunKey(shopId, d.operationId),
              ...(quiet ? { confirmationEnqueuedAt: now } : {}),
            },
            select: { id: true },
          });

          const appointmentIds: string[] = [];
          const outboxIds: string[] = [];
          let forced = false;
          for (const m of plan.members) {
            // Only a member that really shares time with what was crossed is a
            // double. The rest of the run is clear, and stays untagged.
            const trueDouble = occupiesSameTime(
              { startsAt: m.startsAt, endsAt: m.endsAt },
              guard.overlapsCrossedSpans ?? [],
            );
            forced = forced || trueDouble;
            const appt = await tx.appointment.create({
              data: {
                shopId,
                staffId: d.staffId,
                serviceId: d.serviceId,
                clientId,
                firstName: cFirst || "Client",
                lastName: cLast,
                phone,
                email: d.email || null,
                status: "BOOKED",
                startsAt: m.startsAt,
                endsAt: m.endsAt,
                priceAtBooking: m.priceCents === null ? undefined : new Prisma.Decimal(m.priceCents / 100),
                // Private to the shop. On every member, so it shows on whichever
                // card the barber opens.
                notes: d.note || null,
                manageToken: randomToken(),
                groupId: group.id,
                groupPosition: m.position,
                ...cancellationTermsSnapshot(shop),
                ...(trueDouble ? { overlapForcedAt: now, overlapForcedByUserId: req.userId ?? null } : {}),
              },
              select: { id: true },
            });
            appointmentIds.push(appt.id);
            outboxIds.push(
              ...(await recordMirrorIntent(tx, {
                shopId,
                now,
                appointmentId: appt.id,
                staffId: d.staffId,
                startsAt: m.startsAt,
                endsAt: m.endsAt,
                occupancy: {
                  status: "BOOKED",
                  startsAt: m.startsAt,
                  endsAt: m.endsAt,
                  holdExpiresAt: null,
                  visitId: null,
                },
              })),
            );
          }
          await recordExternalBlockOverrides(tx, {
            shopId,
            appointmentId: appointmentIds[0]!,
            staffId: d.staffId,
            actorUserId: req.userId ?? null,
            source: "dashboard_create",
            blocks: guard.externalBlocksCrossed,
          });
          return {
            groupId: group.id,
            appointmentIds,
            outboxIds,
            clientId,
            forced,
            specialsTakenOffSale: guard.overlapsCrossed?.targetedIds ?? [],
          };
        },
        // Three writes a member, up to ten members, under the barber's lock.
        { timeout: 20_000 },
      );

      const firstId = created.appointmentIds[0]!;
      const saved = {
        id: firstId,
        groupId: created.groupId,
        startsAt: plan.startsAt.toISOString(),
        endsAt: plan.endsAt.toISOString(),
        run: { count: created.appointmentIds.length },
        ...(created.forced ? { forced: true } : {}),
      };

      // 🔴 PER-MEMBER OUTCOMES, AND UNKNOWN OUTRANKS FAILED. An unknown block may
      // exist in Acuity, so undoing on the failed one alone would orphan it (see
      // booking.group.ts). A throw here is an unknown too: the rows are saved.
      let outcomes: DispatchOutcome[];
      try {
        outcomes = await dispatchCreateEach(created.outboxIds);
      } catch (err) {
        logger.error({ err, shopId, groupId: created.groupId }, "acuity mirror: dispatch of a run threw");
        outcomes = ["unknown"];
      }
      if (outcomes.includes("unknown")) {
        await prisma.appointmentGroup.updateMany({
          where: { id: created.groupId, shopId },
          data: { mirrorPendingSince: now },
        });
        res.status(201).json({ ok: true, ...saved, mirror: "unknown" });
        return;
      }
      if (outcomes.includes("failed")) {
        const undone = await undoRefusedRun({
          shopId,
          groupId: created.groupId,
          specialsTakenOffSale: created.specialsTakenOffSale,
          now,
        });
        if (undone) {
          await invalidateAvailability(shopId);
          res.status(409).json({
            error: "acuity_refused",
            reason:
              "Acuity wouldn't block these times on your calendar, so none of them were booked - booking them here would leave them for sale on your Acuity page. Check what's on Acuity at that time, then try again or pick another time.",
          });
          return;
        }
        res.status(201).json({ ok: true, ...saved, mirror: "failed" });
        return;
      }

      // The client saved a card here: every member carries it, so a no-show on
      // any of them is covered like one they booked themselves.
      for (const appointmentId of created.appointmentIds) {
        await attachClientSavedCard({ shopId, appointmentId, clientId: created.clientId }).catch((err: unknown) =>
          logger.warn({ err, shopId, appointmentId }, "saved card not attached to a run member"),
        );
      }
      if (!quiet) {
        // 🔴 ONE CONFIRMATION FOR THE WHOLE RUN, through the durable outbox a
        // party's goes through, listing every time. The push names the first
        // and counts the rest.
        await sendGroupConfirmationOnce(shopId, created.groupId, now).catch((err: unknown) =>
          logger.error({ err, shopId, groupId: created.groupId }, "run confirmation not enqueued"),
        );
        void notifyClientBookedByShop({
          shopId,
          appointmentId: firstId,
          now,
          moreVisits: created.appointmentIds.length - 1,
          pushOnly: true,
        });
      }
      res.status(201).json({
        ok: true,
        ...saved,
        mirror: outcomes.includes("active") ? "active" : outcomes.includes("observed") ? "observed" : "skipped",
      });
    } catch (err) {
      // 🔴 THE RACE THE READ ABOVE CANNOT WIN. Two copies of one submission both
      // found nothing; the loser waits on the barber's lock and is refused by
      // the guard, naming its own first copy as the conflict. If this
      // submission's run exists, that run is the answer.
      if (await answerRunReplay(res, shopId, d, now)) return;
      if (
        await answerBookingRefusal(res, err, {
          shopId,
          timezone: shop.timezone,
          overlapConfirmation: d.overlapConfirmation,
        })
      ) {
        return;
      }
      logger.error({ err, shopId }, "dashboard run create failed");
      res.status(500).json({ error: "create_failed" });
    }
  });
}
