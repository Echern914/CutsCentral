import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  ACCENT_HEX_REGEX,
  BILLING,
  BOOKING_MODES,
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
  SLUG_REGEX,
  apiEnv,
  randomToken,
  type GalleryItem,
  type IndustryKey,
} from "@chairback/config";
import { Prisma, prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { linkReferralOnShopCreate } from "../services/referral.js";
import { previewNudgeBody } from "../messaging/templates.js";
import { toE164 } from "../acuity/clientKey.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendPushToUser } from "../messaging/push.js";
import { leadLimiter, waitlistLimiter } from "../middleware/rateLimit.js";
import {
  hasReceptionistEntitlement,
  receptionistEnabledForShop,
} from "../receptionist/config.js";
import { logger } from "../logger.js";

import { requireActiveAccess } from "../middleware/billing.js";
import {
  ANY_DATE_HORIZON_DAYS,
  ANY_WINDOW,
  MAX_WINDOWS,
  isValidTimezone,
  shopLocalDate,
  validateWindows,
} from "../engines/waitlistWindows.js";
import { addDaysToDateKey } from "../engines/waitlistMatch.js";
import {
  ACTIVE_WAITLIST_STATUSES,
  consentFields,
  joinFingerprint,
  mintCancelToken,
  sha256Hex,
} from "../engines/waitlistJoin.js";
import { resolveWaitlistClient } from "../engines/waitlistClientLink.js";
import { sendWaitlistConfirmation } from "../messaging/waitlistEmail.js";
import {
  CUSTOMER_ACTOR,
  recordWaitlistEvent,
  recordWaitlistEventBestEffort,
} from "../engines/waitlistAudit.js";
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
  // 🔴 The slug minted here MUST be legal and lowercase. This branch used to
  // call randomToken(), which is base64url and can contain UPPERCASE - and
  // every public resolver looks the slug up as `req.params.slug.toLowerCase()`
  // (routes/shops.ts x4, routes/booking.public.ts). A slug carrying a capital
  // therefore matches NOTHING: the mini-site, booking page, lead form and
  // waitlist all 404 forever, silently, and the barber cannot fix it by hand
  // either because SLUG_REGEX (`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`) rejects
  // what we minted.
  //
  // Only reachable once 98 shops share a name, which is why it hid for so long
  // - but the API suite reaches it routinely (it was the real cause of 16
  // failures across three unrelated files), and a popular real name would get
  // there eventually. See routes/shopSlugFallback.test.ts.
  return `${base}-${slugToken(6)}`;
}

/**
 * The random suffix for that fallback slug: strictly [a-z0-9], by construction.
 *
 * Lowercasing randomToken() is NOT enough. It is base64url, and that alphabet
 * also carries "-" and "_". "_" is illegal in a slug outright, and a "-" that
 * happens to land last fails SLUG_REGEX's final-character rule - so either one
 * mints exactly the unreachable page this fix exists to prevent, just less
 * often than uppercase did. Drawing from base36 makes an illegal slug
 * unrepresentable instead of unlikely.
 *
 * Rejecting bytes at or above 252 (36 x 7) keeps every character equally
 * likely; a plain modulo would quietly favour the first four letters.
 *
 * Exported ONLY so routes/shopSlugFallback.test.ts can assert the property
 * directly. The integration test mints one slug per run, so it can only catch
 * an illegal character when chance hands it one.
 */
