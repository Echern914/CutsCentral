import fs from "node:fs";
import path from "node:path";
import {
  apiEnv,
  describeCancellationPolicy,
  describeDepositPolicy,
  describeNoShowPolicy,
} from "@chairback/config";
import {
  durationRangeForService,
  parseDateOverrides,
  priceRangeForService,
} from "../engines/pricing.js";
import { connectEnabled } from "../billing/stripe.js";
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
  firstBarber: string;
  otherBarberOffer: string;
  address: string;
  timezone: string;
  hours: string;
  serviceMenu: string;
  bookingUrl: string;
  depositPolicy: string;
  cancellationPolicy: string;
  noShowPolicy: string;
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
  hoursText: string | null,
): string {
  // The shop's own words used to be consulted ONLY when there were no rules,
  // so a shop that typed "closed 1-2 for lunch" AND had rules got its note
  // discarded by the receptionist while the public page showed it. Both now.
  const note = hoursText?.trim() ? ` (shop's own note: ${hoursText.trim()})` : "";
  if (rules.length === 0) {
    return hoursText?.trim() ? hoursText.trim() : "not configured - check with the barber";
  }
  const computed = formatRuleEnvelope(rules);
  return `${computed}${note}. These are the usual weekly hours - always check_availability for a specific day; holidays and days off are not listed here.`;
}

