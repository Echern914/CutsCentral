import type { Router } from "express";
import { prisma } from "@chairback/db";
import {
  dismissUnfinishedBooking,
  listUnfinishedBookings,
} from "../services/unfinishedBookings.js";
import { phoneDisplay } from "./booking.appointmentDetail.js";

/**
 * "Didn't finish booking" on the Appointments tab: the clients a payment hold
 * left behind, and the one write that belongs to the list itself - taking a
 * person off it. Booking them goes through the ordinary POST /appointments,
 * with every guard that has.
 *
 * Manager-only, like the rest of this router (requireManager). Every read is
 * shop-scoped in services/unfinishedBookings.ts, so another shop's id is
 * simply not found.
 *
 * 🔴 NOTHING HERE IS LOGGED: the rows carry phone numbers and emails.
 */
export function registerUnfinishedBookings(router: Router): void {
  router.get("/unfinished", async (req, res) => {
    const shopId = req.shop!.id;
    // Shop has RLS with no policy: read as the owner, as /agenda does.
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { timezone: true },
    });
    if (!shop) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { rows, more } = await listUnfinishedBookings(shopId, new Date(), shop.timezone);
    res.json({
      timezone: shop.timezone,
      more,
      rows: rows.map((r) => ({
        ...r,
        phoneDisplay: phoneDisplay(r.phone),
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        triedAt: r.triedAt.toISOString(),
        heldUntil: r.heldUntil?.toISOString() ?? null,
        otherTimes: r.otherTimes.map((t) => ({
          startsAt: t.startsAt.toISOString(),
          serviceName: t.serviceName,
        })),
      })),
    });
  });

  router.post("/unfinished/:id/dismiss", async (req, res) => {
    const outcome = await dismissUnfinishedBooking(req.shop!.id, req.params.id!, new Date());
    if (outcome === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (outcome === "still_finishing") {
      res.status(409).json({ error: "still_finishing" });
      return;
    }
    res.json({ ok: true });
  });
}
