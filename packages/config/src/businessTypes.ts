/**
 * The business-type registry: the ONE source of truth for the words the product
 * speaks to a shop and its customers.
 *
 * ChairBack started barber-first and still sells hardest there, but a nail tech,
 * a lash artist and an auto detailer run the same shape of business. Rather than
 * fork the product, every vertical-flavored noun lives here and every
 * customer-facing surface resolves through `vocabularyForShop`.
 *
 * 🔴 PRESENTATION ONLY. Nothing in this file may be read by authorization,
 * billing, entitlement, tenant scoping, feature flags, retention or integration
 * behavior. Business type decides what a surface CALLS things, never what a seat
 * is allowed to do. `vocabularyLint.test.ts` asserts this mechanically.
 *
 * Storage: the stable id lives in `Shop.industry` (TEXT, not a Prisma enum) so a
 * new vertical is a code change with no migration. `Shop.businessTypeSelectedAt`
 * records whether a human actually CHOSE it - see `vocabularyForShop`.
 */

/**
 * HAND-WRITTEN union - deliberately not `keyof typeof BUSINESS_TYPES`.
 *
 * Inferring the ids from the object would make the two agree by construction and
 * pin nothing. Writing them out means `satisfies Record<BusinessTypeId, ...>`
 * below fails the BUILD when an id is added without an entry, which is the whole
 * point: adding a vertical must be impossible to half-finish.
 */
export type BusinessTypeId =
  | "barber"
  | "salon"
  | "nails"
  | "lashes"
  | "multiservice"
  | "spa"
  | "tattoo"
  | "detailing"
  | "other";

/**
 * Every vertical-flavored word the product speaks, resolved per shop.
 *
 * Plurals are authored rather than derived: "nail tech" -> "nail techs" is naive
 * enough to guess, but the moment a vertical needs "stylists"/"people" or an
 * irregular the guess is wrong in customer-facing copy, and a wrong plural reads
 * as a bug rather than a rough edge.
 */
export interface BusinessVocabulary {
  /** One visit, singular: "cut" | "appointment" | "session" | "detail" | "visit". */
  serviceNoun: string;
  serviceNounPlural: string;
  /** Who performs the work: "barber" | "stylist" | "nail tech" | "detailer". */
  providerNoun: string;
  providerNounPlural: string;
  /** Where the work happens: "chair" | "station" | "room" | "bay" | "workspace". */
  stationNoun: string;
  stationNounPlural: string;
  /** The business itself: "barbershop" | "salon" | "studio" | "shop" | "business". */
  businessNoun: string;
  /** Who receives the work: "client" | "guest" | "customer". */
  clientNoun: string;
  clientNounPlural: string;
}

/**
 * A suggested service for a vertical.
 *
 * 🔴 TEMPLATES ONLY. Nothing in the product may create a Service from one of
 * these without an explicit per-row confirmation from the owner. A shop's own
 * service names are theirs; we never write, rename or reconcile them.
 */
export interface ServiceTemplate {
  /** Stable across renames so a test manifest can pin it. */
  id: string;
  name: string;
  durationMin: number;
  /** null = "you set the price" rather than a guess we'd be wrong about. */
  priceCents: number | null;
  note?: string;
}

export interface BusinessType {
  id: BusinessTypeId;
  /** Picker label + settings label. */
  label: string;
  /** One line under the label, to disambiguate neighbours in the picker. */
  tagline: string;
  emoji: string;
  /**
   * false retires a type from the NEW-shop picker WITHOUT breaking shops already
   * on it - their vocabulary keeps resolving. Never delete an id.
   */
  selectable: boolean;
  vocabulary: BusinessVocabulary;
  /** Seeds the shop's FIRST loyalty reward at signup. Never re-seeded on change. */
  defaultReward: { name: string; emoji: string };
  /**
   * schema.org @type for the public shop page's JSON-LD. A wrong type costs rich
   * results, so each is a real schema.org LocalBusiness subtype (pinned by test).
   */
  schemaType: string;
  /** /for/<slug> landing page, or null when the vertical has no page yet. */
  marketingSlug: string | null;
  serviceTemplates: ServiceTemplate[];
  /** Onboarding copy only ("most shops rebook every ~3 weeks"). Never engine behavior. */
  typicalRebookDays: number;
}

