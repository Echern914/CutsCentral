/**
 * The feature registry. ONE entry per barber-visible capability, and the ONLY
 * place in the product that decides where a capability lives.
 *
 * WHY THIS IS THE SINGLE SOURCE. Before this file grew its access fields the
 * same destination was written out by hand in six places: the Cmd-K palette,
 * the More sheet, the help corpus, the readiness engine's CTAs, the header
 * bell, and the home screen's shortcut tiles. Each copy drifted on its own
 * schedule, and each one decided for itself whether a barber, a lapsed shop or
 * the iOS shell was allowed to see it. The receptionist spent a release
 * unreachable in-app because one copy pointed at a billing href; Inbox and Team
 * were orphaned entirely when the old nav strip was deleted and nothing failed.
 *
 * So: a surface never writes a route. It names a FEATURE ID and asks
 * `resolveFeature()` for a destination, and the answer already accounts for the
 * caller's role, plan, feature flags and shell. A denial comes back as a REASON
 * rather than a link that 403s on arrival.
 *
 * This also makes the registry the safe seam for anything that takes
 * instructions from outside the product (the Assistant, and later the MCP
 * server): an untrusted caller can only ever hand back an ID that we look up
 * here, never a URL we would follow.
 *
 * Matching for the search surfaces stays intentionally simple (see
 * `searchFeatures` in helpMatch.ts) — keep `synonyms` generous: they're the
 * words a barber would actually type.
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

/**
 * A seat's role in the shop it is acting on. Mirrors `ShopMembership.role` on
 * the API side; spelled out here because the registry is shared and must not
 * import from the database package.
 */
export type SeatRole = "OWNER" | "MANAGER" | "BARBER";

/** Feature flags a shop can switch off, which then hide whole destinations. */
export type FeatureFlag = "rewardsEnabled";

