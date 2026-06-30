import { Router } from "express";
import { z } from "zod";
import {
  BILLING,
  DEFAULTS,
  DEFAULT_SECTION_ORDER,
  GALLERY_CAPTION_MAX,
  GALLERY_MAX,
  INDUSTRIES,
  INDUSTRY_KEYS,
  LAYOUT_STYLE_KEYS,
  PAGE_FONT_KEYS,
  PAGE_SECTION_KEYS,
  PAGE_THEME_KEYS,
  REWARDS_SECTION_DEFAULT,
  REWARDS_SECTION_KEYS,
  REWARDS_WELCOME_MAX,
  apiEnv,
  randomToken,
  type GalleryItem,
  type IndustryKey,
} from "@chairback/config";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { previewNudgeBody } from "../messaging/templates.js";
import { toE164 } from "../acuity/clientKey.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { leadLimiter } from "../middleware/rateLimit.js";
import { logger } from "../logger.js";

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

// A gallery photo: http(s) image URL + optional caption. Same XSS guard on the
// URL as everywhere else; caption is plain text rendered as textContent.
const galleryItemSchema = z.object({
  url: httpUrl(500),
  caption: z.string().trim().max(GALLERY_CAPTION_MAX).optional().or(z.literal("")),
});

const createShopSchema = z
  .object({
    name: z.string().min(1).max(120),
    // Optional: a shop may have no external booking link. "" / omitted => null,
    // and "Book" CTAs fall back to the rewards page. A provided value must still
    // be a real http(s) URL (XSS guard - it's rendered as <a href>).
    bookingUrl: httpUrl(500).nullish().or(z.literal("")),
    timezone: z.string().min(1).default(DEFAULTS.timezone),
    // Vertical: flavors the seeded reward + copy, nothing structural.
    industry: z.enum(INDUSTRY_KEYS as [string, ...string[]]).default("other"),
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
    // SMS attestation captured here too: the Google sign-in path skips the
    // signup form, so onboarding (shop creation) is where those users first
    // affirm it. Must be literally true. (Form-signup users already attested.)
    smsAttested: z.literal(true),
  })
  .strict();

// The single-reward fields moved to the loyalty designer (/api/loyalty); the
// rest of the shop settings remain editable here, plus the public page fields.
const updateShopSchema = createShopSchema
  // smsAttested is a create-time gate only; settings updates never carry it.
  .omit({ rewardThreshold: true, rewardLabel: true, smsAttested: true })
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
    // Legacy bare-URL gallery (still accepted from old clients). New clients send
    // `gallery` (items with captions); when present it wins, see the PATCH below.
    galleryUrls: z.array(httpUrl(500)).max(GALLERY_MAX),
    gallery: z.array(galleryItemSchema).max(GALLERY_MAX),
    // Per-shop styling (all optional; null/unset = the page default).
    fontKey: z.enum(PAGE_FONT_KEYS as [string, ...string[]]).nullish().or(z.literal("")),
    layoutStyle: z.enum(LAYOUT_STYLE_KEYS as [string, ...string[]]).nullish().or(z.literal("")),
    // Section render order/visibility. De-duped, known keys only, capped to the
    // number of real sections. [] = "use the default order" (handled on render).
    sectionOrder: z.array(z.enum(PAGE_SECTION_KEYS as [string, ...string[]])).max(PAGE_SECTION_KEYS.length),
    // Lead form: when on, the public page shows "Request an appointment".
    // notifyPhone is texted on each new lead (normalized to E.164 below); ""/null
    // = inbox only.
    takesRequests: z.boolean(),
    notifyPhone: z.string().max(40).nullish().or(z.literal("")),
    // Transactional loyalty SMS to clients (earn/redeem confirmations). Off by
    // default; gated by client consent + quiet hours regardless. See
    // services/loyaltyNotify.ts.
    loyaltyTextsEnabled: z.boolean(),
    // Native booking engine. bookingMode picks the ONE active source; the bounds
    // shape the public slot picker (all interpreted in the shop's timezone).
    bookingMode: z.enum(["link", "acuity", "native", "square"]),
    bookingLeadHours: z.number().int().min(0).max(720),
    bookingMaxDays: z.number().int().min(1).max(365),
    bookingBufferMin: z.number().int().min(0).max(240),
    // Client rewards page content. rewardsWelcome: optional short greeting
    // ("" clears it). rewardsSections: visible REWARDS_SECTIONS keys (de-duped,
    // known keys only); [] = show all.
    rewardsWelcome: z.string().trim().max(REWARDS_WELCOME_MAX).nullish().or(z.literal("")),
    rewardsSections: z
      .array(z.enum(REWARDS_SECTION_KEYS as [string, ...string[]]))
      .max(REWARDS_SECTION_KEYS.length),
  })
  .partial();

