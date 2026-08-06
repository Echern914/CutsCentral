import { Router } from "express";
import { z } from "zod";
import { prisma, runAsOwner, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { logger } from "../logger.js";
import {
  NOTIFY_DEFAULTS,
  resolveNotifyPrefs,
  sendToBarber,
} from "../services/barberNotify.js";

/**
 * The barber's own notification settings, plus the two things that decide
 * whether a notification can arrive at all: which devices are registered, and
 * a way to prove delivery works.
 *
 * Deliberately NOT requireManager: an employee barber needs to control his own
 * alerts as much as the owner does, and everything here is keyed to the
 * session's userId, so one member can never read or edit another's.
 */
export const notificationsRouter: Router = Router();
notificationsRouter.use(requireUser, requireShop);

/** GET /api/notifications - prefs + registered devices for the signed-in user. */
notificationsRouter.get("/", async (req, res) => {
  const shopId = req.shop!.id;
  const userId = req.userId!;
  const [prefs, shop, devices] = await Promise.all([
    resolveNotifyPrefs(shopId, userId),
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { notifyPhone: true, timezone: true },
    }),
    // User-keyed rows are cross-shop by design (one phone, several shops), so
    // they're read as owner rather than through the shop scope.
    runAsOwner((tx) =>
      tx.pushSubscription.findMany({
        where: { userId },
        orderBy: { lastSeenAt: "desc" },
        select: {
          id: true,
          kind: true,
          userAgent: true,
          lastSeenAt: true,
          createdAt: true,
          failureCount: true,
        },
      }),
    ),
  ]);
  res.json({
    prefs,
    defaults: NOTIFY_DEFAULTS,
    // What SMS falls back to when the barber sets no number of his own.
    shopNotifyPhone: shop?.notifyPhone ?? null,
    timezone: shop?.timezone ?? null,
    devices: devices.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.userAgent || (d.kind === "expo" ? "Phone app" : "Browser"),
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
      failing: d.failureCount > 0,
    })),
  });
});

const prefsSchema = z
  .object({
    pushEnabled: z.boolean(),
    smsEnabled: z.boolean(),
    smsRemindersEnabled: z.boolean(),
    emailEnabled: z.boolean(),
    // "" clears it back to the shop-wide alert number.
    notifyPhone: z.string().trim().max(32).nullish(),
    nextUpEnabled: z.boolean(),
    // 5 min is the tick floor; 2h is as early as a "next up" still means next.
    nextUpLeadMin: z.number().int().min(5).max(120),
    dayAheadEnabled: z.boolean(),
    dayAheadHour: z.number().int().min(0).max(23),
    newBookingEnabled: z.boolean(),
    cancelEnabled: z.boolean(),
  })
  .partial()
  .strict();

/** PUT /api/notifications - upsert this user's prefs for the active shop. */
notificationsRouter.put("/", async (req, res) => {
  const parsed = prefsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const userId = req.userId!;
  const data = {
    ...parsed.data,
    ...(parsed.data.notifyPhone !== undefined
      ? { notifyPhone: parsed.data.notifyPhone?.trim() || null }
      : {}),
  };
  await runWithShop(shopId, (tx) =>
    tx.barberNotifyPref.upsert({
      where: { userId_shopId: { userId, shopId } },
      // A first save writes the defaults plus whatever was sent, so a partial
      // PUT can never create a row of nulls.
      create: { shopId, userId, ...NOTIFY_DEFAULTS, ...data },
      update: data,
    }),
  );
  res.json({ ok: true, prefs: await resolveNotifyPrefs(shopId, userId) });
});

/**
 * POST /api/notifications/test - send a real notification to yourself.
 *
 * The single most useful button here: push depends on a registered device, a
 * VAPID/APNs key and DRY_RUN being off, and a barber has no way to know which
 * one is missing. This reports exactly which channels actually delivered.
 */
notificationsRouter.post("/test", async (req, res) => {
  const shopId = req.shop!.id;
  const userId = req.userId!;
  const result = await sendToBarber({
    shopId,
    userId,
    kind: "nextUp",
    force: true, // a test ignores the per-event switches, not the channels
    message: {
      title: "Test notification",
      body: "This is what an appointment alert looks like. Next up: Sam Cole - Fade at 2:30 PM.",
      tag: "notify-test",
    },
  });
  res.json({ ok: true, ...result });
});

/** DELETE /api/notifications/devices/:id - forget one of MY devices. */
notificationsRouter.delete("/devices/:id", async (req, res) => {
  const userId = req.userId!;
  // Scoped to userId in the WHERE, so this can only ever remove your own.
  const { count } = await runAsOwner((tx) =>
    tx.pushSubscription.deleteMany({ where: { id: req.params.id, userId } }),
  );
  res.status(count > 0 ? 200 : 404).json({ ok: count > 0 });
});

/**
 * POST /api/notifications/sign-out-everywhere - invalidate every session.
 *
 * Bumping tokenVersion is what the password-change path already does; exposing
 * it on its own means a barber whose phone was lost or who shared a login can
 * cut access without changing their password. The CURRENT session dies too -
 * that's the point - so the web client redirects to login after calling it.
 */
notificationsRouter.post("/sign-out-everywhere", async (req, res) => {
  const userId = req.userId!;
  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
  logger.info({ userId }, "user signed out of all sessions");
  res.json({ ok: true });
});