export function slugToken(len: number): string {
  const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b >= 252) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === len) break;
    }
  }
  return out;
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
      .regex(ACCENT_HEX_REGEX, "Use a hex color like #D4AF37")
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
        SLUG_REGEX,
        "3-40 chars: letters, numbers, dashes (start and end with a letter or number)",
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
    // Where "Post it on Google" sends a reviewer. Any https URL: barbers paste
    // whatever their Google Business profile hands them (g.page/..., a maps
    // share link, the ?placeid= form), and we must not reject a valid one.
    googleReviewUrl: httpUrl(500).nullish().or(z.literal("")),
    hoursText: z.string().trim().max(400).nullish().or(z.literal("")),
    // Street address for the public page + LocalBusiness structured data.
    // Free-text on purpose (no geocoding dependency); "" clears a field.
    addressStreet: z.string().trim().max(200).nullish().or(z.literal("")),
    addressCity: z.string().trim().max(120).nullish().or(z.literal("")),
    addressRegion: z.string().trim().max(60).nullish().or(z.literal("")),
    addressPostal: z.string().trim().max(20).nullish().or(z.literal("")),
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
    // Waitlist: when on, the public booking page offers "Join the waitlist".
    waitlistEnabled: z.boolean(),
    // "A slot just opened" auto-notify to matching waitlisters (push + email).
    // Off by default; the barber's own alert doesn't need this. See slotOpened.ts.
    slotOpenedTextsEnabled: z.boolean(),
    // Request-before-booking: public native bookings land PENDING until approved.
    requireBookingApproval: z.boolean(),
    // Automatic appointment reminder PUSHES, per tier (24h / 2h before start).
    // Default ON (push is free; reminders are expected) - see pushReminders.ts.
    pushReminder24hEnabled: z.boolean(),
    pushReminder2hEnabled: z.boolean(),
    notifyPhone: z.string().max(40).nullish().or(z.literal("")),
    // Master rewards/loyalty switch (pure gate - balances survive toggling).
    // Default false for NEW shops; existing shops were backfilled true.
    rewardsEnabled: z.boolean(),
    // Transactional loyalty SMS to clients (earn/redeem confirmations). Off by
    // default; gated by client consent + quiet hours regardless. See
    // services/loyaltyNotify.ts.
    loyaltyTextsEnabled: z.boolean(),
    // Native booking engine. bookingMode picks the ONE active source; the bounds
    // shape the public slot picker (all interpreted in the shop's timezone).
    bookingMode: z.enum(BOOKING_MODES),
    bookingLeadHours: z.number().int().min(0).max(720),
    bookingMaxDays: z.number().int().min(1).max(365),
    bookingBufferMin: z.number().int().min(0).max(240),
    // Public booking menu: group cards first (only meaningful with groups).
    bookingGroupsFirst: z.boolean(),
    // Client rewards page content. rewardsWelcome: optional short greeting
    // ("" clears it). rewardsSections: visible REWARDS_SECTIONS keys (de-duped,
    // known keys only); [] = show all.
    rewardsWelcome: z.string().trim().max(REWARDS_WELCOME_MAX).nullish().or(z.literal("")),
    rewardsSections: z
      .array(z.enum(REWARDS_SECTION_KEYS as [string, ...string[]]))
      .max(REWARDS_SECTION_KEYS.length),
    // AI receptionist (paid add-on). Turning it ON the first time REQUIRES the
    // liability acknowledgment (acceptReceptionistTerms) - the barber accepts
    // that the AI can make scheduling mistakes and ChairBack isn't liable; the
    // acceptance is stamped once (receptionistTermsAcceptedAt) and enforced
    // again at runtime by receptionist/config.ts.
    receptionistEnabled: z.boolean(),
    receptionistTone: z.string().trim().max(120).nullish().or(z.literal("")),
    acceptReceptionistTerms: z.boolean(),
    // Custom singular visit-noun ("twist"); ""/null clears back to the industry
    // default. Lowercased - it reads mid-sentence in SMS copy; labels re-cap.
    serviceNoun: z.string().trim().toLowerCase().max(24).nullish().or(z.literal("")),
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
    // The owner's team seat. Ownership itself still comes from Shop.ownerId —
    // this row is what makes the owner appear on the Team roster alongside the
    // people they invite. Created here so a NEW shop matches what the
    // team-members migration backfilled for existing ones.
    await tx.shopMember.create({
      data: { shopId: created.id, userId: req.userId!, role: "OWNER" },
    });
    // Record the attestation on the owner if not already set (Google-path users
    // attest here; form-signup users were stamped at signup - don't overwrite).
    await tx.user.updateMany({
      where: { id: req.userId!, smsAttestedAt: null },
      data: { smsAttestedAt: new Date() },
    });
    return created;
  });
  // Referral attribution, AFTER the shop transaction commits. Deliberately not
  // inside it: a referral is a growth nicety and must never be able to fail
  // shop creation. It reads User.referralCode (the code this owner arrived
  // with, captured at signup) and, when that resolves to a real referrer,
  // records the referral and extends THIS shop's trial by a month. The referrer
  // is not paid until this shop's first invoice actually clears.
  const owner = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { referralCode: true },
  });
  const referred = await linkReferralOnShopCreate({
    shopId: shop.id,
    ownerId: req.userId!,
    code: owner?.referralCode,
  });
  // Re-read only when a referral actually landed, so the response carries the
  // extended trialEndsAt instead of the pre-referral value.
  const fresh = referred
    ? await prisma.shop.findUnique({ where: { id: shop.id } })
    : null;
  res.status(201).json(serializeShop(fresh ?? shop));
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

