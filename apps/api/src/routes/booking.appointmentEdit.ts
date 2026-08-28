import type { Router } from "express";
import { z } from "zod";
import { Prisma, forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { isSlotBookable } from "../engines/slots.js";
import { lockStaffAndAssertSlotFree, SlotTakenError } from "../engines/bookingWrite.js";
import { completeReschedule, swapForReschedule } from "../engines/acuityMirror.js";
import { toE164 } from "../acuity/clientKey.js";
import { editClient } from "../services/client.js";

/**
 * EDIT AN APPOINTMENT. One endpoint, every editable field.
 *
 * Reuses the SAME machinery as creating one - `isSlotBookable` for the
 * hours/exception/bounds gate and `lockStaffAndAssertSlotFree` for the
 * advisory lock and overlap re-check - so an edit can never become a second,
 * weaker scheduling engine that drifts from the first.
 *
 * Four rules that are not obvious:
 *
 *  1. STATUS IS PRESERVED. Editing a PENDING request leaves it PENDING. A
 *     barber fixing a typo on a request must never silently accept it -
 *     approving is its own deliberate action with its own confirmation send.
 *
 *  2. ONLY THIS APPOINTMENT'S OWN ROW is excluded from the overlap test, so it
 *     cannot conflict with itself while every other booking, hold, targeted
 *     slot, blocked window and synced Acuity visit still blocks it.
 *
 *  3. A MOVE IS ACUITY-SAFE. The replacement block is created BEFORE the old
 *     one is released, and if the replacement fails or is ambiguous the OLD
 *     block is RETAINED (see completeReschedule). The response carries the
 *     mirror outcome so the UI can say so honestly rather than implying a
 *     clean move.
 *
 *  4. MONEY NEVER MOVES HERE. A price change on an already-paid booking is
 *     refused, not reconciled. Refunding or collecting a difference is a
 *     separate, deliberate action by a human.
 *
 *  5. FIXING A PHONE NUMBER GRANTS NO CONSENT. A corrected number reaches the
 *     CLIENT record too (that is the SMS channel of record - see below), and
 *     it does so through `editClient`, whose entire contract is "contact
 *     fields only, never `smsConsentAt` / `smsConsentSource` / `optedOut` and
 *     never `acuityClientKey`". A barber typing a number must never be able to
 *     manufacture permission to text it.
 *
 * Imported bookings are refused outright: a Visit-linked row is owned by
 * Acuity, and editing it here would desynchronize the two systems with no
 * outbound appointment API to push the change back.
 */

const editApptSchema = z
  .object({
    clientId: z.string().min(1).nullable().optional(),
    serviceId: z.string().min(1).optional(),
    staffId: z.string().min(1).optional(),
    startsAt: z.string().min(1).optional(),
    /** Overrides the service duration for THIS booking only. */
    durationMin: z.number().int().min(5).max(600).optional(),
    price: z.number().min(0).max(100000).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().max(80).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    email: z.string().max(200).nullable().optional(),
    /** Barber override: skip the hours/blocked gate. Overlap still applies. */
    customTime: z.boolean().optional(),
  })
  .strict();

export function registerAppointmentEdit(
  router: Router,
  invalidateAvailability: (shopId: string) => void,
): void {
  /**
   * Everything the edit sheet prefills from, in ONE round trip: the shop's
   * timezone (a wall-clock edit is meaningless without it), the active service
   * and staff lists, and the client book for the explicit change-client
   * search. Capped, and carrying only what the picker renders - no emails, no
   * notes, no loyalty state.
   */
  router.get("/appointments/edit-context", async (req, res) => {
    const shopId = req.shop!.id;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { timezone: true },
    });
    const [services, staff, clients] = await Promise.all([
      forShop(shopId).service.findMany({
        where: { shopId, active: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, name: true, durationMin: true },
      }),
      forShop(shopId).staff.findMany({
        where: { shopId, active: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, name: true },
      }),
      forShop(shopId).client.findMany({
        where: { shopId },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: { id: true, firstName: true, lastName: true, phone: true },
      }),
    ]);
    res.json({
      timezone: shop?.timezone ?? "America/New_York",
      services,
      staff,
      clients: clients.map((c) => ({
        id: c.id,
        name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Client",
        phone: c.phone,
      })),
    });
  });

  router.patch("/appointments/:id", async (req, res) => {
    // One clock for the whole request - see the note on MirrorIntentInput.now.
    const now = new Date();
    const shopId = req.shop!.id;
    const parsed = editApptSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { bookingBufferMin: true, timezone: true },
    });
    if (!shop) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const appt = await forShop(shopId).appointment.findFirst({
      where: { id: req.params.id!, shopId },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        status: true,
        startsAt: true,
        endsAt: true,
        visitId: true,
        clientId: true,
      },
    });
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Owned by Acuity. A local edit would make the two systems disagree about
    // the authoritative time, with no way to push the change back.
    if (appt.visitId) {
      res.status(409).json({ error: "synced_appointment_readonly" });
      return;
    }
    if (appt.status !== "BOOKED" && appt.status !== "PENDING") {
      res.status(409).json({ error: "not_editable" });
      return;
    }

    const staffId = d.staffId ?? appt.staffId;
    const serviceId = d.serviceId ?? appt.serviceId;

    // Both must belong to THIS shop - the ids arrive from a client form.
    const [staff, service] = await Promise.all([
      forShop(shopId).staff.findFirst({
        where: { id: staffId, shopId },
        select: { id: true },
      }),
      forShop(shopId).service.findFirst({
        where: { id: serviceId, shopId },
        select: { id: true, durationMin: true },
      }),
    ]);
    if (!staff) {
      res.status(404).json({ error: "staff_not_found" });
      return;
    }
    if (!service) {
      res.status(404).json({ error: "service_not_found" });
      return;
    }
    // Changing the client is explicit and shop-scoped: a cross-tenant id must
    // never attach, and it is never inferred from a name the barber typed.
    if (d.clientId) {
      const client = await forShop(shopId).client.findFirst({
        where: { id: d.clientId, shopId },
        select: { id: true },
      });
      if (!client) {
        res.status(404).json({ error: "client_not_found" });
        return;
      }
    }

    // A supplied phone must parse to E.164 or the edit is REFUSED - the same
    // rule the client profile editor uses. Silently storing an unparseable
    // number would leave the barber looking at a Call button that can never
    // dial, which is worse than telling them the number is wrong. An explicit
    // empty string / null still clears the field.
    let normalizedPhone: string | null | undefined = d.phone;
    if (d.phone !== undefined) {
      const raw = (d.phone ?? "").trim();
      if (raw === "") {
        normalizedPhone = null;
      } else {
        const e164 = toE164(raw);
        if (!e164) {
          res.status(400).json({ error: "invalid_phone" });
          return;
        }
        normalizedPhone = e164;
      }
    }
    const normalizedEmail =
      d.email === undefined ? undefined : ((d.email ?? "").trim().toLowerCase() || null);

    const startsAt = d.startsAt ? new Date(d.startsAt) : appt.startsAt;
    if (Number.isNaN(startsAt.getTime())) {
      res.status(400).json({ error: "invalid_input" });
      return;
    }
    // An explicit duration wins. Otherwise a service change adopts the new
    // service's length, and everything else preserves the booking's CURRENT
    // length - a barber who stretched this cut to 45 minutes must not have it
    // silently snap back when they only fix a phone number.
    const currentMin = Math.round(
      (appt.endsAt.getTime() - appt.startsAt.getTime()) / 60_000,
    );
    const durationMin =
      d.durationMin ?? (d.serviceId ? service.durationMin : currentMin);
    const endsAt = new Date(startsAt.getTime() + durationMin * 60_000);

    const timeMoved =
      startsAt.getTime() !== appt.startsAt.getTime() ||
      endsAt.getTime() !== appt.endsAt.getTime() ||
      staffId !== appt.staffId;

    // Money never moves as a side effect of an edit. Read separately: the
    // forShop() tenant wrapper erases nested-relation types.
    const payment = await prisma.payment.findFirst({
      where: { appointmentId: appt.id, shopId },
      select: { status: true, amount: true },
    });
    if (
      payment?.status === "succeeded" &&
      d.price !== undefined &&
      d.price !== null &&
      Math.round(d.price * 100) !== payment.amount
    ) {
      res.status(409).json({
        error: "price_change_on_paid",
        message:
          "This booking is already paid. Refund or take the difference in person, then change the price.",
      });
      return;
    }

    // The same availability gate the create path uses, unless the barber
    // deliberately overrides it ("come in at 7, I'll stay late").
    if (timeMoved && !d.customTime) {
      const bookable = await isSlotBookable({
        shopId,
        staffId,
        serviceId,
        startsAt,
        excludeAppointmentId: appt.id,
        extraDurationMin: Math.max(0, durationMin - service.durationMin),
      });
      if (!bookable) {
        res.status(400).json({ error: "invalid_slot" });
        return;
      }
    }

    let mirrorOutboxId: string | null = null;
    try {
      await runWithShop(shopId, async (tx) => {
        if (timeMoved) {
          await lockStaffAndAssertSlotFree(tx, {
            walkInCapacity: "ignore",
            staffId,
            shopId,
            startsAt,
            endsAt,
            bufferMin: shop.bookingBufferMin,
            // Only THIS row is excluded; everything else still blocks.
            excludeAppointmentId: appt.id,
            // Approve-path parity: our own row is the PENDING one, and any
            // conflicting PENDING already failed its own create guard.
            statuses: appt.status === "PENDING" ? ["BOOKED"] : ["BOOKED", "PENDING"],
            // A barber editing their own calendar overrides their own cap.
            serviceDayLimit: null,
            overrideWaitlistHolds: true,
          });
        }
        await tx.appointment.update({
          where: { id: appt.id },
          data: {
            staffId,
            serviceId,
            startsAt,
            endsAt,
            // STATUS UNTOUCHED on purpose - a PENDING request stays a request.
            ...(d.clientId !== undefined ? { clientId: d.clientId } : {}),
            ...(d.firstName !== undefined ? { firstName: d.firstName } : {}),
            ...(d.lastName !== undefined ? { lastName: d.lastName } : {}),
            ...(normalizedPhone !== undefined ? { phone: normalizedPhone } : {}),
            ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
            ...(d.price !== undefined
              ? {
                  priceAtBooking:
                    d.price === null ? null : new Prisma.Decimal(d.price.toFixed(2)),
                }
              : {}),
            ...(d.notes !== undefined ? { notes: d.notes } : {}),
            // Send-state resets only when the TIME actually moved: fixing a
            // spelling must not re-text the customer a fresh confirmation.
            ...(timeMoved
              ? {
                  confirmationSentAt: null,
                  reminderSentAt: null,
                  reminder24hPushSentAt: null,
                  reminder2hPushSentAt: null,
                  checkInStatus: null,
                  checkedInAt: null,
                  etaMinutes: null,
                  runningLate: false,
                }
              : {}),
          },
        });
        if (timeMoved) {
          mirrorOutboxId = await swapForReschedule(tx, {
            shopId,
            now,
            appointmentId: appt.id,
            staffId,
            startsAt,
            endsAt,
            occupancy: {
              status: appt.status,
              startsAt,
              endsAt,
              holdExpiresAt: null,
              visitId: null,
            },
          });
        }
      });
    } catch (err) {
      if (
        err instanceof SlotTakenError ||
        (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
      ) {
        res.status(409).json({ error: "slot_taken" });
        return;
      }
      logger.error({ err, shopId, appointmentId: appt.id }, "appointment edit failed");
      res.status(500).json({ error: "edit_failed" });
      return;
    }

    // 🔴 CARRY THE CORRECTED CONTACT ONTO THE CLIENT RECORD.
    //
    // The appointment's own phone/email are a snapshot of what the booker
    // typed. The CLIENT row is the channel of record: `appointmentNotify` texts
    // `client.phone`, and the rewards page, nudges and every marketing send
    // read the client too. Writing only the appointment would leave a barber
    // who just fixed a typo'd number watching reminders keep going to the old
    // one - the correction would look applied and do nothing.
    //
    // Routed through `editClient` rather than a direct update precisely BECAUSE
    // of what that function refuses to touch: SMS consent (`smsConsentAt` /
    // `smsConsentSource` / `optedOut`) and `acuityClientKey`, the sync anchor.
    // Typing a phone number can never manufacture permission to text it, and it
    // can never fork a synced client into a duplicate.
    //
    // After commit: the values were validated above, so the only reachable
    // outcome here is success, and the schedule change is already durable.
    const contactClientId = d.clientId !== undefined ? d.clientId : appt.clientId;
    let contactSynced = false;
    if (contactClientId && (normalizedPhone !== undefined || normalizedEmail !== undefined)) {
      const synced = await editClient(shopId, contactClientId, {
        ...(normalizedPhone !== undefined ? { phone: normalizedPhone } : {}),
        ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
      });
      contactSynced = synced.ok;
      if (!synced.ok) {
        // Never fatal - the booking edit already committed. Logged by REASON
        // only; the offending value never reaches a log line.
        logger.warn(
          { shopId, appointmentId: appt.id, reason: synced.reason },
          "appointment contact not carried to client record",
        );
      }
    }

    // Replacement block first; the old one is released only on confirmation.
    // The outcome is reported so the UI can be honest when Acuity did not
    // confirm, rather than showing a clean success over an unresolved move.
    const mirror = timeMoved
      ? await completeReschedule(shopId, appt.id, mirrorOutboxId)
      : "skipped";

    // Operational audit: WHO changed WHICH fields, and the before/after times.
    // Field NAMES only - never the values, so a client's phone number or a
    // barber's private note never lands in a log line.
    logger.info(
      {
        shopId,
        appointmentId: appt.id,
        actorUserId: req.userId ?? null,
        actorStaffId: req.shopStaffId ?? null,
        changed: Object.keys(d).filter((k) => k !== "customTime"),
        timeMoved,
        staffChanged: staffId !== appt.staffId,
        contactSynced,
        from: timeMoved ? appt.startsAt.toISOString() : undefined,
        to: timeMoved ? startsAt.toISOString() : undefined,
        mirror,
      },
      "appointment edited",
    );

    invalidateAvailability(shopId);
    res.json({ ok: true, id: appt.id, status: appt.status, mirror });
  });
}
