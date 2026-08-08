/**
 * The feature directory. One entry per barber-visible capability: where it
 * lives (`href`, always a dashboard page or the /demo tour entry) and, when
 * the feature is something their CLIENTS see, which live-demo step shows it
 * (`tourStepId` → DEMO_TOUR_STEPS, rendered as a "see it live" action).
 *
 * TWO surfaces render this list, so every entry needs to read well both ways:
 *  - the search palette (Ctrl/Cmd-K), which matches on name/synonyms
 *  - the "More" tab, which browses the whole index grouped by `category`
 *
 * Matching is intentionally simple (name/synonym includes) — keep synonyms
 * generous: they're the words a barber would actually type.
 */

/**
 * Grouping for the "More" tab, which renders the whole index as a browsable
 * directory rather than a search-only palette. Ordered by what a barber cares
 * about soonest: filling the chair, then getting paid, then everything else.
 * Names are outcomes ("Get booked"), not nouns ("Booking") - the tab is also
 * how a barber DISCOVERS a feature they didn't know they had.
 */
export type FeatureCategoryId =
  | "booking"
  | "money"
  | "retention"
  | "brand"
  | "data"
  | "account";

export interface FeatureCategory {
  id: FeatureCategoryId;
  name: string;
  description: string;
}

/** Render order for the More tab. Every FeatureCategoryId appears exactly once. */
export const FEATURE_CATEGORIES: FeatureCategory[] = [
  {
    id: "booking",
    name: "Get booked",
    description: "Everything that turns an open chair into an appointment",
  },
  {
    id: "money",
    name: "Get paid",
    description: "Take payment your way, and manage your own plan",
  },
  {
    id: "retention",
    name: "Keep them coming back",
    description: "Loyalty, promos, and automatic nudges for lapsed clients",
  },
  {
    id: "brand",
    name: "Your brand",
    description: "The page, the look, and the proof clients see first",
  },
  {
    id: "data",
    name: "Know your shop",
    description: "Your client book and the numbers behind it",
  },
  {
    id: "account",
    name: "Account & help",
    description: "Your login, the AI receptionist, and guided walkthroughs",
  },
];

export interface FeatureIndexEntry {
  id: string;
  name: string;
  synonyms: string[];
  description: string;
  /** Primary destination — must start with /dashboard or /demo. */
  href: string;
  /** Which FEATURE_CATEGORIES group this shows under in the More tab. */
  category: FeatureCategoryId;
  /** Optional DEMO_TOUR_STEPS id showing this feature in the live demo. */
  tourStepId?: string;
  /**
   * Plan that unlocks this feature for shops whose access has LAPSED.
   * "pro" locks when billing hasAccess is false; "pro_ai" additionally
   * requires the receptionist entitlement. Untagged = free forever.
   *
   * Tag ONLY features the API genuinely refuses to free shops (402/409/cron
   * skip). Marketing says more is premium than the server enforces — a badge
   * on a feature that actually works free is a lie that cheapens the real
   * locks. NEVER derive a lock from plan === "free": trialing shops are
   * plan "free" WITH full access, and comped shops are free forever.
   */
  tier?: "pro" | "pro_ai";
}

/**
 * App Store 3.1.1: anything landing on the billing page is a purchase back
 * door inside the native shell. The ONE predicate every surface filters with
 * (FeatureSearch, the More sheet, and the help corpus used to carry three
 * subtly different copies of this rule).
 */
export function isBillingHref(href: string): boolean {
  return href.startsWith("/dashboard/billing");
}