shopsRouter.patch("/me", requireUser, requireShop, requireActiveAccess, async (req, res) => {
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
  if (data.googleReviewUrl === "") data.googleReviewUrl = null;
  if (data.hoursText === "") data.hoursText = null;
  if (data.addressStreet === "") data.addressStreet = null;
  if (data.addressCity === "") data.addressCity = null;
  if (data.addressRegion === "") data.addressRegion = null;
  if (data.addressPostal === "") data.addressPostal = null;
  // Optional style keys: "" means "clear it" (fall back to the page default).
  if (data.fontKey === "") data.fontKey = null;
  if (data.layoutStyle === "") data.layoutStyle = null;
  // Rewards welcome: blank clears the custom line.
  if (data.rewardsWelcome === "") data.rewardsWelcome = null;
  // Custom visit-noun: blank clears back to the industry default.
  if (data.serviceNoun === "") data.serviceNoun = null;
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
  // AI receptionist: acceptReceptionistTerms isn't a Shop column - it stamps
  // receptionistTermsAcceptedAt (once, first acceptance wins). Enabling without
  // an acceptance on record is rejected: the barber must acknowledge that the
  // AI can make scheduling mistakes (double-bookings, misses) and that
  // ChairBack isn't liable for them, BEFORE the AI ever touches their calendar.
  // Enabling requires the ENTITLEMENT, checked before anything is stamped: a
  // free shop could previously flip the toggle ON, the UI showed it running,
  // and nothing ever answered a text - the worst kind of broken. Disabling
  // stays always allowed, and the helper returns true when billing is off
  // (dev/self-host), so this gate is inert outside real billing.
  if (data.receptionistEnabled === true && !hasReceptionistEntitlement(req.shop!)) {
    res.status(409).json({ error: "receptionist_not_entitled" });
    return;
  }
  const acceptedNow = data.acceptReceptionistTerms === true;
  delete data.acceptReceptionistTerms;
  if (data.receptionistTone === "") data.receptionistTone = null;
  const alreadyAccepted = req.shop!.receptionistTermsAcceptedAt !== null;
  if (acceptedNow && !alreadyAccepted) {
    data.receptionistTermsAcceptedAt = new Date();
  }
  if (data.receptionistEnabled === true && !alreadyAccepted && !acceptedNow) {
    res.status(400).json({ error: "receptionist_terms_required" });
    return;
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
// The "/-/" routes are registered BEFORE "/:slug" on purpose: express matches
// in order, and the "-" first segment can never be a real slug (SLUG_REGEX
// requires an alphanumeric start), so no shop handle can ever shadow them.
export const publicPageRouter: Router = Router();

// Resolve a custom domain to its shop slug - the web middleware's redirect
// lookup (cached there for 5 min). Only shops with a live public page resolve;
// a disabled page 404s the domain rather than redirecting to a dead page.
publicPageRouter.get("/-/by-domain/:host", async (req, res) => {
  const raw = String(req.params.host).toLowerCase().replace(/^www\./, "");
  // Same shape check the connect route enforces; garbage never hits the DB.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(raw)) {
    res.status(400).json({ error: "invalid_host" });
    return;
  }
  const shop = await prisma.shop.findUnique({
    where: { customDomain: raw },
    select: { slug: true, publicPageEnabled: true },
  });
  if (!shop || !shop.publicPageEnabled || !shop.slug) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ slug: shop.slug });
});

