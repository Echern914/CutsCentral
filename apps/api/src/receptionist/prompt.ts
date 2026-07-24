import fs from "node:fs";
import path from "node:path";
import { apiEnv } from "@chairback/config";
import { forShop, prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Runtime loader + per-shop renderer for the receptionist's system prompt.
 *
 * The prompt file (ai/receptionist-prompt.md at the repo root) OWNS the voice,
 * the rules, and the example catalog - code never inlines the persona. This
 * module only (a) reads the file with an mtime cache so edits apply without a
 * restart, and (b) fills the {{PLACEHOLDER}} shop config per shop.
 *
 * The rendered prompt is deliberately BYTE-STABLE per shop (no dates/times in
 * here) so the Anthropic prompt cache can reuse it across turns; the current
 * date/time lives in the first user turn instead (see inbound.ts).
 */

const PROMPT_FILENAME = path.join("ai", "receptionist-prompt.md");

let cached: { filePath: string; mtimeMs: number; text: string } | null = null;

/**
 * Where the prompt file lives. RECEPTIONIST_PROMPT_PATH wins; otherwise walk up
 * from cwd until we find ai/receptionist-prompt.md (tsx dev runs from apps/api,
 * turbo/deploys may run from the repo root - never assume cwd).
 */
export function resolvePromptPath(): string | null {
  const override = apiEnv().RECEPTIONIST_PROMPT_PATH;
  if (override) return fs.existsSync(override) ? override : null;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, PROMPT_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Raw prompt file contents (mtime-cached). null = file missing/unreadable,
 * which callers treat as feature-off - a prompt problem must never crash the
 * Twilio webhook.
 */
export function loadPromptTemplate(): string | null {
  try {
    const filePath = resolvePromptPath();
    if (!filePath) {
      logger.warn("receptionist prompt file not found; feature off");
      return null;
    }
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    if (cached && cached.filePath === filePath && cached.mtimeMs === mtimeMs) {
      return cached.text;
    }
    const text = fs.readFileSync(filePath, "utf8");
    cached = { filePath, mtimeMs, text };
    return text;
  } catch (err) {
    logger.error({ err }, "receptionist prompt load failed; feature off");
    return null;
  }
}

/** Test seam: drop the mtime cache. */
export function __resetPromptCacheForTests(): void {
  cached = null;
}

export interface ShopPromptConfig {
  shopName: string;
  barberNames: string;
  otherBarber: string;
  address: string;
  timezone: string;
  hours: string;
  serviceMenu: string;
  bookingUrl: string;
  depositPolicy: string;
  cancellationPolicy: string;
  tone: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** 540 -> "9:00 AM" (minutes from local midnight). */
function fmtMinutes(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * Human-readable weekly hours from AvailabilityRule rows (shop-local minutes).
 * Multiple staff can have different hours; the receptionist only needs the
 * SHOP's open envelope, so we union the windows per weekday.
 */
function formatHours(
  rules: { weekday: number; startMin: number; endMin: number }[],
  fallback: string | null,
): string {
  if (rules.length === 0) return fallback ?? "not configured - check with the barber";
  const byDay = new Map<number, { start: number; end: number }>();
  for (const r of rules) {
    const cur = byDay.get(r.weekday);
    if (!cur) byDay.set(r.weekday, { start: r.startMin, end: r.endMin });
    else {
      cur.start = Math.min(cur.start, r.startMin);
      cur.end = Math.max(cur.end, r.endMin);
    }
  }
  const parts: string[] = [];
  for (let d = 0; d < 7; d++) {
    const w = byDay.get(d);
    if (w) parts.push(`${WEEKDAYS[d]} ${fmtMinutes(w.start)}-${fmtMinutes(w.end)}`);
  }
  return parts.join(", ");
}

/** "$35" / "$37.50"; null price -> "price varies". */
function fmtPrice(price: { toString(): string } | null): string {
  if (price === null) return "price varies";
  const n = Number(price.toString());
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * Gather one shop's config and render the prompt template. Returns null when
 * the file is missing (feature-off) - never throws.
 */
export async function renderPromptForShop(shopId: string): Promise<string | null> {
  const template = loadPromptTemplate();
  if (!template) return null;

  // Shop read via plain prisma (RLS default-deny inside runWithShop).
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      name: true,
      slug: true,
      timezone: true,
      hoursText: true,
      receptionistTone: true,
      paymentsMode: true,
      cancelWindowHours: true,
      cancelFeeBps: true,
      publicPageEnabled: true,
    },
  });
  if (!shop) return null;

  const db = forShop(shopId);
  const [staff, services, addOns, rules] = await Promise.all([
    db.staff.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { name: true },
    }),
    db.service.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, name: true, durationMin: true, price: true },
    }),
    // serviceIds [] = offered on EVERY service; non-empty = scoped to those.
    db.serviceAddOn.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: { serviceIds: true, name: true, durationMin: true, price: true },
    }),
    db.availabilityRule.findMany({
      select: { weekday: true, startMin: true, endMin: true },
    }),
  ]);

  const menuLines: string[] = [];
  for (const s of services) {
    menuLines.push(`${s.name} - ${fmtPrice(s.price)} (${s.durationMin} min)`);
    for (const a of addOns.filter((x) => x.serviceIds.includes(s.id))) {
      menuLines.push(
        `  + add-on: ${a.name} - ${fmtPrice(a.price)} (+${a.durationMin} min)`,
      );
    }
  }
  const shopWide = addOns.filter((x) => x.serviceIds.length === 0);
  if (shopWide.length > 0) {
    menuLines.push("Add-ons (any service):");
    for (const a of shopWide) {
      menuLines.push(`  + ${a.name} - ${fmtPrice(a.price)} (+${a.durationMin} min)`);
    }
  }

  const names = staff.map((s) => s.name);
  const cancellation =
    shop.cancelWindowHours > 0 && shop.cancelFeeBps > 0
      ? `free up to ${shop.cancelWindowHours}h before; inside that window ${(
          shop.cancelFeeBps / 100
        ).toFixed(0)}% of the price is kept as a fee`
      : "free cancellation any time before the appointment";
  const deposit =
    shop.paymentsMode === "ahead"
      ? "full payment collected at booking time"
      : shop.paymentsMode === "hold"
        ? "card authorized at booking, charged after the appointment"
        : "none - pay at the shop";

  const config: ShopPromptConfig = {
    shopName: shop.name,
    barberNames: names.length > 0 ? names.join(", ") : "the barber",
    otherBarber: names.length > 1 ? names[1]! : "another barber",
    address: "not listed - don't quote an address; the booking page has details",
    timezone: shop.timezone,
    hours: formatHours(rules, shop.hoursText),
    serviceMenu: menuLines.length > 0 ? menuLines.join("\n") : "not configured yet",
    bookingUrl:
      shop.publicPageEnabled && shop.slug
        ? `${apiEnv().APP_BASE_URL}/book/${shop.slug}`
        : "no online booking page - book through this conversation",
    depositPolicy: deposit,
    cancellationPolicy: cancellation,
    tone: shop.receptionistTone ?? "relaxed & friendly",
  };

  return renderTemplate(template, config);
}

/** Fill every {{PLACEHOLDER}}; exported for direct testing with fixtures. */
export function renderTemplate(template: string, config: ShopPromptConfig): string {
  const map: Record<string, string> = {
    SHOP_NAME: config.shopName,
    BARBER_NAMES: config.barberNames,
    OTHER_BARBER: config.otherBarber,
    ADDRESS: config.address,
    TIMEZONE: config.timezone,
    HOURS: config.hours,
    SERVICE_MENU: config.serviceMenu,
    BOOKING_URL: config.bookingUrl,
    DEPOSIT_POLICY: config.depositPolicy,
    CANCELLATION_POLICY: config.cancellationPolicy,
    TONE: config.tone,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
    // {{DOUBLE_BRACES}} in the file's own intro prose is documentation, not a
    // config slot - leave unknown tokens visible rather than guessing.
    return key in map ? map[key]! : whole;
  });
}