export const BUSINESS_TYPES = {
  barber: {
    id: "barber",
    label: "Barbershop",
    tagline: "Cuts, fades and beard work, walk-ins or by appointment",
    emoji: "💈",
    selectable: true,
    vocabulary: {
      serviceNoun: "cut",
      serviceNounPlural: "cuts",
      providerNoun: "barber",
      providerNounPlural: "barbers",
      stationNoun: "chair",
      stationNounPlural: "chairs",
      businessNoun: "barbershop",
      clientNoun: "client",
      clientNounPlural: "clients",
    },
    defaultReward: { name: "Free Cut", emoji: "✂️" },
    schemaType: "BarberShop",
    marketingSlug: "barbers",
    serviceTemplates: [
      { id: "barber.haircut", name: "Haircut", durationMin: 30, priceCents: null },
      { id: "barber.skin_fade", name: "Skin Fade", durationMin: 45, priceCents: null },
      { id: "barber.cut_beard", name: "Cut & Beard", durationMin: 45, priceCents: null },
      { id: "barber.lineup", name: "Line-Up", durationMin: 15, priceCents: null },
      { id: "barber.kids_cut", name: "Kids Cut", durationMin: 30, priceCents: null },
    ],
    typicalRebookDays: 21,
  },
  salon: {
    id: "salon",
    label: "Hair Salon",
    tagline: "Cutting, coloring and styling for a salon or an independent stylist",
    emoji: "💇",
    selectable: true,
    vocabulary: {
      serviceNoun: "appointment",
      serviceNounPlural: "appointments",
      providerNoun: "stylist",
      providerNounPlural: "stylists",
      stationNoun: "station",
      stationNounPlural: "stations",
      businessNoun: "salon",
      clientNoun: "client",
      clientNounPlural: "clients",
    },
    defaultReward: { name: "Free Blowout", emoji: "💇" },
    schemaType: "HairSalon",
    marketingSlug: "salons",
    serviceTemplates: [
      { id: "salon.cut_style", name: "Cut & Style", durationMin: 60, priceCents: null },
      { id: "salon.blowout", name: "Blowout", durationMin: 45, priceCents: null },
      { id: "salon.root_touch_up", name: "Root Touch-Up", durationMin: 90, priceCents: null },
      { id: "salon.balayage", name: "Balayage", durationMin: 180, priceCents: null },
      { id: "salon.treatment", name: "Deep Conditioning Treatment", durationMin: 30, priceCents: null },
    ],
    typicalRebookDays: 42,
  },
  nails: {
    id: "nails",
    label: "Nail Studio",
    tagline: "Manicures, pedicures and enhancements for a studio or a solo nail tech",
    emoji: "💅",
    selectable: true,
    vocabulary: {
      serviceNoun: "appointment",
      serviceNounPlural: "appointments",
      providerNoun: "nail tech",
      providerNounPlural: "nail techs",
      stationNoun: "station",
      stationNounPlural: "stations",
      businessNoun: "studio",
      clientNoun: "client",
      clientNounPlural: "clients",
    },
    defaultReward: { name: "Free Manicure", emoji: "💅" },
    schemaType: "NailSalon",
    marketingSlug: "nails",
    serviceTemplates: [
      { id: "nails.gel_manicure", name: "Gel Manicure", durationMin: 60, priceCents: null },
      { id: "nails.full_set", name: "Acrylic Full Set", durationMin: 90, priceCents: null },
      { id: "nails.fill", name: "Fill", durationMin: 60, priceCents: null },
      { id: "nails.pedicure", name: "Pedicure", durationMin: 60, priceCents: null },
      { id: "nails.nail_art", name: "Nail Art (per nail)", durationMin: 15, priceCents: null },
    ],
    typicalRebookDays: 21,
  },
  lashes: {
    id: "lashes",
    label: "Lash & Brow Studio",
    tagline: "Extensions, lifts, tints and brow shaping",
    emoji: "👁️",
    selectable: true,
    vocabulary: {
      serviceNoun: "appointment",
      serviceNounPlural: "appointments",
      providerNoun: "lash artist",
      providerNounPlural: "lash artists",
      stationNoun: "station",
      stationNounPlural: "stations",
      businessNoun: "studio",
      clientNoun: "client",
      clientNounPlural: "clients",
    },
    defaultReward: { name: "Free Lash Fill", emoji: "👁️" },
    schemaType: "BeautySalon",
    marketingSlug: "lashes",
    serviceTemplates: [
      { id: "lashes.classic_full", name: "Classic Full Set", durationMin: 120, priceCents: null },
      { id: "lashes.volume_full", name: "Volume Full Set", durationMin: 150, priceCents: null },
      { id: "lashes.fill_2wk", name: "2-Week Fill", durationMin: 60, priceCents: null },
      { id: "lashes.lift_tint", name: "Lash Lift & Tint", durationMin: 60, priceCents: null },
      { id: "lashes.brow_shaping", name: "Brow Shaping", durationMin: 30, priceCents: null },
    ],
    typicalRebookDays: 21,
  },
  multiservice: {
    id: "multiservice",
    label: "Multi-Service Salon",
    tagline: "Hair, nails, skin and more under one roof",
    emoji: "✨",
    selectable: true,
    vocabulary: {
      serviceNoun: "appointment",
      serviceNounPlural: "appointments",
      providerNoun: "professional",
      providerNounPlural: "professionals",
      stationNoun: "station",
      stationNounPlural: "stations",
      businessNoun: "salon",
      clientNoun: "client",
      clientNounPlural: "clients",
    },
    defaultReward: { name: "Free Add-On Service", emoji: "✨" },
    schemaType: "BeautySalon",
    // No landing page yet - PR 3 adds the slug and its copy together, so this
    // never points at a 404.
    marketingSlug: null,
    serviceTemplates: [
      { id: "multiservice.cut_style", name: "Cut & Style", durationMin: 60, priceCents: null },
      { id: "multiservice.color", name: "Color", durationMin: 120, priceCents: null },
      { id: "multiservice.gel_manicure", name: "Gel Manicure", durationMin: 60, priceCents: null },
      { id: "multiservice.facial", name: "Facial", durationMin: 60, priceCents: null },
      { id: "multiservice.waxing", name: "Waxing", durationMin: 30, priceCents: null },
    ],
    typicalRebookDays: 30,
  },
  spa: {
    id: "spa",
    label: "Spa & Skincare",
    tagline: "Facials, massage and body treatments",
    emoji: "🧖",
    selectable: true,
    vocabulary: {
      serviceNoun: "appointment",
      serviceNounPlural: "appointments",
      providerNoun: "esthetician",
      providerNounPlural: "estheticians",
      stationNoun: "room",
      stationNounPlural: "rooms",
      businessNoun: "spa",
      clientNoun: "guest",
      clientNounPlural: "guests",
    },
    defaultReward: { name: "Free Facial Add-On", emoji: "🧖" },
    schemaType: "DaySpa",
    marketingSlug: "spas",
    serviceTemplates: [
      { id: "spa.signature_facial", name: "Signature Facial", durationMin: 60, priceCents: null },
      { id: "spa.deep_cleanse", name: "Deep Cleansing Facial", durationMin: 75, priceCents: null },
      { id: "spa.massage_60", name: "60-Minute Massage", durationMin: 60, priceCents: null },
      { id: "spa.body_treatment", name: "Body Treatment", durationMin: 90, priceCents: null },
      { id: "spa.chemical_peel", name: "Chemical Peel", durationMin: 45, priceCents: null },
    ],
    typicalRebookDays: 42,
  },
  tattoo: {
    id: "tattoo",
    label: "Tattoo & Piercing",
    tagline: "Custom work, flash and piercings, by consultation or session",
    emoji: "🖋️",
    selectable: true,
    vocabulary: {
      serviceNoun: "session",
      serviceNounPlural: "sessions",
      providerNoun: "artist",
      providerNounPlural: "artists",
      stationNoun: "station",
      stationNounPlural: "stations",
      businessNoun: "studio",
      clientNoun: "client",
      clientNounPlural: "clients",
    },
    defaultReward: { name: "$25 Off Next Session", emoji: "🖋️" },
    schemaType: "TattooParlor",
    marketingSlug: "tattoo",
    serviceTemplates: [
      { id: "tattoo.consultation", name: "Consultation", durationMin: 30, priceCents: null },
      { id: "tattoo.small_piece", name: "Small Piece", durationMin: 60, priceCents: null },
      { id: "tattoo.half_day", name: "Half-Day Session", durationMin: 240, priceCents: null },
      { id: "tattoo.full_day", name: "Full-Day Session", durationMin: 480, priceCents: null },
      { id: "tattoo.piercing", name: "Piercing", durationMin: 30, priceCents: null },
    ],
    typicalRebookDays: 90,
  },
  detailing: {
    id: "detailing",
    label: "Auto Detailing",
    tagline: "Interior, exterior and paint correction, in a bay or mobile",
    emoji: "🚗",
    selectable: true,
    vocabulary: {
      serviceNoun: "detail",
      serviceNounPlural: "details",
      providerNoun: "detailer",
      providerNounPlural: "detailers",
      stationNoun: "bay",
      stationNounPlural: "bays",
      businessNoun: "shop",
      // A car owner is a customer, not a "guest" and not a salon "client".
      clientNoun: "customer",
      clientNounPlural: "customers",
    },
    defaultReward: { name: "Free Interior Detail", emoji: "🚗" },
    schemaType: "AutoWash",
    // No landing page yet - PR 3 adds the slug and its copy together.
    marketingSlug: null,
    serviceTemplates: [
      { id: "detailing.express_wash", name: "Express Wash & Wax", durationMin: 60, priceCents: null },
      { id: "detailing.interior", name: "Interior Detail", durationMin: 120, priceCents: null },
      { id: "detailing.full", name: "Full Detail", durationMin: 240, priceCents: null },
      { id: "detailing.paint_correction", name: "Paint Correction", durationMin: 480, priceCents: null },
      { id: "detailing.ceramic_coating", name: "Ceramic Coating", durationMin: 480, priceCents: null },
    ],
    typicalRebookDays: 90,
  },
  other: {
    id: "other",
    label: "Other service business",
    tagline: "Appointments, loyalty and rebooking for any service business",
    emoji: "⭐",
    selectable: true,
    // 🔴 This doubles as NEUTRAL_VOCABULARY - the fallback every shop that has
    // not chosen a type renders with. Deliberately plain: no "cosmetologist"
    // (an auto detailer is not one), no "guest", no "salon". `serviceNoun` must
    // stay "visit" - it is what ships today and is pinned by constants.test.ts
    // and templates.test.ts, so widening the registry changes zero live copy.
    vocabulary: {
      serviceNoun: "visit",
      serviceNounPlural: "visits",
      providerNoun: "provider",
      providerNounPlural: "providers",
      stationNoun: "workspace",
      stationNounPlural: "workspaces",
      businessNoun: "business",
      clientNoun: "client",
      clientNounPlural: "clients",
    },
    defaultReward: { name: "Free Service", emoji: "⭐" },
    schemaType: "LocalBusiness",
    marketingSlug: null,
    serviceTemplates: [],
    typicalRebookDays: 30,
  },
} as const satisfies Record<BusinessTypeId, BusinessType>;