// Every live public page, for the web sitemap - the piece that makes shop
// pages DISCOVERABLE (nothing else on the crawlable web links /s/[slug], so
// without this Google may simply never find a shop). updatedAt gives crawlers
// a real lastModified signal.
publicPageRouter.get("/-/sitemap", async (_req, res) => {
  const shops = await prisma.shop.findMany({
    where: { publicPageEnabled: true, slug: { not: null } },
    select: { slug: true, updatedAt: true },
    orderBy: { createdAt: "asc" },
    // Far above the shop count for years; revisit pagination past ~40k shops
    // (the sitemap protocol's own cap is 50k URLs per file).
    take: 40_000,
  });
  res.json({
    shops: shops.map((s) => ({
      slug: s.slug,
      updatedAt: s.updatedAt.toISOString(),
    })),
  });
});

publicPageRouter.get("/:slug", async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  if (!shop || !shop.publicPageEnabled) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const now = new Date();
  const [rewards, approvedReviews, ratingAgg, promotions] = await Promise.all([
    // Rewards off = the public page simply has no rewards section (no empty
    // card, no dead copy) - everything else renders as usual.
    shop.rewardsEnabled
      ? prisma.reward.findMany({
          where: { shopId: shop.id, active: true },
          orderBy: [{ sortOrder: "asc" }, { punchCost: "asc" }],
          select: { id: true, name: true, description: true, emoji: true, punchCost: true },
        })
      : Promise.resolve([]),
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
    // For vertical-correct copy on the page + OG description ("book your next
    // cut" is wrong for a nail studio). serviceNoun is the shop's custom word
    // when set (see serviceNounForShop).
    industry: shop.industry,
    serviceNoun: shop.serviceNoun,
    // The shop's AI text line, for the "text us to book" block. Exposed ONLY
    // when a text would actually be answered: the same gate inbound.ts uses to
    // decide whether to reply, AND the shop owning its own number. A shop on
    // the shared platform line is deliberately excluded - inbound routing there
    // resolves the shop from the SENDER's phone, so a brand-new visitor (the
    // whole audience of this page) could not be routed and would text into
    // silence. Premium AI provisions a dedicated number on purchase.
    receptionistNumber:
      shop.twilioNumber && receptionistEnabledForShop(shop, { now })
        ? shop.twilioNumber
        : null,
    theme: shop.theme,
    logoUrl: shop.logoUrl,
    heroImageUrl: shop.heroImageUrl,
    accentColor: shop.accentColor,
    instagramHandle: shop.instagramHandle,
    googleReviewUrl: shop.googleReviewUrl,
    hoursText: shop.hoursText,
    // Street address for the page footer + LocalBusiness JSON-LD (local SEO).
    addressStreet: shop.addressStreet,
    addressCity: shop.addressCity,
    addressRegion: shop.addressRegion,
    addressPostal: shop.addressPostal,
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
    waitlistEnabled: shop.waitlistEnabled,
    punchesPerVisit: shop.punchesPerVisit,
    rewardsEnabled: shop.rewardsEnabled,
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

  // Best-effort barber alerts. A failed/absent notify must never fail the lead -
  // it's already saved and will show in the dashboard inbox.
  const contact = toE164(d.phone) ?? d.email ?? "no contact info";
  const note = d.message ? `: ${d.message}` : "";
  const body = `New appointment request at ${shop.name} from ${d.firstName} (${contact})${note}`;
  // SMS leg. Honors DRY_RUN so "no SMS sends" holds for EVERY outbound path,
  // not just the nudge engine - this texts the barber's own number, but it's
  // still a real (billable) send.
  if (shop.notifyPhone) {
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
  // Native-app leg: every device the owner registered in the iOS dashboard app.
  // No-op when none are registered; sendPushToUser honors DRY_RUN internally
  // and never throws.
  await sendPushToUser({
    userId: shop.ownerId,
    shopId: shop.id,
    payload: {
      title: "New appointment request",
      body,
      url: `${apiEnv().APP_BASE_URL}/dashboard/requests`,
      tag: "appt-request",
    },
  });

  res.status(201).json({ ok: true });
});

// Join the waitlist from the public booking page. UNauthenticated (slug resolves
// the shop). Same trust model as the lead form: plain-prisma insert (connection
// owner, bypasses FORCE RLS). serviceId/staffId are captured when the join comes
// from a fully-booked day so the barber knows exactly what the customer wants.
//
// 🔑 PREFERENCES ARE STRUCTURED NOW. This used to take `preferredTime` as free
// text ("Sat morning") for a human to read. That is unmatchable: the matcher in
// a later phase has to ask "does this freed 10:15 slot fit anyone", and no
// parser answers "whenever really". A window is a date part and a time part
// where NULL means ANY on each half independently - exactly the shape PR A
// migrated all 118 existing entries into, so they behave as they always did.
//
// preferredTime is still accepted and still stored: it is the barber-visible
// note on those live rows, and dropping it would blank their dashboard.
const windowSchema = z
  .object({
    startDate: z.string().trim().max(10).nullable().default(null),
    endDate: z.string().trim().max(10).nullable().default(null),
    startMin: z.number().int().min(0).max(1440).nullable().default(null),
    endMin: z.number().int().min(0).max(1440).nullable().default(null),
  })
  .strict();

const waitlistSchema = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().max(80).optional().or(z.literal("")),
    phone: z.string().trim().max(40).optional().or(z.literal("")),
    email: z.string().trim().email().max(200).optional().or(z.literal("")),
    serviceId: z.string().trim().max(60).optional().or(z.literal("")),
    staffId: z.string().trim().max(60).optional().or(z.literal("")),
    preferredTime: z.string().trim().max(200).optional().or(z.literal("")),
    note: z.string().trim().max(1000).optional().or(z.literal("")),
    // Absent = an older client, or a browser that could not tell us. The shop's
    // own zone is the fallback, which is what every existing row uses.
    timezone: z.string().trim().max(64).optional().or(z.literal("")),
    // Absent = one "Any date / Any time" window, i.e. exactly today's behaviour.
    windows: z.array(windowSchema).max(MAX_WINDOWS).optional(),
    // 🔴 Must be explicitly true. An absent field is NOT consent.
    smsConsent: z.boolean().optional().default(false),
  })
  .strict()
  .refine((d) => Boolean(d.phone?.trim()) || Boolean(d.email?.trim()), {
    message: "Provide a phone or email so they can reach you back.",
    path: ["phone"],
  });

