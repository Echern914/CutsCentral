import { randomInt } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { Prisma, prisma } from "@chairback/db";
import { normalizePromoCode, PROMO_AMOUNT_MAX_CENTS } from "@chairback/config/promoPricing";
import { offerRefusalText, offerValueWords, suggestOfferCode } from "@chairback/config/offers";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { effectivePriceAt } from "../engines/pricing.js";
import { resolveAddOns } from "../engines/addOns.js";
import { findOfferByCode, offerUseCounts, OfferRefused, quoteOffer } from "../engines/offers.js";

/**
 * OFFERS & CODES - the shop's own discount codes and personal offers.
 *
 * Who can make one: an owner or manager, any offer. A BARBER seat only with
 * the permission the owner gave it (ShopMember.offerServiceIds), only for
 * those services, and only on its own chair.
 *
 * 🔴 MAKING AN OFFER SENDS NOTHING. No text, email or push goes out from here,
 * and nothing here touches a client's marketing consent. The shop shares the
 * code itself. (Promotions has the SMS blast; offers deliberately don't.)
 *
 * Dark until a shop is switched on (Shop.offersEnabled): every route answers
 * as if there were nothing here.
 */
export const offersRouter: Router = Router();
offersRouter.use(requireUser, requireShop, requireActiveAccess);

type Seat = { manager: true } | { manager: false; staffId: string | null; serviceIds: string[] };

async function seatOf(req: Request): Promise<Seat> {
  if (req.shopRole === "OWNER" || req.shopRole === "MANAGER") return { manager: true };
  const member = await prisma.shopMember.findUnique({
    where: { shopId_userId: { shopId: req.shop!.id, userId: req.userId! } },
    select: { offerServiceIds: true },
  });
  return { manager: false, staffId: req.shopStaffId ?? null, serviceIds: member?.offerServiceIds ?? [] };
}

async function shopOffersOn(shopId: string): Promise<{ timezone: string } | null> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { offersEnabled: true, timezone: true } });
  return shop?.offersEnabled ? { timezone: shop.timezone } : null;
}

function status(o: { active: boolean; endsAt: Date | null; maxUses: number | null }, uses: number, now: Date) {
  if (!o.active) return "paused" as const;
  if (o.endsAt && o.endsAt <= now) return "ended" as const;
  if (o.maxUses !== null && uses >= o.maxUses) return "used_up" as const;
  return "on" as const;
}

offersRouter.get("/", async (req, res) => {
  const shopId = req.shop!.id;
  const seat = await seatOf(req);
  const canCreate = seat.manager || (seat.staffId !== null && seat.serviceIds.length > 0);
  if (!(await shopOffersOn(shopId))) {
    res.json({ enabled: false, canCreate: false, offers: [] });
    return;
  }
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : undefined;
  // A barber sees the offers on their own chair; the shop sees all of them.
  const where: Prisma.OfferWhereInput = {
    shopId,
    ...(clientId ? { clientId } : {}),
    ...(seat.manager ? {} : { staffIds: { has: seat.staffId ?? "-" } }),
  };
  const offers = await prisma.offer.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { client: { select: { id: true, firstName: true, lastName: true } } },
  });
  const now = new Date();
  const uses = await offerUseCounts(prisma, offers.map((o) => o.id), now);
  res.json({
    enabled: true,
    canCreate,
    // What this seat may make offers for (null = anything).
    allowedServiceIds: seat.manager ? null : seat.serviceIds,
    ownStaffId: seat.manager ? null : seat.staffId,
    offers: offers.map((o) => ({
      id: o.id,
      code: o.code,
      kind: o.kind,
      amountOffCents: o.amountOffCents,
      percentOffBps: o.percentOffBps,
      freeServiceId: o.freeServiceId,
      serviceIds: o.serviceIds,
      staffIds: o.staffIds,
      client: o.client
        ? { id: o.client.id, name: [o.client.firstName, o.client.lastName].filter(Boolean).join(" ") || "Client" }
        : null,
      maxUses: o.maxUses,
      maxUsesPerClient: o.maxUsesPerClient,
      endsAt: o.endsAt?.toISOString() ?? null,
      active: o.active,
      note: o.note,
      uses: uses.get(o.id) ?? 0,
      status: status(o, uses.get(o.id) ?? 0, now),
      createdAt: o.createdAt.toISOString(),
    })),
  });
});

