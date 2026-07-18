/**
 * The searchable feature directory behind the dashboard's feature-search
 * palette (Ctrl/Cmd-K). One entry per barber-visible capability: where it
 * lives (`href`, always a dashboard page or the /demo tour entry) and, when
 * the feature is something their CLIENTS see, which live-demo step shows it
 * (`tourStepId` → DEMO_TOUR_STEPS, rendered as a "see it live" action).
 *
 * Matching is intentionally simple (name/synonym includes) — keep synonyms
 * generous: they're the words a barber would actually type.
 */
export interface FeatureIndexEntry {
  id: string;
  name: string;
  synonyms: string[];
  description: string;
  /** Primary destination — must start with /dashboard or /demo. */
  href: string;
  /** Optional DEMO_TOUR_STEPS id showing this feature in the live demo. */
  tourStepId?: string;
}

export const FEATURE_INDEX: FeatureIndexEntry[] = [
  {
    id: "mini-site",
    name: "Public shop page",
    synonyms: ["mini site", "website", "landing page", "shop link", "page"],
    description: "Your own booking mini-site clients open from a link",
    href: "/dashboard/site",
    tourStepId: "shop-hero",
  },
  {
    id: "themes",
    name: "Themes, fonts & branding",
    synonyms: ["theme", "colors", "fonts", "accent", "logo", "branding", "style"],
    description: "Make your page and rewards hub look like YOUR shop",
    href: "/dashboard/site",
    tourStepId: "shop-hero",
  },
  {
    id: "gallery",
    name: "Photo gallery",
    synonyms: ["photos", "pictures", "portfolio", "work", "images"],
    description: "Show off your cuts on the public page",
    href: "/dashboard/site",
    tourStepId: "shop-hero",
  },
  {
    id: "promotions",
    name: "Promotions",
    synonyms: ["promo", "deals", "specials", "discount", "sale", "offer"],
    description: "Run specials that show on your page and can be texted out",
    href: "/dashboard/promotions",
    tourStepId: "shop-promotions",
  },
  {
    id: "reviews",
    name: "Reviews",
    synonyms: ["ratings", "stars", "testimonials", "feedback"],
    description: "Clients review on your page; you approve what shows",
    href: "/dashboard/reviews",
    tourStepId: "shop-reviews",
  },
  {
    id: "online-booking",
    name: "Online booking",
    synonyms: ["book", "booking", "appointments", "scheduling", "calendar", "agenda"],
    description: "Your own booking engine — services, staff, hours, agenda",
    href: "/dashboard/booking",
    tourStepId: "shop-book-cta",
  },
  {
    id: "staff",
    name: "Staff & providers",
    synonyms: ["barbers", "team", "providers", "employees", "chairs"],
    description: "Multiple barbers, each with their own services and hours",
    href: "/dashboard/booking",
  },
  {
    id: "services",
    name: "Services & pricing",
    synonyms: ["menu", "prices", "haircut", "service list", "duration"],
    description: "Your service menu with durations and prices",
    href: "/dashboard/booking",
    tourStepId: "book-services",
  },
  {
    id: "day-pricing",
    name: "Day-specific pricing & durations",
    synonyms: ["saturday price", "weekend pricing", "price overrides", "surge", "day rates"],
    description: "Charge (or pace) differently per weekday — shown honestly at booking",
    href: "/dashboard/booking",
    tourStepId: "book-services",
  },
  {
    id: "addons",
    name: "Service add-ons",
    synonyms: ["extras", "upsell", "hot towel", "add ons", "addons"],
    description: "Optional extras clients tack on at booking",
    href: "/dashboard/booking",
    tourStepId: "book-addons",
  },
  {
    id: "targeted-slots",
    name: "Special-priced slots",
    synonyms: ["targeted slots", "late night", "flash slot", "one-off slot", "special price", "model rate"],
    description: "Publish one-off bookable slots at their own price, badged in the picker",
    href: "/dashboard/booking",
    tourStepId: "book-slots",
  },
  {
    id: "waitlist",
    name: "Waitlist",
    synonyms: ["wait list", "fully booked", "cancellations", "standby"],
    description: "Full days feed a waitlist; freed slots ping the queue automatically",
    href: "/dashboard/booking",
    tourStepId: "book-waitlist",
  },
  {
    id: "requests",
    name: "Appointment requests",
    synonyms: ["leads", "request form", "inquiries", "contact"],
    description: "A lead inbox for shops that want requests before bookings",
    href: "/dashboard/requests",
  },
  {
    id: "booking-approval",
    name: "Request-before-booking",
    synonyms: ["approve bookings", "approval", "pending bookings", "screen clients"],
    description: "New bookings hold the slot as pending until you approve them",
    href: "/dashboard/booking",
  },
  {
    id: "recurring",
    name: "Recurring appointments",
    synonyms: ["repeat", "every 2 weeks", "standing appointment", "series"],
    description: "Book a client's standing every-N-weeks slot in one shot",
    href: "/dashboard/booking",
  },
  {
    id: "pay-ahead",
    name: "Card & Apple Pay at booking",
    synonyms: ["stripe", "card payments", "apple pay", "pay ahead", "prepay", "deposit"],
    description: "Collect payment when they book — money hits your Stripe account",
    href: "/dashboard/payments",
    tourStepId: "book-checkout",
  },
  {
    id: "pay-direct",
    name: "Zelle / Venmo / Cash App",
    synonyms: ["zelle", "venmo", "cashapp", "cash app", "pay direct", "no fees"],
    description: "Show your handles on the confirmation — clients pay you direct, 0% fees",
    href: "/dashboard/payments",
    tourStepId: "book-checkout",
  },
  {
    id: "reminders",
    name: "Automatic reminders",
    synonyms: ["24 hour reminder", "no-show", "notifications", "confirmations"],
    description: "Booking confirmations plus 24h and 2h reminders, hands-off",
    href: "/dashboard/booking",
    tourStepId: "book-confirmation",
  },
  {
    id: "check-in",
    name: "“On my way” check-in",
    synonyms: ["on my way", "eta", "running late", "arrived", "en route"],
    description: "Clients tap once before the cut; you see live status on the agenda",
    href: "/dashboard/booking",
    tourStepId: "manage-checkin",
  },
  {
    id: "punch-cards",
    name: "Punch cards & rewards",
    synonyms: ["loyalty", "punches", "stamps", "free cut", "reward menu"],
    description: "Automatic digital punch cards — visits earn, rewards redeem at the chair",
    href: "/dashboard/rewards",
    tourStepId: "rewards-punch-card",
  },
  {
    id: "vip-cards",
    name: "VIP & custom cards",
    synonyms: ["vip", "exclusive card", "invite only", "card types"],
    description: "Extra card types — including invite-only VIP cards for your best clients",
    href: "/dashboard/rewards",
    tourStepId: "rewards-extras",
  },
  {
    id: "loyalty-tiers",
    name: "Loyalty status tiers",
    synonyms: ["bronze", "silver", "gold", "status", "tiers", "member"],
    description: "Clients climb Bronze → Silver → Gold on lifetime visits",
    href: "/dashboard/rewards",
    tourStepId: "rewards-extras",
  },
  {
    id: "rebook-nudges",
    name: "Rebooking nudges",
    synonyms: ["nudge", "win back", "lapsed clients", "come back", "retention"],
    description: "Overdue clients get an automatic 'time to rebook' text or push",
    href: "/dashboard/nudges",
    tourStepId: "rewards-extras",
  },
  {
    id: "clients",
    name: "Client book",
    synonyms: ["customers", "contacts", "client list", "crm", "export"],
    description: "Your client list — yours to keep, filter, and export",
    href: "/dashboard/clients",
  },
  {
    id: "leaderboard",
    name: "Client leaderboard",
    synonyms: ["top clients", "best clients", "vips", "ranking"],
    description: "Who's visited most, spent most, and is due next",
    href: "/dashboard/leaderboard",
  },
  {
    id: "insights",
    name: "Insights & trends",
    synonyms: ["analytics", "stats", "charts", "revenue", "trends", "reports"],
    description: "Visits, revenue, retention, and loyalty trends over time",
    href: "/dashboard/insights",
  },
  {
    id: "activity",
    name: "Activity feed",
    synonyms: ["history", "log", "recent", "timeline"],
    description: "Everything that happened across your shop, in order",
    href: "/dashboard/activity",
  },
  {
    id: "receptionist",
    name: "AI receptionist",
    synonyms: ["ai", "text booking", "sms assistant", "answering", "missed calls"],
    description: "An AI that books clients over text when you're behind the chair",
    href: "/dashboard/billing",
  },
  {
    id: "billing",
    name: "Plan & billing",
    synonyms: ["subscription", "upgrade", "premium", "price", "plan"],
    description: "Your ChairBack plan, texting quota, and add-ons",
    href: "/dashboard/billing",
  },
  {
    id: "live-demo",
    name: "Live client demo",
    synonyms: ["demo", "tour", "what clients see", "walkthrough", "preview"],
    description: "Walk through everything your clients get, on a real demo shop",
    href: "/demo",
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
  },
  {
    id: "dashboard-tour",
    name: "Dashboard walkthrough",
    synonyms: ["dashboard demo", "owner demo", "where is", "orientation", "tour the dashboard"],
    description: "A guided lap of the barber side — agenda, clients, rewards, insights",
    href: "/dashboard?tour=1",
  },
];
