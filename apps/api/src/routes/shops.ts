import { Router } from "express";
import { z } from "zod";
import {
  BILLING,
  DEFAULTS,
  INDUSTRIES,
  INDUSTRY_KEYS,
  PAGE_THEME_KEYS,
  randomToken,
  type IndustryKey,
} from "@chairback/config";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { previewNudgeBody } from "../messaging/templates.js";

export const shopsRouter: Router = Router();

/** URL handle for the public page: lowercase, digits, single dashes. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "shop";
}

/** First free slug: base, base-2, base-3... (unique index is the backstop). */
async function availableSlug(name: string): Promise<string> {
  const base = slugify(name).slice(0, 40);
  const taken = new Set(
    (
      await prisma.shop.findMany({
        where: { slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((s) => s.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${randomToken(4)}`;
}

// http(s) only: these URLs are rendered as <a href>/<img src> on the PUBLIC
// rewards page, so a javascript:/data: scheme would be stored XSS for clients.
const httpUrl = (max: number) =>
  z
    .string()
    .max(max)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

const createShopSchema = z
  .object({
    name: z.string().min(1).max(120),
    bookingUrl: httpUrl(500),
    timezone: z.string().min(1).default(DEFAULTS.timezone),
    // Vertical: flavors the seeded reward + copy, nothing structural.
    industry: z.enum(INDUSTRY_KEYS as [string, ...string[]]).default("barber"),
    // Seeds the FIRST reward on the shop's menu (the Reward table is the
    // source of truth; the legacy field names keep onboarding compatible).
    // rewardLabel falls back to the industry's default when omitted.
    rewardThreshold: z.number().int().min(1).max(100).default(DEFAULTS.rewardThreshold),
    rewardLabel: z.string().min(1).max(80).optional(),
    nudgeBufferDays: z.number().int().min(0).max(90).default(DEFAULTS.nudgeBufferDays),
    dailySendCap: z.number().int().min(1).max(1000).default(DEFAULTS.dailySendCap),
    smsTemplate: z.string().max(480).nullish(),
    rebookWindowDays: z.number().int().min(1).max(90).default(14),
    logoUrl: httpUrl(500).nullish().or(z.literal("")),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #D4AF37")
      .nullish()
      .or(z.literal("")),
  })
  .strict();

// The single-reward fields moved to the loyalty designer (/api/loyalty); the
// rest of the shop settings remain editable here, plus the public page fields.
const updateShopSchema = createShopSchema
  .omit({ rewardThreshold: true, rewardLabel: true })
  .extend({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/,
        "3-40 chars: letters, numbers, dashes",
      ),
    publicPageEnabled: z.boolean(),
    theme: z.enum(PAGE_THEME_KEYS as [string, ...string[]]),
    bio: z.string().trim().max(500).nullish().or(z.literal("")),
    heroImageUrl: httpUrl(500).nullish().or(z.literal("")),
    instagramHandle: z
      .string()
      .trim()
      .transform((s) => s.replace(/^@/, ""))
      .pipe(z.string().regex(/^[A-Za-z0-9._]{0,30}$/, "Letters, numbers, dots, underscores"))
      .nullish()
      .or(z.literal("")),
    hoursText: z.string().trim().max(400).nullish().or(z.literal("")),
    galleryUrls: z.array(httpUrl(500)).max(6),
  })
  .partial();

// Create the barber's shop (one per barber for now).
shopsRouter.post("/", requireUser, async (req, res) => {
  const parsed = createShopSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const existing = await prisma.shop.findFirst({ where: { ownerId: req.userId } });
  if (existing) {
    res.status(409).json({ error: "shop_exists", shopId: existing.id });
    return;
  }
  const { rewardLabel, rewardThreshold, ...shopData } = parsed.data;
  const industry = INDUSTRIES[shopData.industry as IndustryKey] ?? INDUSTRIES.other;
  const slug = await availableSlug(parsed.data.name);
  // Shop + its first menu reward land together or not at all.
  const shop = await prisma.$transaction(async (tx) => {
    const created = await tx.shop.create({
      data: {
        ownerId: req.userId!,
        webhookSecret: randomToken(),
        slug,
        // The free trial starts the moment the shop exists. Enforcement only
        // kicks in once Stripe is configured (see billing/stripe.ts).
        trialEndsAt: new Date(Date.now() + BILLING.trialDays * 86_400_000),
        ...shopData,
      },
    });
    await tx.reward.create({
      data: {
        shopId: created.id,
        name: rewardLabel ?? industry.defaultReward,
        emoji: industry.emoji,
        punchCost: rewardThreshold,
        sortOrder: 0,
      },
    });
    return created;
  });
  res.status(201).json(serializeShop(shop));
});

// Current shop + connection / progress status for the onboarding wizard.
shopsRouter.get("/me", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const [connection, visitCount, clientCount] = await Promise.all([
    prisma.acuityConnection.findUnique({ where: { shopId: shop.id } }),
    prisma.visit.count({ where: { shopId: shop.id } }),
    prisma.client.count({ where: { shopId: shop.id } }),
  ]);
  res.json({
    ...serializeShop(shop),
    connected: Boolean(connection),
    acuityAccountId: connection?.acuityAccountId ?? null,
    visitCount,
    clientCount,
  });
});

shopsRouter.patch("/me", requireUser, requireShop, async (req, res) => {
  const parsed = updateShopSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  // Normalize empty strings on optional branding/page fields to null.
  const data = { ...parsed.data };
  if (data.logoUrl === "") data.logoUrl = null;
  if (data.accentColor === "") data.accentColor = null;
  if (data.bio === "") data.bio = null;
  if (data.heroImageUrl === "") data.heroImageUrl = null;
  if (data.instagramHandle === "") data.instagramHandle = null;
  if (data.hoursText === "") data.hoursText = null;
  try {
    const shop = await prisma.shop.update({
      where: { id: req.shop!.id },
      data,
    });
    res.json(serializeShop(shop));
  } catch (err) {
    // Unique violation on slug = someone else owns that handle.
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "slug_taken" });
      return;
    }
    throw err;
  }
});

// Public shop page payload, by slug. No auth - this IS the public mini-site.
// Mounted with the rewards (public) rate limiter in app.ts.
export const publicPageRouter: Router = Router();
publicPageRouter.get("/:slug", async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  if (!shop || !shop.publicPageEnabled) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const now = new Date();
  const [rewards, promotions] = await Promise.all([
    prisma.reward.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { punchCost: "asc" }],
      select: { id: true, name: true, description: true, emoji: true, punchCost: true },
    }),
    prisma.promotion.findMany({
      where: {
        shopId: shop.id,
        active: true,
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      },
      orderBy: [{ endsAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 6,
      select: {
        id: true,
        kind: true,
        title: true,
        description: true,
        code: true,
        percentOff: true,
        amountOff: true,
        extraPunches: true,
        endsAt: true,
      },
    }),
  ]);
  res.json({
    name: shop.name,
    slug: shop.slug,
    bio: shop.bio,
    theme: shop.theme,
    logoUrl: shop.logoUrl,
    heroImageUrl: shop.heroImageUrl,
    accentColor: shop.accentColor,
    instagramHandle: shop.instagramHandle,
    hoursText: shop.hoursText,
    galleryUrls: shop.galleryUrls,
    bookingUrl: shop.bookingUrl,
    punchesPerVisit: shop.punchesPerVisit,
    rewards,
    promotions: promotions.map((p) => ({
      ...p,
      amountOff: p.amountOff === null ? null : Number(p.amountOff),
      endsAt: p.endsAt?.toISOString() ?? null,
    })),
  });
});

// Danger zone: delete the shop and ALL its data (clients, visits, punches,
// nudges, Acuity connection) via cascading deletes. Requires the shop name as
// a typed confirmation to prevent accidents.
shopsRouter.delete("/me", requireUser, requireShop, async (req, res) => {
  const confirm = String(req.body?.confirm ?? "");
  if (confirm !== req.shop!.name) {
    res.status(400).json({ error: "confirm_mismatch" });
    return;
  }
  await prisma.shop.delete({ where: { id: req.shop!.id } });
  res.json({ ok: true });
});

// SMS template preview (sample-rendered, no real client).
shopsRouter.post("/me/sms-preview", requireUser, requireShop, (req, res) => {
  const template = typeof req.body?.template === "string" ? req.body.template : null;
  res.json({
    preview: previewNudgeBody(template, req.shop!.name, req.shop!.bookingUrl),
  });
});

function serializeShop(shop: {
  id: string;
  name: string;
  timezone: string;
  industry: string;
  bookingUrl: string;
  punchesPerVisit: number;
  nudgeBufferDays: number;
  dailySendCap: number;
  smsTemplate: string | null;
  rebookWindowDays: number;
  logoUrl: string | null;
  accentColor: string | null;
  plan: string;
  slug: string | null;
  publicPageEnabled: boolean;
  theme: string;
  bio: string | null;
  heroImageUrl: string | null;
  instagramHandle: string | null;
  hoursText: string | null;
  galleryUrls: string[];
}) {
  // Note: webhookSecret is intentionally NOT exposed to the client.
  return {
    id: shop.id,
    name: shop.name,
    timezone: shop.timezone,
    industry: shop.industry,
    bookingUrl: shop.bookingUrl,
    punchesPerVisit: shop.punchesPerVisit,
    nudgeBufferDays: shop.nudgeBufferDays,
    dailySendCap: shop.dailySendCap,
    smsTemplate: shop.smsTemplate,
    rebookWindowDays: shop.rebookWindowDays,
    logoUrl: shop.logoUrl,
    accentColor: shop.accentColor,
    plan: shop.plan,
    slug: shop.slug,
    publicPageEnabled: shop.publicPageEnabled,
    theme: shop.theme,
    bio: shop.bio,
    heroImageUrl: shop.heroImageUrl,
    instagramHandle: shop.instagramHandle,
    hoursText: shop.hoursText,
    galleryUrls: shop.galleryUrls,
  };
}
