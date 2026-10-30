import type { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import {
  RECORDED_TIP_MAX_CENTS,
  RECORDED_TIP_METHODS,
  RECORDED_TIP_MIN_CENTS,
} from "@chairback/config/tips";
import { logger } from "../logger.js";
import { appointmentOwnedByPlatform } from "../engines/visitOrigin.js";

/**
 * POST /appointments/:id/recorded-tip - the shop records a tip it received
 * OUTSIDE ChairBack's card flow: cash at the chair, or money sent through
 * another app. The appointment sheet's Tip row is its only caller.
 *
 * 🔴 A RECORD, NEVER A CHARGE. Nothing in this module talks to Stripe or
 * touches a `Payment` row - there is no import that could. A card tip is the
 * client's own payment on their appointment page (a `tip` Payment row, see
 * billing/tips.ts); this is the barber writing down money that already
 * changed hands, the same kind of fact as the chair figure at checkout.
 *
 * 🔴 NEVER REVENUE, NEVER TOWARD THE SERVICE. The figure lives in its own
 * columns (`Appointment.recordedTip*`), which no revenue reader, no checkout
 * balance and no payment snapshot reads. It joins the online tip in exactly
 * one place: engines/appointmentPayment.ts `appointmentTipSnapshot`.
 *
 * WHO: the router's rule, the same as the price edit - an owner or manager of
 * THIS shop (requireManager on bookingDashboardRouter). A barber seat gets 403;
 * another shop's appointment does not exist from here (404).
 *
 * THE BODY: integer cents, `amountCents` in [$0.01, $500] with a `method`
 * (cash | other), or `amountCents: null` to take a recorded tip off. Strict:
 * anything else is refused before a row is read.
 *
 * IDEMPOTENT AND COMPARE-AND-SET. `expectedCents` is the recorded tip the
 * sheet was showing (null = none). The write lands only if the row still says
 * that, so two devices editing at once cannot silently overwrite each other.
 * When it does not land, the row is read again: if it already says exactly
 * what this request asks for - the same request sent twice, a double tap, a
 * retry whose first answer was lost - the answer is the same 200, and the tip
 * is recorded once. Anything else is 409 `stale_tip` with the figure that is
 * there now.
 */

/** A tip can be recorded on a booking that is on the books or finished. */
const RECORDABLE_STATUSES = ["BOOKED", "COMPLETED"] as const;
const RECORDABLE_SET: ReadonlySet<string> = new Set(RECORDABLE_STATUSES);

export type RecordedTipRefusal = "external" | "not_tippable";

/**
 * THE ONE RULE for whether a tip may be recorded on this appointment, read by
 * the route below AND by the sheet's detail read (`tips.recordable`), so the
 * Add button is never offered where the route would refuse it.
 *
 *  - another platform's booking (Acuity / Square own it): the price edit's own
 *    refusal, for the same reason - ChairBack does not keep that booking's money.
 *  - a cancelled visit, a no-show, or a hold whose payment never finished: no
 *    visit happened to tip.
 */
export function recordedTipRefusal(appt: {
  status: string;
  visit: { acuityAppointmentId: string } | null;
}): RecordedTipRefusal | null {
  if (appointmentOwnedByPlatform(appt)) return "external";
  if (!RECORDABLE_SET.has(appt.status)) return "not_tippable";
  return null;
}

const cents = z.number().int().min(RECORDED_TIP_MIN_CENTS).max(RECORDED_TIP_MAX_CENTS);
const recordedTipSchema = z.union([
  z
    .object({
      amountCents: cents,
      method: z.enum(RECORDED_TIP_METHODS),
      expectedCents: cents.nullable(),
    })
    .strict(),
  z
    .object({
      amountCents: z.null(),
      expectedCents: cents,
    })
    .strict(),
]);

export function registerRecordedTip(router: Router): void {
  router.post("/appointments/:id/recorded-tip", async (req, res) => {
    const parsed = recordedTipSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    const shopId = req.shop!.id;
    const body = parsed.data;
    const toCents = body.amountCents;
    const toMethod = "method" in body ? body.method : null;

    const appt = await prisma.appointment.findFirst({
      where: { id: req.params.id!, shopId },
      select: {
        id: true,
        status: true,
        visit: { select: { acuityAppointmentId: true } },
        recordedTipCents: true,
        recordedTipMethod: true,
      },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const refusal = recordedTipRefusal(appt);
    if (refusal) {
      res.status(409).json({ error: refusal });
      return;
    }

    // THE WRITE. The status rule and the figure the sheet showed are both in
    // the WHERE, so a cancel or another device's edit landing first wins.
    const { count } = await prisma.appointment.updateMany({
      where: {
        id: appt.id,
        shopId,
        status: { in: [...RECORDABLE_STATUSES] },
        recordedTipCents: body.expectedCents,
      },
      data:
        toCents === null
          ? {
              recordedTipCents: null,
              recordedTipMethod: null,
              recordedTipAt: null,
              recordedTipByUserId: null,
            }
          : {
              recordedTipCents: toCents,
              recordedTipMethod: toMethod,
              recordedTipAt: new Date(),
              recordedTipByUserId: req.userId ?? null,
            },
    });

    if (count === 0) {
      const now = await prisma.appointment.findFirst({
        where: { id: appt.id, shopId },
        select: { status: true, visit: { select: { acuityAppointmentId: true } }, recordedTipCents: true, recordedTipMethod: true },
      });
      if (!now) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // Already exactly what was asked: this request, sent again. Once.
      if (now.recordedTipCents === toCents && now.recordedTipMethod === toMethod) {
        res.json({ ok: true, recordedCents: toCents, recordedMethod: toMethod, unchanged: true });
        return;
      }
      const lateRefusal = recordedTipRefusal(now);
      if (lateRefusal) {
        res.status(409).json({ error: lateRefusal });
        return;
      }
      res.status(409).json({
        error: "stale_tip",
        recordedCents: now.recordedTipCents,
        recordedMethod: now.recordedTipMethod,
      });
      return;
    }

    logger.info(
      {
        shopId,
        appointmentId: appt.id,
        fromCents: appt.recordedTipCents,
        toCents,
        method: toMethod,
      },
      "recorded tip changed",
    );
    res.json({ ok: true, recordedCents: toCents, recordedMethod: toMethod });
  });
}