/**
 * Picker order. Pinned exactly by `businessTypes.test.ts` so a reorder is a
 * deliberate edit rather than a side effect of adding an entry.
 */
export const BUSINESS_TYPE_IDS = Object.keys(BUSINESS_TYPES) as BusinessTypeId[];

/** The ids a NEW shop may choose (see `BusinessType.selectable`). */
export const SELECTABLE_BUSINESS_TYPE_IDS = BUSINESS_TYPE_IDS.filter(
  (id) => BUSINESS_TYPES[id].selectable,
);

/**
 * The vocabulary a shop renders when it has NOT chosen a business type.
 *
 * Legacy shops predate the picker, so their stored `industry` is a DEFAULT, not
 * an answer. They must render something complete and correct - never blanks, and
 * never barbershop words they never asked for.
 */
export const NEUTRAL_VOCABULARY: BusinessVocabulary = BUSINESS_TYPES.other.vocabulary;

/**
 * The `/for/<slug>` pages that exist. Deriving the literal union (rather than
 * `string`) is what lets the marketing copy table be
 * `satisfies Record<MarketingSlug, VerticalCopy>` - so giving a type a slug
 * without writing its landing page fails the build instead of 404ing.
 */
export type MarketingSlug = NonNullable<
  (typeof BUSINESS_TYPES)[BusinessTypeId]["marketingSlug"]
