import { Router } from "express";
import { z } from "zod";
import { runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireRole } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import {
  RESEND_REFUSAL_HTTP,
  resendRewardsLink,
} from "../services/rewardsLinkResend.js";

/**
 * The barber's OWN clients - the people who have sat (or are booked to sit)
 * in their chair - with one action: text them their rewards link.
 *
 * This deliberately widens the old "no client list beyond today" boundary,
 * by Eric's decision: a barber can see and serve THEIR clientele, never the
 * shop book. The derivation is server-side and structural:
 *
 * 🔴 THE CHAIR COMES FROM req.shopStaffId, NEVER FROM THE REQUEST, and
 * "their client" means a BOOKED or COMPLETED Appointment exists on that
 * chair for the client. Chair attribution lives ONLY on Appointment - Visit
 * has no staffId (synced calendars don't say who cut), so an Acuity-only
 * client belongs to no chair and stays off every barber's list. Walk-ins
 * are covered: starting one creates a real Appointment on the chair.
 *
 * A client outside that set answers 404 - identical to "does not exist",
 * so the endpoint can't be used to probe the shop book.
 *
 * Phones are MASKED to the last 4 digits - enough to tell two Mikes apart,
 * not enough to harvest the book. The resend action never needs the number
 * client-side; the server texts the row's own phone.
 */
export const barberClientsRouter: Router = Router();

barberClientsRouter.use(
  requireUser,
  requireShop,
  requireRole("OWNER", "MANAGER", "BARBER"),
  requireActiveAccess,
);

/** Appointment statuses that make someone "their client": served, or booked
 * in. CANCELED / NO_SHOW / expired holds prove nothing. */
const OWNING_STATUSES = ["BOOKED", "COMPLETED"] as const;

const listQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
});

export interface BarberClientRow {
  id: string;
  name: string;
  maskedPhone: string | null;
  lastSeen: string | null;
  visits: number;
  textable: boolean;
  reason: "no_phone" | "opted_out" | "no_consent" | null;
}

function maskPhone(phone: string): string {
  return `··· ${phone.slice(-4)}`;
}

barberClientsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const staffId = req.shopStaffId ?? null;
  // Same shape as /api/barber/home: a seat with no chair linked has no
  // clientele to show - a normal empty payload with a reason beats a 403
  // that renders as "broken".
  if (!staffId) {
    res.json({ chair: null, clients: [], reason: "no_chair_linked" });
    return;
  }
  const shopId = req.shop!.id;

  const { grouped, clients } = await runWithShop(shopId, async (tx) => {
    const grouped = await tx.appointment.groupBy({
      by: ["clientId"],
      where: {
        shopId,
        staffId,
        clientId: { not: null },
        status: { in: [...OWNING_STATUSES] },
        // Receptionist holds aren't bookings yet - same rule as the barber
        // home board.
        holdExpiresAt: null,
      },
      _count: { _all: true },
      _max: { startsAt: true },
      orderBy: { _max: { startsAt: "desc" } },
      take: 500,
    });
    const ids = grouped.map((g) => g.clientId).filter((id): id is string => id !== null);
    const clients = ids.length
      ? await tx.client.findMany({
          where: { id: { in: ids }, archivedAt: null },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            optedOut: true,
            smsConsentAt: true,
          },
        })
      : [];
    return { grouped, clients };
  });

  const byId = new Map(clients.map((c) => [c.id, c]));
  let rows: BarberClientRow[] = [];
  for (const g of grouped) {
    const c = g.clientId ? byId.get(g.clientId) : undefined;
    if (!c) continue; // archived, or raced away
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "Client";
    const reason = !c.phone
      ? ("no_phone" as const)
      : c.optedOut
        ? ("opted_out" as const)
        : !c.smsConsentAt
          ? ("no_consent" as const)
          : null;
    rows.push({
      id: c.id,
      name,
      maskedPhone: c.phone ? maskPhone(c.phone) : null,
      lastSeen: g._max.startsAt?.toISOString() ?? null,
      visits: g._count._all,
      textable: reason === null,
      reason,
    });
  }

  const q = parsed.data.q ?? "";
  if (q) {
    const needle = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    rows = rows.filter((r) => {
      if (r.name.toLowerCase().includes(needle)) return true;
      // 4+ digits: match on the client's REAL number server-side (the barber
      // types a number they already know); the response still only carries
      // the masked form.
      if (digits.length >= 4) {
        const full = byId.get(r.id)?.phone?.replace(/\D/g, "") ?? "";
        return full.includes(digits);
      }
      return false;
    });
  }

  res.json({
    chair: { staffId },
    clients: rows.slice(0, 100),
    reason: null,
  });
});

barberClientsRouter.post("/:clientId/rewards-link", async (req, res) => {
  const staffId = req.shopStaffId ?? null;
  if (!staffId) {
    res.status(403).json({ error: "no_chair" });
    return;
  }
  const shopId = req.shop!.id;
  const clientId = String(req.params.clientId);

  // Ownership FIRST, and a miss is a 404 indistinguishable from a client
  // that doesn't exist - this route must not confirm shop-book membership.
  const client = await runWithShop(shopId, async (tx) => {
    const owns = await tx.appointment.findFirst({
      where: {
        shopId,
        staffId,
        clientId,
        status: { in: [...OWNING_STATUSES] },
        holdExpiresAt: null,
      },
      select: { id: true },
    });
    if (!owns) return null;
    return tx.client.findFirst({
      where: { id: clientId, archivedAt: null },
      select: {
        id: true,
        phone: true,
        optedOut: true,
        optOutSource: true,
        smsConsentAt: true,
        magicToken: true,
      },
    });
  });
  if (!client) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const result = await resendRewardsLink({
    shopId,
    client,
    twilioNumber: req.shop!.twilioNumber,
  });
  if (result.ok) {
    res.json({ ok: true });
    return;
  }
  const answer = RESEND_REFUSAL_HTTP[result.refusal];
  res.status(answer.status).json({ error: answer.error, message: answer.message });
});