/**
 * Resolve a shop's gallery to the canonical {url, caption?} shape for any client
 * (editor + public page). Prefers galleryItems (Json, with captions); falls back
 * to the legacy galleryUrls for shops not yet migrated. Defensive about the Json
 * blob since Prisma types it as `unknown`.
 */
function readGallery(shop: {
  galleryItems: unknown;
  galleryUrls: string[];
}): GalleryItem[] {
  const raw = shop.galleryItems;
  if (Array.isArray(raw)) {
    const items = raw
      .map((it): GalleryItem | null => {
        if (it && typeof it === "object" && typeof (it as { url?: unknown }).url === "string") {
          const url = (it as { url: string }).url;
          const caption = (it as { caption?: unknown }).caption;
          return typeof caption === "string" && caption.trim()
            ? { url, caption: caption.trim() }
            : { url };
        }
        return null;
      })
      .filter((x): x is GalleryItem => x !== null);
    if (items.length > 0 || (shop.galleryUrls?.length ?? 0) === 0) return items;
  }
  // Fall back to legacy bare URLs.
  return (shop.galleryUrls ?? []).map((url) => ({ url }));
}

/** Section order for the public page: stored order if set, else the default. */
function readSectionOrder(order: string[] | null | undefined): string[] {
  return order && order.length > 0 ? order : DEFAULT_SECTION_ORDER;
}