const createSchema = z
  .object({
    code: z.string().trim().max(40).optional(),
    kind: z.enum(["AMOUNT_OFF", "PERCENT_OFF", "FREE_SERVICE"]),
    amountOffCents: z.number().int().min(1).max(PROMO_AMOUNT_MAX_CENTS).optional(),
    /** Whole or fractional percent, 0.01-100. */
    percentOff: z.number().min(0.01).max(100).optional(),
    freeServiceId: z.string().min(1).optional(),
    serviceIds: z.array(z.string().min(1)).max(50).optional(),
    staffIds: z.array(z.string().min(1)).max(50).optional(),
    clientId: z.string().min(1).nullable().optional(),
    /** null = no limit; absent = the default for the kind of offer. */
    maxUses: z.number().int().min(1).max(10_000).nullable().optional(),
    maxUsesPerClient: z.number().int().min(1).max(100).nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

offersRouter.post("/", async (req, res) => {
  const shopId = req.shop!.id;
  if (!(await shopOffersOn(shopId))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const seat = await seatOf(req);

  // The value its kind needs - and only that.
  const percentOffBps = d.kind === "PERCENT_OFF" && d.percentOff !== undefined ? Math.round(d.percentOff * 100) : null;
  if (
    (d.kind === "AMOUNT_OFF" && d.amountOffCents === undefined) ||
    (d.kind === "PERCENT_OFF" && (percentOffBps === null || percentOffBps < 1 || percentOffBps > 10_000)) ||
    (d.kind === "FREE_SERVICE" && !d.freeServiceId)
  ) {
    res.status(400).json({ error: "invalid_value", message: "Say how much it takes off, or which service is free." });
    return;
  }
  const serviceIds = d.kind === "FREE_SERVICE" ? [d.freeServiceId!] : [...new Set(d.serviceIds ?? [])];
  let staffIds = [...new Set(d.staffIds ?? [])];

  // A barber: only their own chair, only services they were given.
  if (!seat.manager) {
    const allowed = new Set(seat.serviceIds);
    if (
      seat.staffId === null ||
      serviceIds.length === 0 ||
      serviceIds.some((id) => !allowed.has(id)) ||
      staffIds.some((id) => id !== seat.staffId)
    ) {
      res.status(403).json({
        error: "not_permitted",
        message: "You can make offers only for the services the owner gave you, on your own chair.",
      });
      return;
    }
    staffIds = [seat.staffId];
  }

  // Everything named must be this shop's.
  const [services, staff, client] = await Promise.all([
    serviceIds.length
      ? prisma.service.findMany({ where: { shopId, id: { in: serviceIds } }, select: { id: true } })
      : Promise.resolve([]),
    staffIds.length
      ? prisma.staff.findMany({ where: { shopId, id: { in: staffIds } }, select: { id: true } })
      : Promise.resolve([]),
    d.clientId
      ? prisma.client.findFirst({ where: { shopId, id: d.clientId }, select: { id: true, firstName: true } })
      : Promise.resolve(null),
  ]);
  if (services.length !== serviceIds.length) {
    res.status(400).json({ error: "unknown_service" });
    return;
  }
  if (staff.length !== staffIds.length) {
    res.status(400).json({ error: "unknown_staff" });
    return;
  }
  if (d.clientId && !client) {
    res.status(400).json({ error: "unknown_client" });
    return;
  }
  const now = new Date();
  if (d.endsAt && d.endsAt <= now) {
    res.status(400).json({ error: "ends_in_past", message: "Pick an end date that hasn't passed." });
    return;
  }

  let code: string | null = null;
  if (d.code !== undefined && d.code !== "") {
    code = normalizePromoCode(d.code);
    if (!code) {
      res.status(400).json({
        error: "invalid_code",
        message: "Use 3 to 24 letters, numbers or dashes.",
      });
      return;
    }
  }
  const personal = Boolean(d.clientId);
  const data = {
    shopId,
    kind: d.kind,
    amountOffCents: d.kind === "AMOUNT_OFF" ? d.amountOffCents! : null,
    percentOffBps: d.kind === "PERCENT_OFF" ? percentOffBps : null,
    freeServiceId: d.kind === "FREE_SERVICE" ? d.freeServiceId! : null,
    serviceIds: d.kind === "FREE_SERVICE" ? [] : serviceIds,
    staffIds,
    clientId: d.clientId ?? null,
    // A personal offer is one use unless the shop says otherwise; a public
    // code is one use per client.
    maxUses: d.maxUses === undefined ? (personal ? 1 : null) : d.maxUses,
    maxUsesPerClient: d.maxUsesPerClient === undefined ? (personal ? null : 1) : d.maxUsesPerClient,
    endsAt: d.endsAt ?? null,
    note: d.note || null,
    createdByUserId: req.userId ?? null,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const tryCode = code ?? suggestOfferCode(client?.firstName ?? null, (n) => randomInt(0, n));
    try {
      const made = await prisma.offer.create({ data: { ...data, code: tryCode }, select: { id: true, code: true } });
      res.status(201).json({ ok: true, id: made.id, code: made.code });
      return;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        if (code) {
          res.status(409).json({ error: "code_taken", message: "That code is already used here. Pick another." });
          return;
        }
        continue; // a suggested code collided: draw another
      }
      throw err;
    }
  }
  res.status(503).json({ error: "try_again" });
});

const patchSchema = z
  .object({ active: z.boolean().optional(), note: z.string().trim().max(200).nullable().optional() })
  .strict();

/** Owner or manager, or the barber who made it. */
async function mayChange(req: Request, offerId: string) {
  const offer = await prisma.offer.findFirst({
    where: { id: offerId, shopId: req.shop!.id },
    select: { id: true, createdByUserId: true },
  });
  if (!offer) return null;
  const seat = await seatOf(req);
  return seat.manager || offer.createdByUserId === req.userId ? offer : "forbidden";
}

offersRouter.patch("/:id", async (req, res) => {
  if (!(await shopOffersOn(req.shop!.id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const offer = await mayChange(req, req.params.id!);
  if (offer === null) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (offer === "forbidden") {
    res.status(403).json({ error: "not_permitted" });
    return;
  }
  await prisma.offer.update({
    where: { id: offer.id },
    data: {
      ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
      ...(parsed.data.note !== undefined ? { note: parsed.data.note || null } : {}),
    },
  });
  res.json({ ok: true });
});

/**
 * Only an offer never used can be deleted. One that discounted a booking is
 * paused instead: the booking's record of what it took off must keep its offer.
 */
offersRouter.delete("/:id", async (req, res) => {
  if (!(await shopOffersOn(req.shop!.id))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const offer = await mayChange(req, req.params.id!);
  if (offer === null) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (offer === "forbidden") {
    res.status(403).json({ error: "not_permitted" });
    return;
  }
  const deleted = await prisma.offer.deleteMany({ where: { id: offer.id, redemptions: { none: {} } } });
  if (deleted.count === 0) {
    res.status(409).json({ error: "offer_used", message: "This offer has been used on a booking. Pause it instead." });
    return;
  }
  res.json({ ok: true });
});

const quoteSchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    clientId: z.string().min(1).optional(),
    serviceId: z.string().min(1),
    staffId: z.string().min(1),
    startsAt: z.coerce.date(),
    addOnIds: z.array(z.string().min(1)).max(20).optional(),
    /** A Custom time booking's typed price, as the create route takes it. */
    price: z.number().finite().min(0).max(10_000).optional(),
    special: z.boolean().optional(),
    series: z.boolean().optional(),
  })
  .strict();

/**
 * THE SHOP'S BOOKING FORM ASKS BEFORE IT BOOKS: what this code does to this
 * visit, priced the way the create route will price it. The shop books for
 * `clientId`, which is what makes a personal offer theirs.
 */
offersRouter.post("/quote", requireManager, async (req, res) => {
  const shopId = req.shop!.id;
  const shop = await shopOffersOn(shopId);
  const parsed = quoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const d = parsed.data;
  const service = await prisma.service.findFirst({
    where: { id: d.serviceId, shopId },
    select: { name: true, price: true, priceOverrides: true, dateOverrides: true, timeOverrides: true },
  });
  if (!service) {
    res.status(400).json({ error: "unknown_service" });
    return;
  }
  const timeZone = shop?.timezone ?? "UTC";
  try {
    const offer = shop ? await findOfferByCode(prisma, shopId, d.code) : null;
    if (!offer) throw new OfferRefused("not_found");
    const base =
      d.price !== undefined
        ? d.price
        : effectivePriceAt(service.price === null ? null : Number(service.price), {
            at: d.startsAt,
            timezone: timeZone,
            weekdayOverrides: service.priceOverrides,
            dateOverrides: service.dateOverrides,
            timeWindows: service.timeOverrides,
          });
    const addOns = await resolveAddOns(shopId, d.serviceId, d.addOnIds);
    const quote = await quoteOffer(prisma, offer, {
      serviceCents: base === null ? null : Math.round(base * 100),
      addOnCents: Math.round(addOns.extraPrice * 100),
      clientId: d.clientId ?? null,
      now: new Date(),
      visit: {
        serviceId: d.serviceId,
        staffId: d.staffId,
        startsAt: d.startsAt,
        provenClientId: d.clientId ?? null,
        special: d.special,
        series: d.series,
      },
    });
    const names = new Map([[d.serviceId, service.name]]);
    res.json({
      ok: true,
      code: offer.code,
      words: offerValueWords(offer, (id) => names.get(id) ?? null),
      ...quote,
    });
  } catch (err) {
    if (err instanceof OfferRefused) {
      res.status(409).json({
        error: "offer_refused",
        reason: err.reason,
        message:
          err.reason === "changed"
            ? "That offer changed. Try again."
            : offerRefusalText(err.reason, { endsAt: err.endsAt, timeZone }),
      });
      return;
    }
    throw err;
  }
});