publicPageRouter.post("/:slug/waitlist", waitlistLimiter, async (req, res) => {
  const parsed = waitlistSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const slug = String(req.params.slug).toLowerCase();
  const shop = await prisma.shop.findUnique({ where: { slug } });
  // 404 unless the page is live AND the barber turned the waitlist on.
  if (!shop || !shop.publicPageEnabled || !shop.waitlistEnabled) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const d = parsed.data;
  const now = new Date();

  // The customer's own zone decides what "Saturday morning" means. Anything
  // unparseable falls back to the shop's rather than 400-ing a join over a
  // browser quirk - a wrong-but-close zone still books haircuts.
  const timezone =
    d.timezone && isValidTimezone(d.timezone) ? d.timezone : shop.timezone;

  const windows = d.windows?.length ? d.windows : [ANY_WINDOW];
  // Validated against the SHOP's today: the horizon is about the shop's
  // calendar, not the customer's.
  const bad = validateWindows(windows, shopLocalDate(now, shop.timezone));
  if (bad) {
    res.status(400).json({ error: "invalid_window", code: bad.code, index: bad.index });
    return;
  }

  const phone = toE164(d.phone) ?? (d.phone?.trim() || null);
  const email = d.email || null;
  const serviceId = d.serviceId || null;
  const staffId = d.staffId || null;

  const dedupeKey = joinFingerprint({ phone, email, serviceId, staffId, windows });
  const { token, hash } = mintCancelToken();

  // 🔴 "Any Date" is a FIXED window, fixed NOW: [join date .. join date + 14]
  // in the customer's own zone - Acuity's "any opening in the next 14 days",
  // stored CONCRETE so matching only ever range-checks what was written here
  // and never re-derives eligibility from the offer moment. Past the stored
  // end date the entry stops matching; phase F marks it EXPIRED. From this
  // point on, NULL dates in storage exclusively mean the grandfathered
  // pre-materialization rows (the 118 backfilled + earlier joins), which stay
  // eligible until phase F's deliberate legacy policy.
  //
  // The dedupe fingerprint above deliberately hashed the RAW shape: "any
  // date" joined Monday and "any date" joined Tuesday are the SAME standing
  // request while one is active - materialized dates in the key would let
  // the same person re-join daily into multiple queue positions.
  const joinDate = shopLocalDate(now, timezone);
  const storedWindows = windows.map((w) =>
    w.startDate === null && w.endDate === null
      ? {
          ...w,
          startDate: joinDate,
          endDate: addDaysToDateKey(joinDate, ANY_DATE_HORIZON_DAYS),
        }
      : w,
  );

  try {
    // 🔑 One transaction so the entry and its audit row land together. The
    // audit write throws on failure by design (phase F1): a join we cannot
    // account for should not have happened. In practice the insert has no
    // constraints to violate, so the only thing that fails it is a database
    // outage - which was failing the join anyway.
    await prisma.$transaction(async (tx) => {
      // Who is this, if we can tell, and where do they sit in the queue?
      // One rule, stated once (engines/waitlistClientLink.ts): the single
      // non-archived client in this shop with this exact number. No link when
      // there is no number, no match, or more than one - a guess would
      // attribute one person's standing to another, and no link costs nothing
      // because the offer scan still falls back to the same phone lookup.
      //
      // 🔴 tierRank is READ HERE AND FROZEN. Reaching Gold tomorrow does not
      // move this row up today's queue; it counts the next time they join.
      const { clientId, tierRank } = await resolveWaitlistClient(tx, shop.id, phone);
      const entry = await tx.waitlistEntry.create({
        data: {
          shopId: shop.id,
          firstName: d.firstName,
          lastName: d.lastName || null,
          phone,
          email,
          clientId,
          tierRank,
          serviceId,
          staffId,
          preferredTime: d.preferredTime || null,
          note: d.note || null,
          timezone,
          dedupeKey,
          cancelTokenHash: hash,
          ...consentFields({ smsConsent: d.smsConsent, phone, now }),
          windows: {
            create: storedWindows.map((w) => ({
              shopId: shop.id,
              startDate: w.startDate,
              endDate: w.endDate,
              startMin: w.startMin,
              endMin: w.endMin,
            })),
          },
        },
        select: { id: true },
      });
      await recordWaitlistEvent(tx, {
        shopId: shop.id,
        entryId: entry.id,
        type: "entry.joined",
        actor: CUSTOMER_ACTOR,
        metadata: {
          source: "public",
          windowCount: storedWindows.length,
          // Whether the customer picked "Any date" and we fixed it to a
          // concrete 14-day span. A count and a flag - never the dates.
          anyDateMaterialized: windows.some(
            (w) => w.startDate === null && w.endDate === null,
          ),
          smsConsent: Boolean(d.smsConsent),
        },
      });
    });
  } catch (err) {
    // 🔑 The partial unique index did its job: this person already holds an
    // active place for this exact request. Answered as success rather than an
    // error - from the customer's side they ARE on the list, and telling them
    // otherwise invites a second tap that cannot succeed either.
    const dup =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if (dup) {
      logger.info({ shopId: shop.id }, "waitlist duplicate join ignored");
      // The collision names an entry we can identify - record the second
      // attempt against it. Best-effort and AFTER the response decision: the
      // customer is already on the list, so nothing here may change what they
      // are told. The extra read happens only on the duplicate path.
      const existing = await prisma.waitlistEntry
        .findFirst({
          where: { shopId: shop.id, dedupeKey, status: { in: [...ACTIVE_WAITLIST_STATUSES] } },
          select: { id: true },
        })
        .catch(() => null);
      if (existing) {
        await recordWaitlistEventBestEffort({
          shopId: shop.id,
          entryId: existing.id,
          type: "entry.join_deduped",
          actor: CUSTOMER_ACTOR,
          metadata: { source: "public", code: "already_waiting" },
        });
      }
      // 🔴 BYTE-IDENTICAL to a fresh join - same status, same body. Answering
      // 200 {duplicate:true} while a new join answered 201 {id,...} turned
      // this endpoint into an enumeration oracle: probe phone numbers, learn
      // who is on a shop's waitlist. The customer cannot tell either way, and
      // does not need to: they ARE on the list.
      res.status(201).json({ ok: true });
      return;
    }
    throw err;
  }

  // Best-effort barber alert (identical to the lead form). Never fails the join.
  const contact = phone ?? email ?? "no contact info";
  const body = `New waitlist join at ${shop.name} from ${d.firstName} (${contact})`;
  if (shop.notifyPhone) {
    if (apiEnv().DRY_RUN) {
      logger.info(
        { shopId: shop.id, to: shop.notifyPhone },
        "waitlist notify SMS (dry-run, not sent)",
      );
    } else {
      try {
        await getMessageProvider().send({ to: shop.notifyPhone, body });
      } catch (err) {
        logger.error({ err, shopId: shop.id }, "waitlist notify SMS failed");
      }
    }
  }
  await sendPushToUser({
    userId: shop.ownerId,
    shopId: shop.id,
    payload: {
      title: "New waitlist join",
      body,
      url: `${apiEnv().APP_BASE_URL}/dashboard/booking`,
      tag: "waitlist-join",
    },
  });

  // 🔴 EMAIL ONLY, and only when we have an address. Customer SMS stays off
  // until 10DLC clears. Joining by email alone must keep working, so the send
  // is never a precondition of the join succeeding.
  if (email) {
    await sendWaitlistConfirmation({
      to: email,
      firstName: d.firstName,
      shopName: shop.name,
      serviceLabel: null,
      // What was STORED, not what was typed: an Any-Date join reads back as
      // its real eligibility window, so the customer knows when it ends.
      windows: storedWindows,
      cancelToken: token,
    });
  }

  // Deliberately bare: see the duplicate branch above. `id` and `emailed`
  // would each be a tell, and the form needs neither - it knows whether it
  // supplied an email.
  res.status(201).json({ ok: true });
});