/** Visible rewards-page sections: stored list if set, else all (the default). */
function readRewardsSections(sections: string[] | null | undefined): string[] {
  return sections && sections.length > 0 ? sections : REWARDS_SECTION_DEFAULT;
}

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
  // smsAttested is a gate, not a Shop column - pull it out before the spread.
  const { rewardLabel, rewardThreshold, smsAttested: _smsAttested, ...shopData } =
    parsed.data;
  // Normalize an omitted/empty booking link to null (no external booking source).
  shopData.bookingUrl = shopData.bookingUrl?.trim() ? shopData.bookingUrl.trim() : null;
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
    // Record the attestation on the owner if not already set (Google-path users
    // attest here; form-signup users were stamped at signup - don't overwrite).
    await tx.user.updateMany({
      where: { id: req.userId!, smsAttestedAt: null },
      data: { smsAttestedAt: new Date() },
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
  // `gallery` (items-with-captions) isn't a Shop column - it maps to galleryItems
  // (Json) and supersedes the legacy galleryUrls. Pull it out before the spread.
  const { gallery, ...rest } = parsed.data;
  // Normalize empty strings on optional branding/page fields to null.
  const data: Record<string, unknown> = { ...rest };
  // Booking link is optional: blank/whitespace clears it (no external booking
  // source; "Book" CTAs fall back to the rewards page).
  if (typeof data.bookingUrl === "string" && !data.bookingUrl.trim()) {
    data.bookingUrl = null;
  }
  if (data.logoUrl === "") data.logoUrl = null;
  if (data.accentColor === "") data.accentColor = null;
  if (data.bio === "") data.bio = null;
  if (data.heroImageUrl === "") data.heroImageUrl = null;
  if (data.instagramHandle === "") data.instagramHandle = null;
  if (data.hoursText === "") data.hoursText = null;
  // Optional style keys: "" means "clear it" (fall back to the page default).
  if (data.fontKey === "") data.fontKey = null;
  if (data.layoutStyle === "") data.layoutStyle = null;
  // Rewards welcome: blank clears the custom line.
  if (data.rewardsWelcome === "") data.rewardsWelcome = null;
  // When the new `gallery` payload is present, it's the source of truth: write
  // galleryItems (captions stripped to undefined when blank) and keep the legacy
  // galleryUrls column mirrored so a rollback still renders photos.
  if (gallery !== undefined) {
    const items: GalleryItem[] = gallery.map((g) => ({
      url: g.url,
      ...(g.caption ? { caption: g.caption } : {}),
    }));
    data.galleryItems = items;
    data.galleryUrls = items.map((g) => g.url);
  }
  // notifyPhone: blank clears it; otherwise it must be a valid number (it's the
  // SMS destination for lead alerts, so a bad value would silently never text).
  if (data.notifyPhone === "" || data.notifyPhone === null) {
    data.notifyPhone = null;
  } else if (data.notifyPhone !== undefined) {
    const normalized = toE164(data.notifyPhone as string);
    if (!normalized) {
      res.status(400).json({ error: "invalid_phone" });
      return;
    }
    data.notifyPhone = normalized;
  }
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
  const [rewards, approvedReviews, ratingAgg, promotions] = await Promise.all([
    prisma.reward.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { punchCost: "asc" }],
      select: { id: true, name: true, description: true, emoji: true, punchCost: true },
    }),
    // Only APPROVED reviews are ever public. Newest first, capped.
    prisma.review.findMany({
      where: { shopId: shop.id, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, rating: true, body: true, authorName: true, createdAt: true },
    }),
    prisma.review.aggregate({
      where: { shopId: shop.id, status: "APPROVED" },
      _avg: { rating: true },
      _count: true,
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
    gallery: readGallery(shop),
    fontKey: shop.fontKey,
    layoutStyle: shop.layoutStyle,
    sectionOrder: readSectionOrder(shop.sectionOrder),
    bookingUrl: shop.bookingUrl,
    // When native booking is on, the page CTA points at /book/[slug] instead of
    // the external bookingUrl, and the lead form is hidden.
    bookingMode: shop.bookingMode,
    // notifyPhone is intentionally NOT exposed - it's the barber's private number.
    takesRequests: shop.takesRequests,
    punchesPerVisit: shop.punchesPerVisit,
    rewards,
    promotions: promotions.map((p) => ({
      ...p,
      amountOff: p.amountOff === null ? null : Number(p.amountOff),
      endsAt: p.endsAt?.toISOString() ?? null,
    })),
    reviews: approvedReviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      authorName: r.authorName,
      createdAt: r.createdAt.toISOString(),
    })),
    // Summary for the star header. avgRating is null when there are no reviews.
    reviewSummary: {
      count: ratingAgg._count,
      avgRating: ratingAgg._avg.rating ?? null,
    },
  });
});

// Lead from the public page's "Request an appointment" form. UNauthenticated:
// the slug resolves the shop. The insert uses plain prisma (connection owner, no
// SET ROLE) so it bypasses FORCE RLS - the same path the public rewards/Twilio
// writes use. Tighter rate limit than the page read (anti-spam).
const requestSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80).optional().or(z.literal("")),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    message: z.string().trim().max(1000).optional().or(z.literal("")),
    preferredTime: z.string().trim().max(200).optional().or(z.literal("")),
  })
  .strict()
  // Need at least one way to reach the client back.
  .refine((d) => Boolean(d.phone?.trim()) || Boolean(d.email?.trim()), {
    message: "Provide a phone or email so they can reach you back.",
    path: ["phone"],
  });