export const FEATURE_INDEX: FeatureIndexEntry[] = [
  {
    id: "mini-site",
    name: "Public shop page",
    synonyms: ["mini site", "website", "landing page", "shop link", "page"],
    description: "Your own booking mini-site clients open from a link",
    href: "/dashboard/site",
    category: "brand",
    tourStepId: "shop-hero",
  },
  {
    id: "themes",
    name: "Themes, fonts & branding",
    synonyms: ["theme", "colors", "fonts", "accent", "logo", "branding", "style"],
    description: "Make your page and rewards hub look like YOUR shop",
    href: "/dashboard/site",
    category: "brand",
    tourStepId: "shop-hero",
  },
  {
    id: "gallery",
    name: "Photo gallery",
    synonyms: ["photos", "pictures", "portfolio", "work", "images"],
    description: "Show off your cuts on the public page",
    href: "/dashboard/site",
    category: "brand",
    tourStepId: "shop-hero",
  },
  {
    id: "promotions",
    name: "Promotions",
    synonyms: ["promo", "deals", "specials", "discount", "sale", "offer"],
    description: "Run specials that show on your page and can be texted out",
    href: "/dashboard/promotions",
    category: "retention",
    tier: "pro",
    tourStepId: "shop-promotions",
  },
  {
    id: "reviews",
    name: "Reviews",
    synonyms: ["ratings", "stars", "testimonials", "feedback"],
    description: "Clients review on your page; you approve what shows",
    href: "/dashboard/reviews",
    category: "brand",
    tourStepId: "shop-reviews",
  },
  {
    id: "online-booking",
    name: "Online booking",
    synonyms: ["book", "booking", "appointments", "scheduling", "calendar", "agenda"],
    description: "Your own booking engine — services, staff, hours, agenda",
    href: "/dashboard/booking",
    category: "booking",
    tourStepId: "shop-book-cta",
  },
  {
    id: "staff",
    name: "Staff & providers",
    synonyms: ["barbers", "team", "providers", "employees", "chairs"],
    description: "Multiple barbers, each with their own services and hours",
    href: "/dashboard/booking?tab=Staff",
    category: "booking",
  },
  {
    id: "services",
    name: "Services & pricing",
    synonyms: ["menu", "prices", "haircut", "service list", "duration"],
    description: "Your service menu with durations and prices",
    href: "/dashboard/booking?tab=Services",
    category: "booking",
    tourStepId: "book-services",
  },
  {
    id: "day-pricing",
    name: "Day-specific pricing & durations",
    synonyms: ["saturday price", "weekend pricing", "price overrides", "surge", "day rates"],
    description: "Charge (or pace) differently per weekday — shown honestly at booking",
    href: "/dashboard/booking?tab=Services",
    category: "booking",
    tourStepId: "book-services",
  },
  {
    id: "addons",
    name: "Service add-ons",
    synonyms: ["extras", "upsell", "hot towel", "add ons", "addons"],
    description: "Optional extras clients tack on at booking",
    href: "/dashboard/booking?tab=Services",
    category: "booking",
    tourStepId: "book-addons",
  },
  {
    id: "targeted-slots",
    name: "Special-priced slots",
    synonyms: ["targeted slots", "late night", "flash slot", "one-off slot", "special price", "model rate"],
    description: "Publish one-off bookable slots at their own price, badged in the picker",
    href: "/dashboard/booking?tab=Services",
    category: "booking",
    tourStepId: "book-slots",
  },
  {
    id: "waitlist",
    name: "Waitlist",
    synonyms: ["wait list", "fully booked", "cancellations", "standby"],
    description: "Full days feed a waitlist; freed slots ping the queue automatically",
    href: "/dashboard/booking?tab=Settings",
    category: "booking",
    tier: "pro",
    tourStepId: "book-waitlist",
  },
  {
    id: "requests",
    name: "Appointment requests",
    synonyms: ["leads", "request form", "inquiries", "contact"],
    description: "A lead inbox for shops that want requests before bookings",
    href: "/dashboard/requests",
    category: "booking",
  },
  {
    id: "booking-approval",
    name: "Request-before-booking",
    synonyms: ["approve bookings", "approval", "pending bookings", "screen clients"],
    description: "New bookings hold the slot as pending until you approve them",
    href: "/dashboard/booking?tab=Settings",
    category: "booking",
  },
  {
    id: "recurring",
    name: "Recurring appointments",
    synonyms: ["repeat", "every 2 weeks", "standing appointment", "series"],
    description: "Book a client's standing every-N-weeks slot in one shot",
    href: "/dashboard/booking",
    category: "booking",
  },
  {
    id: "pay-ahead",
    name: "Card & Apple Pay at booking",
    synonyms: ["stripe", "card payments", "apple pay", "pay ahead", "prepay", "deposit"],
    description: "Collect payment when they book — money hits your Stripe account",
    href: "/dashboard/payments",
    category: "money",
    tourStepId: "book-checkout",
  },
  {
    id: "pay-direct",
    name: "Zelle / Venmo / Cash App",
    synonyms: ["zelle", "venmo", "cashapp", "cash app", "pay direct", "no fees"],
    description: "Show your handles on the confirmation — clients pay you direct, 0% fees",
    href: "/dashboard/payments",
    category: "money",
    tourStepId: "book-checkout",
  },
  {
    id: "reminders",
    name: "Automatic reminders",
    synonyms: ["24 hour reminder", "no-show", "notifications", "confirmations"],
    description: "Booking confirmations plus 24h and 2h reminders, hands-off",
    href: "/dashboard/booking?tab=Settings",
    category: "booking",
    tourStepId: "book-confirmation",
  },
  {
    id: "check-in",
    name: "“On my way” check-in",
    synonyms: ["on my way", "eta", "running late", "arrived", "en route"],
    description: "Clients tap once before the cut; you see live status on the agenda",
    href: "/dashboard/booking",
    category: "booking",
    tourStepId: "manage-checkin",
  },
  {
    id: "punch-cards",
    name: "Punch cards & rewards",
    synonyms: ["loyalty", "punches", "stamps", "free cut", "reward menu"],
    description: "Automatic digital punch cards — visits earn, rewards redeem at the chair",
    href: "/dashboard/rewards",
    category: "retention",
    tourStepId: "rewards-punch-card",
  },
  {
    id: "vip-cards",
    name: "VIP & custom cards",
    synonyms: ["vip", "exclusive card", "invite only", "card types"],
    description: "Extra card types — including invite-only VIP cards for your best clients",
    href: "/dashboard/rewards",
    category: "retention",
    tourStepId: "rewards-extras",
  },
  {
    id: "loyalty-tiers",
    name: "Loyalty status tiers",
    synonyms: ["bronze", "silver", "gold", "status", "tiers", "member"],
    description: "Clients climb Bronze → Silver → Gold on lifetime visits",
    href: "/dashboard/rewards",
    category: "retention",
    tourStepId: "rewards-extras",
  },
  {
    id: "rebook-nudges",
    name: "Rebooking nudges",
    synonyms: ["nudge", "win back", "lapsed clients", "come back", "retention"],
    description: "Overdue clients get an automatic 'time to rebook' text or push",
    href: "/dashboard/nudges",
    category: "retention",
    tier: "pro",
    tourStepId: "rewards-extras",
  },
  {
    id: "clients",
    name: "Client book",
    synonyms: ["customers", "contacts", "client list", "crm", "export"],
    description: "Your client list — yours to keep, filter, and export",
    href: "/dashboard/clients",
    category: "data",
  },
  {
    id: "leaderboard",
    name: "Client leaderboard",
    synonyms: ["top clients", "best clients", "vips", "ranking"],
    description: "Who's visited most, spent most, and is due next",
    href: "/dashboard/leaderboard",
    category: "data",
  },
  {
    id: "insights",
    name: "Insights & trends",
    synonyms: ["analytics", "stats", "charts", "revenue", "trends", "reports"],
    description: "Visits, revenue, retention, and loyalty trends over time",
    href: "/dashboard/insights",
    category: "data",
  },
  {
    id: "activity",
    name: "Activity feed",
    synonyms: ["history", "log", "recent", "timeline"],
    description: "Everything that happened across your shop, in order",
    href: "/dashboard/activity",
    category: "data",
  },
  {
    // The old nav strip had an Inbox pill; when the 5-tab nav replaced it, this
    // index became the ONLY route to every non-tab page — and Inbox had no
    // entry, orphaning the receptionist's SMS threads entirely.
    id: "inbox",
    name: "Inbox",
    synonyms: ["messages", "texts", "conversations", "sms", "replies", "chat"],
    description: "Text conversations with your clients, including AI receptionist chats",
    href: "/dashboard/inbox",
    category: "data",
    tier: "pro_ai",
  },
  {
    // Same orphaning as inbox: the Team pill died with the old nav strip.
    // Distinct from "staff" (providers with services and hours, under Booking) —
    // this is who can SIGN IN to the dashboard.
    id: "team",
    name: "Team logins",
    synonyms: ["team", "employees", "invite", "seats", "staff logins", "roles"],
    description: "Invite the people in your shop and manage who can sign in",
    href: "/dashboard/team",
    category: "account",
  },
  {
    id: "receptionist",
    // This pointed at /dashboard/billing, which made the receptionist
    // UNREACHABLE inside the iOS app: both FeatureSearch and MoreSheet strip
    // every billing href for Guideline 3.1.1, so the feature that justifies the
    // top tier appeared in neither surface. It now has its own page, which
    // quotes no price and can therefore render natively.
    name: "AI receptionist",
    synonyms: [
      "ai",
      "text booking",
      "sms assistant",
      "answering",
      "missed calls",
      "auto reply",
      "robot",
      "assistant",
    ],
    description: "An AI that books clients over text when you're behind the chair",
    href: "/dashboard/receptionist",
    category: "account",
    tier: "pro_ai",
  },
  {
    id: "billing",
    name: "Plan & billing",
    synonyms: ["subscription", "upgrade", "premium", "price", "plan"],
    description: "Your ChairBack plan, texting quota, and add-ons",
    href: "/dashboard/billing",
    category: "money",
  },
  {
    id: "referrals",
    name: "Refer a barber",
    synonyms: [
      "referral",
      "refer a friend",
      "invite",
      "share",
      "free month",
      "affiliate",
      "referral link",
    ],
    description: "Send your link — they get an extra month, you get one free",
    href: "/dashboard/referrals",
    // Grouped with the other "your account" surfaces in the More tab: this is
    // about the barber's own plan, not something their clients ever see.
    category: "account",
  },
  {
    id: "live-demo",
    name: "Live client demo",
    synonyms: ["demo", "tour", "what clients see", "walkthrough", "preview"],
    description: "Walk through everything your clients get, on a real demo shop",
    href: "/demo",
    category: "account",
  },
  {
    id: "account",
    name: "Account & security",
    synonyms: [
      "account",
      "profile",
      "password",
      "change password",
      "change email",
      "login email",
      "avatar",
      "profile photo",
      "delete account",
      "my name",
    ],
    description: "Your name, photo, password, sign-in, and account deletion",
    href: "/dashboard/account",
    category: "account",
  },
  {
    id: "dashboard-tour",
    name: "Dashboard walkthrough",
    synonyms: ["dashboard demo", "owner demo", "where is", "orientation", "tour the dashboard"],
    description: "A guided lap of the barber side — agenda, clients, rewards, insights",
    href: "/dashboard?tour=1",
    category: "account",
  },
];