// Self-service cancellation from the emailed link. UNauthenticated by design:
// the token IS the credential, which is why only its sha256 is ever stored.
//
// 🔑 MARKS, NEVER DELETES. The row is the barber's record that someone wanted a
// slot, and the consent evidence hangs off it. REMOVED is an existing status
// the dashboard already understands.
publicPageRouter.post("/waitlist/cancel/:token", waitlistLimiter, async (req, res) => {
  const token = String(req.params.token ?? "");
  // Constant response whatever happens: this endpoint takes a bearer secret and
  // must not become an oracle for which tokens exist.
  if (!token || token.length > 200) {
    res.json({ ok: true });
    return;
  }
  // 🔑 The update alone cannot be audited: it matches on a global token hash
  // and updateMany returns only a count, so it never learns WHICH shop or
  // entry it just changed. One indexed read on the same hash supplies both,
  // inside the transaction so the row cannot move underneath us.
  const hash = sha256Hex(token);
  const { count, audited } = await prisma.$transaction(async (tx) => {
    const target = await tx.waitlistEntry.findFirst({
      where: { cancelTokenHash: hash, status: { in: [...ACTIVE_WAITLIST_STATUSES] } },
      select: { id: true, shopId: true, status: true },
    });
    const res = await tx.waitlistEntry.updateMany({
      where: {
        cancelTokenHash: hash,
        status: { in: [...ACTIVE_WAITLIST_STATUSES] },
      },
      // dedupeKey is cleared so the same person can rejoin for the same thing.
      // The partial index only covers active rows, but clearing it also stops a
      // cancelled row colliding if it is ever reactivated by hand.
      data: { status: "REMOVED", dedupeKey: null },
    });
    if (target && res.count > 0) {
      await recordWaitlistEvent(tx, {
        shopId: target.shopId,
        entryId: target.id,
        type: "entry.cancelled_by_customer",
        actor: CUSTOMER_ACTOR,
        metadata: { source: "cancel_link", fromStatus: target.status, toStatus: "REMOVED" },
      });
    }
    return { count: res.count, audited: Boolean(target) };
  });
  // Still no shop id in the log line - an unauthenticated endpoint holding a
  // bearer secret stays a constant, and `audited` says only whether we found
  // a row to attribute, which the count already implies.
  logger.info({ cancelled: count, audited }, "waitlist self-cancel");
  res.json({ ok: true });
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
shopsRouter.post("/me/sms-preview", requireUser, requireShop, requireActiveAccess, (req, res) => {
  const template = typeof req.body?.template === "string" ? req.body.template : null;
  res.json({
    preview: previewNudgeBody(
      template,
      req.shop!.name,
      req.shop!.bookingUrl,
      req.shop!.industry,
      req.shop!.serviceNoun,
    ),
  });
});

function serializeShop(shop: {
  id: string;
  name: string;
  timezone: string;
  industry: string;
  serviceNoun: string | null;
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
  googleReviewUrl: string | null;
  hoursText: string | null;
  addressStreet: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostal: string | null;
  galleryUrls: string[];
  galleryItems: unknown;
  fontKey: string | null;
  layoutStyle: string | null;
  sectionOrder: string[];
  rewardsWelcome: string | null;
  rewardsSections: string[];
  takesRequests: boolean;
  waitlistEnabled: boolean;
  slotOpenedTextsEnabled: boolean;
  requireBookingApproval: boolean;
  pushReminder24hEnabled: boolean;
  pushReminder2hEnabled: boolean;
  notifyPhone: string | null;
  rewardsEnabled: boolean;
  loyaltyTextsEnabled: boolean;
  bookingMode: string;
  bookingLeadHours: number;
  bookingMaxDays: number;
  bookingBufferMin: number;
  bookingGroupsFirst: boolean;
  receptionistEnabled: boolean;
  receptionistTone: string | null;
  receptionistTermsAcceptedAt: Date | null;
  aiTrialEndsAt: Date | null;
  receptionistSubscriptionStatus: string;
  receptionistCompAccess: boolean;
  twilioNumber: string | null;
}) {
  // Note: webhookSecret is intentionally NOT exposed to the client.
  return {
    id: shop.id,
    name: shop.name,
    timezone: shop.timezone,
    industry: shop.industry,
    serviceNoun: shop.serviceNoun,
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
    googleReviewUrl: shop.googleReviewUrl,
    hoursText: shop.hoursText,
    addressStreet: shop.addressStreet,
    addressCity: shop.addressCity,
    addressRegion: shop.addressRegion,
    addressPostal: shop.addressPostal,
    gallery: readGallery(shop),
    fontKey: shop.fontKey,
    layoutStyle: shop.layoutStyle,
    sectionOrder: readSectionOrder(shop.sectionOrder),
    rewardsWelcome: shop.rewardsWelcome,
    rewardsSections: readRewardsSections(shop.rewardsSections),
    takesRequests: shop.takesRequests,
    waitlistEnabled: shop.waitlistEnabled,
    slotOpenedTextsEnabled: shop.slotOpenedTextsEnabled,
    requireBookingApproval: shop.requireBookingApproval,
    pushReminder24hEnabled: shop.pushReminder24hEnabled,
    pushReminder2hEnabled: shop.pushReminder2hEnabled,
    notifyPhone: shop.notifyPhone,
    rewardsEnabled: shop.rewardsEnabled,
    loyaltyTextsEnabled: shop.loyaltyTextsEnabled,
    bookingMode: shop.bookingMode,
    bookingLeadHours: shop.bookingLeadHours,
    bookingMaxDays: shop.bookingMaxDays,
    bookingBufferMin: shop.bookingBufferMin,
    bookingGroupsFirst: shop.bookingGroupsFirst,
    receptionistEnabled: shop.receptionistEnabled,
    receptionistTone: shop.receptionistTone,
    receptionistTermsAcceptedAt: shop.receptionistTermsAcceptedAt?.toISOString() ?? null,
    // Entitlement summary for the settings UI (comp pilots or the $40/mo add-on).
    receptionistEntitled: hasReceptionistEntitlement(shop),
    // The shop's own text line (null = shared platform number).
    twilioNumber: shop.twilioNumber,
  };
}