publicPageRouter.post("/:slug/request", leadLimiter, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const slug = String(req.params.slug).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  // 404 unless the page is live AND the barber is accepting requests - never
  // reveal a shop that hasn't opted in.
  if (!shop || !shop.publicPageEnabled || !shop.takesRequests) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const d = parsed.data;
  await prisma.appointmentRequest.create({
    data: {
      shopId: shop.id,
      firstName: d.firstName,
      lastName: d.lastName || null,
      // Store E.164 when parseable, else the raw input (still useful to the barber).
      phone: toE164(d.phone) ?? (d.phone?.trim() || null),
      email: d.email || null,
      message: d.message || null,
      preferredTime: d.preferredTime || null,
    },
  });

  // Best-effort barber alert. A failed/absent notify must never fail the lead -
  // it's already saved and will show in the dashboard inbox. Honors DRY_RUN so
  // "no SMS sends" holds for EVERY outbound path, not just the nudge engine -
  // this texts the barber's own number, but it's still a real (billable) send.
  if (shop.notifyPhone) {
    const contact = toE164(d.phone) ?? d.email ?? "no contact info";
    const note = d.message ? `: ${d.message}` : "";
    const body = `New appointment request at ${shop.name} from ${d.firstName} (${contact})${note}`;
    if (apiEnv().DRY_RUN) {
      logger.info({ shopId: shop.id, to: shop.notifyPhone }, "lead notify SMS (dry-run, not sent)");
    } else {
      try {
        await getMessageProvider().send({ to: shop.notifyPhone, body });
      } catch (err) {
        logger.error({ err, shopId: shop.id }, "lead notify SMS failed");
      }
    }
  }

  res.status(201).json({ ok: true });
});

// Customer review from the public page. UNauthenticated (slug resolves the shop);
// the insert uses plain prisma (connection owner, bypasses FORCE RLS) like the
// lead form. Approve-first: lands as PENDING and is invisible publicly until the
// barber approves it. Rating 1-5 required; text + name optional. Anti-spam limit.
const reviewSchema = z
  .object({
    rating: z.coerce.number().int().min(1).max(5),
    body: z.string().trim().max(1000).optional().or(z.literal("")),
    authorName: z.string().trim().max(80).optional().or(z.literal("")),
  })
  .strict();

publicPageRouter.post("/:slug/review", leadLimiter, async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const slug = String(req.params.slug).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  // Anyone can review a LIVE page; no takesRequests gate. 404 a disabled page.
  if (!shop || !shop.publicPageEnabled) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const d = parsed.data;
  await prisma.review.create({
    data: {
      shopId: shop.id,
      rating: d.rating,
      body: d.body || null,
      authorName: d.authorName || null,
      // status defaults to PENDING - barber must approve before it shows.
    },
  });

  // Best-effort barber alert (same DRY_RUN-honoring path as the lead notify).
  if (shop.notifyPhone) {
    const who = d.authorName?.trim() || "A customer";
    const body = `New ${d.rating}-star review at ${shop.name} from ${who}. Approve it in your dashboard to publish.`;
    if (apiEnv().DRY_RUN) {
      logger.info({ shopId: shop.id, to: shop.notifyPhone }, "review notify SMS (dry-run, not sent)");
    } else {
      try {
        await getMessageProvider().send({ to: shop.notifyPhone, body });
      } catch (err) {
        logger.error({ err, shopId: shop.id }, "review notify SMS failed");
      }
    }
  }

  res.status(201).json({ ok: true });
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
    preview: previewNudgeBody(template, req.shop!.name, req.shop!.bookingUrl, req.shop!.industry),
  });
});

function serializeShop(shop: {
  id: string;
  name: string;
  timezone: string;
  industry: string;
  bookingUrl: string | null;
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
  galleryItems: unknown;
  fontKey: string | null;
  layoutStyle: string | null;
  sectionOrder: string[];
  rewardsWelcome: string | null;
  rewardsSections: string[];
  takesRequests: boolean;
  notifyPhone: string | null;
  loyaltyTextsEnabled: boolean;
  bookingMode: string;
  bookingLeadHours: number;
  bookingMaxDays: number;
  bookingBufferMin: number;
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
    gallery: readGallery(shop),
    fontKey: shop.fontKey,
    layoutStyle: shop.layoutStyle,
    sectionOrder: readSectionOrder(shop.sectionOrder),
    rewardsWelcome: shop.rewardsWelcome,
    rewardsSections: readRewardsSections(shop.rewardsSections),
    takesRequests: shop.takesRequests,
    notifyPhone: shop.notifyPhone,
    loyaltyTextsEnabled: shop.loyaltyTextsEnabled,
    bookingMode: shop.bookingMode,
    bookingLeadHours: shop.bookingLeadHours,
    bookingMaxDays: shop.bookingMaxDays,
    bookingBufferMin: shop.bookingBufferMin,
  };
}