>;

/** Landing-page slugs, derived so `sitemap.ts` can never drift from the registry. */
export const MARKETING_SLUGS = BUSINESS_TYPE_IDS.map(
  (id) => BUSINESS_TYPES[id].marketingSlug,
).filter((slug): slug is MarketingSlug => slug !== null);

export function isBusinessTypeId(value: unknown): value is BusinessTypeId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BUSINESS_TYPES, value);
}

/**
 * The registry entry for a stored id, falling back to `other` for anything
 * unknown, empty or forged. Never throws: a bad value in one shop's row must not
 * be able to 500 a page.
 */
export function businessType(id: string | null | undefined): BusinessType {
  return isBusinessTypeId(id) ? BUSINESS_TYPES[id] : BUSINESS_TYPES.other;
}

/** The vocabulary for a stored id, neutral for anything unknown. */
export function vocabularyFor(id: string | null | undefined): BusinessVocabulary {
  return businessType(id).vocabulary;
}

/**
 * THE resolver. One shop row in, one plain vocabulary out.
 *
 * Order matters:
 *  1. `businessTypeSelectedAt` null/absent => NEUTRAL, ignoring the stored
 *     `industry` ENTIRELY. That is the whole legacy answer: a value nobody chose
 *     is not a classification, so we decline to speak as if it were.
 *  2. otherwise the chosen type's vocabulary (unknown ids still fall neutral).
 *  3. the owner's custom `Shop.serviceNoun` ("twist", "gloss") laid over the top.
 *
 * Returns a plain object, deliberately: it crosses the RSC boundary and the wire
 * with no ceremony. Not a class, not a proxy, nothing to serialize around.
 */
export function vocabularyForShop(shop: {
  industry?: string | null;
  serviceNoun?: string | null;
  businessTypeSelectedAt?: Date | string | null;
}): BusinessVocabulary {
  const chose = shop.businessTypeSelectedAt != null;
  const base = chose ? vocabularyFor(shop.industry) : NEUTRAL_VOCABULARY;
  const custom = shop.serviceNoun?.trim();
  if (!custom) return base;
  return { ...base, serviceNoun: custom, serviceNounPlural: naivePlural(custom) };
}

/** Naive plural for UI labels ("cut" -> "cuts"); words already ending in s stay. */
export function naivePlural(noun: string): string {
  return noun.endsWith("s") ? noun : `${noun}s`;
}

/**
 * Exhaustiveness guard for the rare surface that genuinely branches per type.
 * Prefer reading a vocabulary field; reach for this only when behavior (not
 * wording) differs, and it will fail the build the moment an id is added.
 */
export function assertNeverBusinessType(value: never): never {
  throw new Error(`unhandled business type: ${String(value)}`);
}