export interface FeatureIndexEntry {
  /** Stable id. This is the ONLY thing a caller outside the product may name. */
  id: string;
  /** Customer-facing name. Doubles as the label on a resolved link. */
  name: string;
  /** Alternate vocabulary a barber might type. Carries the search load. */
  synonyms: string[];
  description: string;
  /** Primary destination — must start with /dashboard, /demo, or be a public page. */
  href: string;
  /** Which FEATURE_CATEGORIES group this shows under in the More tab. */
  category: FeatureCategoryId;
  /** Optional DEMO_TOUR_STEPS id showing this feature in the live demo. */
  tourStepId?: string;
  /**
   * Plan that unlocks this feature for shops whose access has LAPSED.
   * "pro" locks when billing hasAccess is false; "pro_ai" additionally
   * requires the receptionist entitlement. Untagged = free forever, which is
   * also what makes it reachable by a lapsed shop (see `availableWhenLapsed`).
   *
   * Tag ONLY features the API genuinely refuses to free shops (402/409/cron
   * skip). Marketing says more is premium than the server enforces — a badge
   * on a feature that actually works free is a lie that cheapens the real
   * locks. NEVER derive a lock from plan === "free": trialing shops are
   * plan "free" WITH full access, and comped shops are free forever.
   */
  tier?: "pro" | "pro_ai";
  /**
   * Lowest seat that may open this. Omitted = MANAGER, because that is what
   * nearly every dashboard page enforces server-side today.
   *
   * 🔴 This is the field that stops the Assistant handing an employee a link
   * that 403s on arrival. It must track the ROUTER's gate, not our intent: if
   * `requireManager` guards the endpoint behind a page, the page is MANAGER
   * here even when the feature feels personal.
   */
  minRole?: SeatRole;
  /** Shop flag that must be on, or the destination does not exist. */
  flag?: FeatureFlag;
  /**
   * True when opening this page cannot change anything. Omitted = the page can
   * modify data, which is the safe default for a registry an AI reads from.
   */
  readOnly?: boolean;
  /**
   * Readiness item ids (see the API's readiness engine) that must be complete
   * before this feature does anything useful. Used to explain "you can open
   * this, but it won't work yet" rather than sending someone to a dead screen.
   */
  requiresSetup?: string[];
  /** Guided walkthrough that teaches this feature. Populated by the guides PR. */
  guideId?: string;
  /**
   * Questions a barber actually asks that this feature answers. Feeds the
   * Assistant's local (zero-token) answering and the help corpus's derived
   * "where do I find X" replies.
   */
  questions?: string[];
  /**
   * False for destinations a read-only demo session must not reach — anything
   * tied to a real account or a real card. Omitted = fine in demo.
   */
  inDemo?: boolean;
  /**
   * False keeps an entry out of the browsable/searchable surfaces while still
   * making it RESOLVABLE by id. Public marketing pages live here: the help
   * corpus links to them, but they are not shop features.
   */
  listed?: boolean;
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

/**
 * The booking page is one route with five tabs, so half the registry's
 * destinations are `?tab=` deep links. Pinned here and asserted in the tests
 * because a tab that does not exist silently lands the barber on the DEFAULT
 * tab instead - which is how "Acuity & Square sync" spent its life dropping
 * people on the appointment book, three taps from the connect card.
 *
 * Keep in step with `tabs` in the web app's BookingManager.
 */
export const BOOKING_TABS = [
  "Appointments",
  "Waitlist",
  "Staff",
  "Services",
  "Settings",
] as const;

export const FEATURE_INDEX: FeatureIndexEntry[] = [
  {
    id: "home",
    name: "Home",
    synonyms: ["dashboard", "overview", "today", "start", "main"],
    description: "Today's chair at a glance — what's booked and what needs you",
    href: "/dashboard",
    category: "account",
    // The ONE screen an employee seat has. Everything else 403s for them.
    minRole: "BARBER",
    readOnly: true,
    questions: ["what's on today", "show me my day", "where do I start"],
  },
  {
    id: "assistant",
    name: "Assistant",
    synonyms: ["help me", "ask", "chatgpt", "claude", "ai help", "guide", "walkthrough", "what do I do"],
    description: "Ask what to do next, finish setup, and fix what's blocking you",
    href: "/dashboard/assistant",
    category: "account",
    // Deliberately BARBER: an employee's own setup tasks and the whole local
    // help corpus live here, and both are things they can act on alone.
    minRole: "BARBER",
    readOnly: true,
    questions: [
      "what do I do next",
      "why is my booking page unavailable",
      "help me finish setting up",
      "what needs my attention",
    ],
  },
  {
    id: "mini-site",
    name: "Public shop page",
    synonyms: ["mini site", "website", "landing page", "shop link", "page"],
    description: "Your own booking mini-site clients open from a link",
    href: "/dashboard/site",
    category: "brand",
    tourStepId: "shop-hero",
    requiresSetup: ["shop.slug"],
    questions: ["where is my booking link", "how do I share my page"],
  },
  {
    id: "themes",
    name: "Themes, fonts & branding",
    synonyms: ["theme", "colors", "fonts", "accent", "logo", "branding", "style", "qr code", "logo", "colors", "brand"],
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
    // Shipped in #204 and never indexed, so "domain" - the exact word a barber
    // would type - returned nothing at all.
    id: "custom-domain",
    name: "Your own domain",
    synonyms: [
      "domain",
      "custom domain",
      "website address",
      "url",
      "dns",
      "godaddy",
      "namecheap",
      "www",
    ],
    description: "Point a domain you own at your ChairBack page",
    href: "/dashboard/site",
    category: "brand",
    minRole: "OWNER",
  },
  {
    // Acuity/Square connection lives inside the Booking tab's ConnectPlatforms
    // card. None of these words hit anything before.
    id: "integrations",
    name: "Acuity & Square sync",
    synonyms: [
      "acuity",
      "square",
      "sync",
      "connect",
      "integration",
      "import bookings",
      "existing calendar",
      "switch over",
    ],
    description: "Keep your current booking site and sync it into ChairBack",
    // 🔴 ?tab=Settings, not the bare route. ConnectPlatforms - the card that
    // actually connects Acuity and Square - renders on the Settings tab, while
    // the bare route opens the appointment book. The help corpus and the
    // readiness engine both had this right and only the index had it wrong,
    // which is precisely why there is now one list instead of three.
    href: "/dashboard/booking?tab=Settings",
    category: "booking",
    minRole: "OWNER",
    questions: [
      "how do I connect square",
      "how do I connect acuity",
      "why did my integration stop syncing",
    ],
  },
  {
    id: "shop-timezone",
    name: "Time zone",
    synonyms: ["timezone", "time zone", "clock", "wrong time", "hours are off"],
    description: "The time zone every booking and reminder is shown in",
    href: "/dashboard/account",
    category: "account",
    requiresSetup: ["shop.timezone"],
  },
  {
    id: "promotions",
    name: "Promotions",
    synonyms: ["promo", "deals", "specials", "discount", "sale", "offer"],
    description: "Run specials that show on your page and can be texted out",
    href: "/dashboard/promotions",
    category: "retention",
    tourStepId: "shop-promotions",
    tier: "pro",
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
    // 🔴 The settings vocabulary (buffer, lead time, days ahead) and the book's
    // verbs (walk in) deliberately live on `booking-rules` and `appointments`
    // instead. This entry is the HUB and opens the bare route; when it also
    // claimed those words it tied with them on score and won on alphabetical
    // tie-break, sending "buffer" to the appointment book rather than to the
    // setting called buffer.
    synonyms: ["book", "booking", "scheduling", "calendar", "agenda", "online booking", "take bookings"],
    description: "Your own booking engine — services, staff, hours, agenda",
    href: "/dashboard/booking",
    category: "booking",
    tourStepId: "shop-book-cta",
    questions: [
      "how do I enable my booking page",
      "how do I pause bookings",
      "what openings do I have",
    ],
  },
  {
    id: "appointments",
    name: "Appointments",
    synonyms: ["book appointment", "new appointment", "add appointment", "walk in", "reschedule", "cancel", "no show", "mark no show", "check in"],
    description: "The day's book — create, move, cancel and check people in",
    href: "/dashboard/booking?tab=Appointments",
    category: "booking",
    questions: [
      "show me tomorrow's appointments",
      "how do I reschedule somebody",
      "how do I mark a no-show",
      "how do I add a walk-in",
    ],
  },
  {
    id: "staff",
    name: "Staff & providers",
    synonyms: ["barbers", "team", "providers", "employees", "chairs", "staff hours", "weekly hours", "availability", "time off", "vacation", "day off", "lunch break", "break", "closed", "block off", "blocked time", "working hours"],
    description: "Multiple barbers, each with their own services and hours",
    href: "/dashboard/booking?tab=Staff",
    category: "booking",
    requiresSetup: ["shop.staff.active"],
    questions: [
      "how do I add a barber",
      "how do I change my hours",
      "how do I block time",
    ],
  },
  {
    id: "services",
    name: "Services & pricing",
    synonyms: ["menu", "prices", "haircut", "service list", "duration", "service group", "group", "add service", "edit service", "photo", "description", "service photo", "holiday", "holiday pricing", "special date", "max per day"],
    description: "Your service menu with durations and prices",
    href: "/dashboard/booking?tab=Services",
    category: "booking",
    tourStepId: "book-services",
    requiresSetup: ["shop.service.active"],
    questions: ["how do I create a service", "take me to my services"],
  },
  {
    id: "day-pricing",
    name: "Day-specific pricing & durations",
    synonyms: ["saturday price", "weekend pricing", "price overrides", "surge", "day rates", "holiday price", "specific date", "sunday surcharge", "date pricing"],
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
    // The QUEUE has had its own tab since the waitlist shipped; Settings only
    // holds the on/off switch. "Open waitlist" means the people waiting.
    href: "/dashboard/booking?tab=Waitlist",
    category: "booking",
    tourStepId: "book-waitlist",
    tier: "pro",
    questions: ["how do I use the waitlist", "who is waiting"],
  },
  {
    id: "requests",
    name: "Appointment requests",
    synonyms: ["leads", "request form", "inquiries", "contact"],
    description: "A lead inbox for shops that want requests before bookings",
    href: "/dashboard/requests",
    category: "booking",
    questions: ["do I have any booking requests to review"],
  },
  {
    id: "booking-rules",
    name: "Booking rules",
    synonyms: ["lead time", "minimum notice", "how far out", "days ahead", "buffer", "turnaround", "cleanup time", "pause bookings", "stop taking bookings", "booking settings"],
    description: "How far ahead people can book, how much notice you need, and gaps between cuts",
    href: "/dashboard/booking?tab=Settings",
    category: "booking",
    questions: [
      "how do I pause bookings",
      "how far ahead can people book",
      "how much notice do I need",
    ],
  },
  {
    id: "booking-approval",
    name: "Request-before-booking",
    synonyms: ["approve bookings", "approval", "pending bookings", "screen clients"],
    description: "New bookings hold the slot as pending until you approve them",
    href: "/dashboard/booking?tab=Settings",
    category: "booking",
    questions: ["how do I approve bookings before they're confirmed"],
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
    synonyms: ["stripe", "card payments", "apple pay", "pay ahead", "prepay", "deposit", "deposit", "tax", "receipt", "refund", "cancellation policy", "no show fee"],
    description: "Collect payment when they book — money hits your Stripe account",
    href: "/dashboard/payments",
    category: "money",
    tourStepId: "book-checkout",
    minRole: "OWNER",
    inDemo: false,
    questions: [
      "how do deposits work",
      "how do I change my cancellation policy",
    ],
  },
  {
    id: "pay-direct",
    name: "Zelle / Venmo / Cash App",
    synonyms: ["zelle", "venmo", "cashapp", "cash app", "pay direct", "no fees"],
    description: "Show your handles on the confirmation — clients pay you direct, 0% fees",
    href: "/dashboard/payments",
    category: "money",
    tourStepId: "book-checkout",
    minRole: "OWNER",
  },
  {
    id: "reminders",
    name: "Automatic reminders",
    synonyms: ["24 hour reminder", "notifications", "confirmations", "reminder", "text reminder", "email reminder", "day before", "booking alerts"],
    description: "Booking confirmations plus 24h and 2h reminders, hands-off",
    href: "/dashboard/booking?tab=Settings",
    category: "booking",
    tourStepId: "book-confirmation",
    questions: ["how do I turn on booking alerts", "why didn't I get notified"],
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
    flag: "rewardsEnabled",
  },
  {
    id: "vip-cards",
    name: "VIP & custom cards",
    synonyms: ["vip", "exclusive card", "invite only", "card types"],
    description: "Extra card types — including invite-only VIP cards for your best clients",
    href: "/dashboard/rewards",
    category: "retention",
    tourStepId: "rewards-extras",
    flag: "rewardsEnabled",
  },
  {
    id: "loyalty-tiers",
    name: "Loyalty status tiers",
    synonyms: ["bronze", "silver", "gold", "status", "tiers", "member"],
    description: "Clients climb Bronze → Silver → Gold on lifetime visits",
    href: "/dashboard/rewards",
    category: "retention",
    tourStepId: "rewards-extras",
    flag: "rewardsEnabled",
  },
  {
    id: "rebook-nudges",
    name: "Rebooking nudges",
    synonyms: ["nudge", "win back", "lapsed clients", "come back", "retention"],
    description: "Overdue clients get an automatic 'time to rebook' text or push",
    href: "/dashboard/nudges",
    category: "retention",
    tourStepId: "rewards-extras",
    tier: "pro",
    questions: ["who should I rebook", "who hasn't been back"],
  },
  {
    id: "clients",
    name: "Client book",
    synonyms: ["customers", "contacts", "client list", "crm", "export", "csv", "import", "merge", "merge clients", "duplicate client", "opt out", "consent", "unsubscribe", "client notes"],
    description: "Your client list — yours to keep, filter, and export",
    href: "/dashboard/clients",
    category: "data",
    questions: [
      "how do I merge duplicate clients",
      "why can't I text this client",
    ],
  },
  {
    id: "leaderboard",
    name: "Client leaderboard",
    synonyms: ["top clients", "best clients", "vips", "ranking"],
    description: "Who's visited most, spent most, and is due next",
    href: "/dashboard/leaderboard",
    category: "data",
    readOnly: true,
  },
  {
    id: "insights",
    name: "Insights & trends",
    synonyms: ["analytics", "stats", "charts", "revenue", "trends", "reports", "goal", "chair time", "utilization", "how busy", "daily target", "quota", "planner"],
    description: "Visits, revenue, retention, and loyalty trends over time",
    href: "/dashboard/insights",
    category: "data",
    readOnly: true,
    questions: ["where are my reports", "am I on pace for my goal"],
  },
  {
    id: "activity",
    name: "Activity feed",
    synonyms: ["history", "log", "recent", "timeline"],
    description: "Everything that happened across your shop, in order",
    href: "/dashboard/activity",
    category: "data",
    readOnly: true,
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
    minRole: "OWNER",
    questions: ["how do I invite a team member"],
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
    synonyms: ["subscription", "upgrade", "premium", "price", "plan", "quota", "texts left", "sms usage", "invoice", "cancel plan", "comped"],
    description: "Your ChairBack plan, texting quota, and add-ons",
    href: "/dashboard/billing",
    category: "money",
    minRole: "OWNER",
    inDemo: false,
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
    minRole: "OWNER",
  },
  {
    id: "live-demo",
    name: "Live client demo",
    synonyms: ["demo", "tour", "what clients see", "walkthrough", "preview"],
    description: "Walk through everything your clients get, on a real demo shop",
    href: "/demo",
    category: "account",
    minRole: "BARBER",
    readOnly: true,
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
    // Every seat has a personal account page, employee seats included — it is
    // where in-app account deletion lives (App Store 5.1.1(v)).
    minRole: "BARBER",
    inDemo: false,
  },
  {
    id: "dashboard-tour",
    name: "Dashboard walkthrough",
    synonyms: ["dashboard demo", "owner demo", "where is", "orientation", "tour the dashboard"],
    description: "A guided lap of the barber side — agenda, clients, rewards, insights",
    href: "/dashboard?tour=1",
    category: "account",
    minRole: "BARBER",
    readOnly: true,
  },

  /* ---------------------------------------------------------------------- *
   * Public pages. RESOLVABLE but not LISTED: the help corpus links to these,
   * so they must have ids rather than hand-written hrefs, but they are not
   * shop features and have no business in the palette or the More sheet.
   * ---------------------------------------------------------------------- */
  {
    // The first-run "connect your calendar" step. Unlisted because a shop that
    // already picked a booking source has no business finding it in the
    // directory, but the onboarding card and the readiness engine both need to
    // NAME it rather than type it.
    id: "onboarding-connect",
    name: "Connect your booking calendar",
    synonyms: ["onboarding", "first setup", "connect calendar", "get set up"],
    description: "Pick a booking source — Acuity, Square, or ChairBack's own",
    href: "/onboarding/connect",
    category: "booking",
    minRole: "OWNER",
    listed: false,
  },
  {
    id: "support",
    name: "Contact support",
    synonyms: ["support", "help", "contact us", "email us", "human"],
    description: "Reach a person at ChairBack",
    href: "/support",
    category: "account",
    minRole: "BARBER",
    readOnly: true,
    listed: false,
  },
  {
    id: "privacy",
    name: "Privacy policy",
    synonyms: ["privacy", "data", "gdpr", "policy"],
    description: "What ChairBack stores and why",
    href: "/privacy",
    category: "account",
    minRole: "BARBER",
    readOnly: true,
    listed: false,
  },
  {
    id: "pricing",
    name: "Pricing",
    synonyms: ["pricing", "cost", "how much"],
    description: "What ChairBack costs",
    href: "/pricing",
    category: "money",
    minRole: "BARBER",
    readOnly: true,
    listed: false,
    inDemo: false,
  },
  {
    id: "signup",
    name: "Create your shop",
    synonyms: ["sign up", "register", "get started", "new account"],
    description: "Start a ChairBack shop",
    href: "/signup",
    category: "account",
    minRole: "BARBER",
    readOnly: true,
    listed: false,
    inDemo: false,
  },
];

/* ========================== resolution ================================== */

const BY_ID: ReadonlyMap<string, FeatureIndexEntry> = new Map(
  FEATURE_INDEX.map((f) => [f.id, f]),
);

/** Look an entry up by id. Returns undefined for an id we do not publish. */
export function featureById(id: string): FeatureIndexEntry | undefined {
  return BY_ID.get(id);
}

const ROLE_RANK: Record<SeatRole, number> = { BARBER: 0, MANAGER: 1, OWNER: 2 };

/**
 * Everything the registry needs to know about WHO is asking. Every field has a
 * permissive default so a caller that knows nothing still gets the owner-on-web
 * behaviour the product had before this file existed.
 */
export interface NavContext {
  /** The caller's role in the shop being acted on. */
  role?: SeatRole;
  /** Billing access — false only for a genuinely lapsed shop. */
  hasAccess?: boolean;
  /** The receptionist add-on entitlement. */
  hasPremiumAi?: boolean;
  /** Read-only demo session. */
  demo?: boolean;
  /** Inside the iOS/Android shell (App Store Guideline 3.1.1). */
  inApp?: boolean;
  /** Shop flags that are switched OFF. */
  flagsOff?: readonly FeatureFlag[];
}

/** Why a destination was withheld. Surfaces turn these into an explanation. */
export type NavDenial =
  | "unknown_feature"
  | "role"
  | "plan"
  | "flag"
  | "demo"
  | "in_app";

export type NavResolution =
  | { ok: true; entry: FeatureIndexEntry; href: string; label: string }
  | { ok: false; reason: NavDenial; entry?: FeatureIndexEntry };

/**
 * The one function that turns a feature id into a place a given caller may
 * actually go.
 *
 * 🔴 It refuses rather than degrades. There is no "closest available page"
 * fallback, because a link that silently lands somewhere else is worse than an
 * honest "your manager has to do this" — that was the whole complaint about
 * the old hard-coded lists, which happily handed employees manager pages.
 */
export function resolveFeature(id: string, ctx: NavContext = {}): NavResolution {
  const entry = BY_ID.get(id);
  if (!entry) return { ok: false, reason: "unknown_feature" };

  const role = ctx.role ?? "OWNER";
  if (ROLE_RANK[role] < ROLE_RANK[entry.minRole ?? "MANAGER"]) {
    return { ok: false, reason: "role", entry };
  }

  if (entry.flag && (ctx.flagsOff ?? []).includes(entry.flag)) {
    return { ok: false, reason: "flag", entry };
  }

  // 3.1.1 before plan: inside the shell a billing href must not be reachable
  // AT ALL, including as the explanation for why something is locked.
  if (ctx.inApp && isBillingHref(entry.href)) {
    return { ok: false, reason: "in_app", entry };
  }

  if (ctx.demo && entry.inDemo === false) {
    return { ok: false, reason: "demo", entry };
  }

  // A tier tag only bites once access has actually lapsed. Trialing shops are
  // plan "free" WITH access and must not be locked out of anything.
  if (entry.tier && ctx.hasAccess === false) {
    return { ok: false, reason: "plan", entry };
  }
  if (entry.tier === "pro_ai" && ctx.hasPremiumAi === false) {
    return { ok: false, reason: "plan", entry };
  }

  return { ok: true, entry, href: entry.href, label: entry.name };
}

/**
 * `resolveFeature` when all the caller wants is a link, and a denial simply
 * means "render nothing". Never throws and never invents a route.
 */
export function resolveHref(id: string, ctx: NavContext = {}): string | null {
  const r = resolveFeature(id, ctx);
  return r.ok ? r.href : null;
}

/**
 * True when this feature stays reachable for a shop whose billing has lapsed.
 * DERIVED from `tier` rather than stored: the two could never disagree, and a
 * second field would just be somewhere for them to drift apart.
 */
export function availableWhenLapsed(entry: FeatureIndexEntry): boolean {
  return entry.tier === undefined;
}

/** True when an employee seat may open this feature. */
export function availableToBarberSeat(entry: FeatureIndexEntry): boolean {
  return (entry.minRole ?? "MANAGER") === "BARBER";
}

/**
 * The browsable/searchable slice for a given caller: listed entries this
 * context is allowed to reach.
 *
 * A LOCKED premium feature is still returned. The palette and the More sheet
 * render it with a diamond and its page explains the lock — hiding it would
 * mean a barber cannot discover what upgrading buys. Only entries genuinely
 * absent for this caller (wrong role, flag off, forbidden in the shell) drop
 * out, which is why `hasAccess` is not consulted here.
 */
export function visibleFeatures(ctx: NavContext = {}): FeatureIndexEntry[] {
  return FEATURE_INDEX.filter((f) => {
    if (f.listed === false) return false;
    const r = resolveFeature(f.id, { ...ctx, hasAccess: true, hasPremiumAi: true });
    return r.ok;
  });
}

/**
 * The absolute URL for a feature, for a link that has to survive leaving the
 * product (an assistant's answer, an email).
 *
 * 🔴 On iOS this opens the WEBSITE, not the app, for every /dashboard
 * destination: the app claims only /r/*, /team/join* and /auth/mobile/callback*
 * in its apple-app-site-association, and an unclaimed path goes to Safari. The
 * barber shell is itself a WebView of /dashboard, so the page is the same one
 * either way — but do not describe these as app deep links until AASA actually
 * claims /dashboard/* AND a build carrying that claim has shipped (iOS refreshes
 * the file only on reinstall or CDN expiry).
 */
export function featureUrl(id: string, origin: string, ctx: NavContext = {}): string | null {
  const href = resolveHref(id, ctx);
  return href === null ? null : `${origin.replace(/\/$/, "")}${href}`;
}