function formatRuleEnvelope(
  rules: { weekday: number; startMin: number; endMin: number }[],
): string {
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

/** "$35", or "$35-$55" when the price depends on the day or time. */
function fmtPriceRange(r: { min: number; max: number } | null): string {
  if (r === null) return "price varies";
  const one = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
  return r.min === r.max ? one(r.min) : `${one(r.min)}-${one(r.max)}`;
}

/** "30 min", or "30-45 min" when the length depends on the day or time. */
function fmtDurationRange(r: { min: number; max: number }): string {
  return r.min === r.max ? `${r.min} min` : `${r.min}-${r.max} min`;
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
      // The address the shop already publishes as LocalBusiness data. It used
      // to be hard-coded here as "not listed - don't quote an address", which
      // refused a top-five front-desk question the data could answer.
      addressStreet: true,
      addressCity: true,
      addressRegion: true,
      addressPostal: true,
      receptionistTone: true,
      paymentsMode: true,
      cancelWindowHours: true,
      cancelFeeBps: true,
      depositAmountCents: true,
      // CAPABILITY, not intent. paymentsMode says what the shop WANTS; these
      // say whether a card can actually be taken. A shop can sit in deposit
      // mode through all of Connect onboarding and collect nothing.
      connectChargesEnabled: true,
      stripeConnectAccountId: true,
      requireBookingApproval: true,
      publicPageEnabled: true,
    },
  });
  if (!shop) return null;

  const db = forShop(shopId);
  const [staff, services, addOns, rules] = await Promise.all([
    db.staff.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.service.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      // Every pricing layer, not just the base. The menu used to read
      // `price`/`durationMin` alone while the booking tool wrote the
      // day-adjusted figure - so on a Saturday the receptionist quoted $40
      // and its own booking saved $55, in one conversation.
      select: {
        id: true,
        name: true,
        durationMin: true,
        price: true,
        priceOverrides: true,
        durationOverrides: true,
        timeOverrides: true,
        dateOverrides: true,
      },
    }),
    // serviceIds [] = offered on EVERY service; non-empty = scoped to those.
    db.serviceAddOn.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: { serviceIds: true, name: true, durationMin: true, price: true },
    }),
    db.availabilityRule.findMany({
      select: { staffId: true, weekday: true, startMin: true, endMin: true },
    }),
  ]);

  // 🔴 ACTIVE staff only. Deactivating a barber soft-deletes them (the slot
  // engine ignores inactive staff, so their rules are never pruned). The
  // booking page filters to active staff; this did not, so a departed barber
  // who worked Sundays kept "Sun 9-5" in the receptionist's mouth forever.
  const activeStaffIds = new Set(staff.map((x) => x.id));
  const activeRules = rules.filter((r) => activeStaffIds.has(r.staffId));

  const menuLines: string[] = [];
  let anyDatePricing = false;
  for (const s of services) {
    const base = s.price === null ? null : Number(s.price);
    const priceRange = priceRangeForService(base, {
      weekdayOverrides: s.priceOverrides,
      timeWindows: s.timeOverrides,
    });
    const durationRange = durationRangeForService(s.durationMin, {
      weekdayOverrides: s.durationOverrides,
      timeWindows: s.timeOverrides,
    });
    if (Object.keys(parseDateOverrides(s.dateOverrides)).length > 0) anyDatePricing = true;
    menuLines.push(`${s.name} - ${fmtPriceRange(priceRange)} (${fmtDurationRange(durationRange)})`);
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
  if (menuLines.some((l) => l.includes("-") && /\$\d+-\$\d+|\d+-\d+ min/.test(l))) {
    menuLines.push(
      "A range means the price or length depends on the day or time - check_availability returns the exact figure for each slot; quote THAT, not the range.",
    );
  }
  if (anyDatePricing) {
    menuLines.push(
      "Some dates carry holiday pricing - the exact price for a slot comes back from check_availability.",
    );
  }

  const names = staff.map((s) => s.name);
  // These sentences live in @chairback/config/shopPolicy so the assistant can
  // answer "what is my cancellation policy?" from the SAME words the
  // receptionist quotes to a customer.
  //
  // 🔴 THE CHANNEL FLAG IS LOAD-BEARING. `book_appointment` in tools.ts writes
  // an Appointment and NO Payment - this conversation collects nothing, ever.
  // Without `collectsAtBooking: false` the receptionist tells an SMS customer
  // that a deposit is taken at booking and then takes none, which is the same
  // class of lie as the deposit-mode gap that put this code here, pointing the
  // other way.
  const policyShop = {
    ...shop,
    paymentsLive:
      connectEnabled() && shop.connectChargesEnabled && Boolean(shop.stripeConnectAccountId),
    requiresApproval: shop.requireBookingApproval,
  };
  const channel = { collectsAtBooking: false } as const;
  const cancellation = describeCancellationPolicy(policyShop, channel);
  const deposit = describeDepositPolicy(policyShop, channel);

  const noShow = describeNoShowPolicy(policyShop, channel);

  // The address, when the shop has published one. Street + city is the floor;
  // region and postal join when present. It is NOT on the booking page either,
  // so the old fallback's "the booking page has details" was wrong twice over.
  const addressParts = [
    shop.addressStreet?.trim(),
    shop.addressCity?.trim(),
    [shop.addressRegion?.trim(), shop.addressPostal?.trim()].filter(Boolean).join(" "),
  ].filter(Boolean);
  const address =
    shop.addressStreet?.trim() && shop.addressCity?.trim()
      ? addressParts.join(", ")
      : "not listed - the shop hasn't published one; don't guess";

  const config: ShopPromptConfig = {
    shopName: shop.name,
    barberNames: names.length > 0 ? names.join(", ") : "the barber",
    // The one name the catalog uses in the assistant's own voice ("I'll let
    // {{FIRST_BARBER}} know"). Was hard-coded "Drick" in fifteen example turns,
    // which every other shop's receptionist then learned to say.
    firstBarber: names[0] ?? "the barber",
    // 🔴 An OFFER, not a name. At a one-chair shop the old {{OTHER_BARBER}}
    // rendered "or another barber has spots this week?" - offering staff that
    // do not exist. Solo shops now get an empty string and the sentence
    // simply ends.
    otherBarberOffer: names.length > 1 ? ` or ${names[1]!} has spots this week?` : "",
    address,
    timezone: shop.timezone,
    hours: formatHours(activeRules, shop.hoursText),
    serviceMenu: menuLines.length > 0 ? menuLines.join("\n") : "not configured yet",
    bookingUrl:
      shop.publicPageEnabled && shop.slug
        ? `${apiEnv().APP_BASE_URL}/book/${shop.slug}`
        : "no online booking page - book through this conversation",
    depositPolicy: deposit,
    cancellationPolicy: cancellation,
    noShowPolicy: noShow,
    tone: shop.receptionistTone ?? "relaxed & friendly",
  };

  return renderTemplate(template, config);
}

/** Fill every {{PLACEHOLDER}}; exported for direct testing with fixtures. */
export function renderTemplate(template: string, config: ShopPromptConfig): string {
  const map: Record<string, string> = {
    SHOP_NAME: config.shopName,
    BARBER_NAMES: config.barberNames,
    FIRST_BARBER: config.firstBarber,
    OTHER_BARBER_OFFER: config.otherBarberOffer,
    ADDRESS: config.address,
    TIMEZONE: config.timezone,
    HOURS: config.hours,
    SERVICE_MENU: config.serviceMenu,
    BOOKING_URL: config.bookingUrl,
    DEPOSIT_POLICY: config.depositPolicy,
    CANCELLATION_POLICY: config.cancellationPolicy,
    NO_SHOW_POLICY: config.noShowPolicy,
    TONE: config.tone,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => {
    // {{DOUBLE_BRACES}} in the file's own intro prose is documentation, not a
    // config slot - leave unknown tokens visible rather than guessing.
    return key in map ? map[key]! : whole;
  });
}
