/**
 * The guided client-experience tour: an ordered walk across the demo shop's
 * REAL client pages, one spotlight step at a time. Pure data — the web app's
 * DemoTour overlay (apps/web/src/components/tour) renders it, resolving each
 * `route` key to a concrete path built from the DEMO tokens and each `anchor`
 * to a `data-tour="<anchor>"` attribute on the page.
 *
 * Keep anchors in sync with the data-tour attributes in:
 *   /s/[slug]/ShopPageClient.tsx        (route "shop")
 *   /book/[slug]/BookingClient.tsx      (route "book")
 *   /book/manage/[token]/ManageClient.tsx (route "manage")
 *   /r/[magicToken]/RewardsClient.tsx   (route "rewards")
 *
 * Copy is barber-facing ("your clients") — the tour's primary job is showing a
 * shop owner what their customers get — but reads fine for a curious client too.
 */
export interface DemoTourStep<Route extends string = string> {
  /** Unique id; FEATURE_INDEX entries reference these to deep-link. */
  id: string;
  /** Which page hosts the step (resolved to a concrete path by the web app). */
  route: Route;
  /** data-tour attribute the spotlight anchors to on that page. */
  anchor: string;
  title: string;
  body: string;
}

/** Pages of the CLIENT tour (the demo shop's public surfaces). */
export type ClientTourRoute = "shop" | "book" | "manage" | "rewards";

export const DEMO_TOUR_STEPS: DemoTourStep<ClientTourRoute>[] = [
  {
    id: "shop-hero",
    route: "shop",
    anchor: "hero",
    title: "Your own mini-site",
    body: "Every shop gets a page like this — your name, your colors, your fonts, your photos. Clients just need the link.",
  },
  {
    id: "shop-promotions",
    route: "shop",
    anchor: "promotions",
    title: "Live promotions",
    body: "Run a special and it shows up here automatically — and can go out to your clients as a text blast.",
  },
  {
    id: "shop-rewards-menu",
    route: "shop",
    anchor: "rewards-menu",
    title: "A public reward menu",
    body: "Your loyalty rewards are on display — a reason to pick you over the shop down the street.",
  },
  {
    id: "shop-reviews",
    route: "shop",
    anchor: "reviews",
    title: "Reviews you control",
    body: "Clients leave reviews right on your page. Nothing shows until you approve it.",
  },
  {
    id: "shop-book-cta",
    route: "shop",
    anchor: "book-cta",
    title: "One tap to book",
    body: "No app to download, no account to make. Let's follow the button and book a cut.",
  },
  {
    id: "book-services",
    route: "book",
    anchor: "services",
    title: "Real prices, per day",
    body: "Charge more on Saturdays? The menu shows the range, and the exact price appears for the day they pick — never a surprise.",
  },
  {
    id: "book-slots",
    route: "book",
    anchor: "slots",
    title: "Your calendar, plus specials",
    body: "Open times come straight from your hours. Publish a special-priced slot and it lands in the grid with a badge — like the late-night special here.",
  },
  {
    id: "book-waitlist",
    route: "book",
    anchor: "waitlist",
    title: "Booked solid? Waitlist.",
    body: "When you're full, clients join your waitlist — and get pinged automatically the moment a slot opens up.",
  },
  {
    id: "book-addons",
    route: "book",
    anchor: "addons",
    title: "Add-ons that upsell for you",
    body: "Hot towel, line-up — one-tap extras with a live running total. Try toggling one.",
  },
  {
    id: "book-checkout",
    route: "book",
    anchor: "checkout",
    title: "They confirm, you get paid",
    body: "Take cards and Apple Pay up front, or let them pay you direct on Zelle, Venmo, or Cash App — 0% fees, your money. Tap Next to see the confirmation.",
  },
  {
    id: "book-confirmation",
    route: "book",
    anchor: "confirmation",
    title: "Instant confirmation",
    body: "They get a manage link on the spot, and reminders go out on their own — 24 hours and 2 hours before the cut.",
  },
  {
    id: "manage-checkin",
    route: "manage",
    anchor: "checkin",
    title: "“On my way” check-in",
    body: "Before the appointment, one tap tells you they're en route — with an ETA. It lands on your agenda live. Try tapping it.",
  },
  {
    id: "rewards-punch-card",
    route: "rewards",
    anchor: "punch-card",
    title: "The punch card that fills itself",
    body: "Every completed visit earns a punch automatically — no stamps, no stickers, no forgetting. This is the page your clients keep coming back to.",
  },
  {
    id: "rewards-extras",
    route: "rewards",
    anchor: "loyalty-extras",
    title: "Status, VIP cards, and rebooking",
    body: "Bronze-to-Gold status, invite-only VIP cards, and a countdown that nudges the next booking. That's the loop that keeps your chairs full.",
  },
];

/**
 * 1-based position of a step id in the tour (0 = unknown id). The /demo entry
 * route and the feature search use this to deep-link `?step=N` without
 * hardcoding positions that would drift when steps are added.
 */
export function demoTourStepNumber(id: string): number {
  return DEMO_TOUR_STEPS.findIndex((s) => s.id === id) + 1;
}

/** Pages of the DASHBOARD tour (the barber side, on the demo tenant). */
export type DashboardTourRoute =
  | "overview"
  | "agenda"
  | "clients"
  | "rewards-manager"
  | "insights";

/**
 * The barber-side walkthrough: what a prospect sees exploring the demo shop's
 * dashboard through a read-only demo session (/demo/dashboard), and what a
 * signed-up barber can replay on their own dashboard to learn where things
 * live. Same DemoTour overlay, its own step list and storage key.
 */
export const DASHBOARD_TOUR_STEPS: DemoTourStep<DashboardTourRoute>[] = [
  {
    id: "dash-stats",
    route: "overview",
    anchor: "stats",
    title: "Your command center",
    body: "Visits, revenue, active clients, and rewards this month — the pulse you check with your morning coffee.",
  },
  {
    id: "dash-at-risk",
    route: "overview",
    anchor: "at-risk",
    title: "Win-backs, queued for you",
    body: "Regulars drifting past their usual rhythm surface here automatically — a rebooking nudge is one tap away.",
  },
  {
    id: "dash-activity",
    route: "overview",
    anchor: "activity",
    title: "Everything, as it happens",
    body: "Visits, punches, nudges that turned into bookings — your shop's live feed.",
  },
  {
    id: "dash-agenda",
    route: "agenda",
    anchor: "agenda",
    title: "Your day, live",
    body: "Tomorrow's lineup — and Will is already marked on the way. That green pill updates the second a client taps “On my way.”",
  },
  {
    id: "dash-services",
    route: "agenda",
    anchor: "booking-setup",
    title: "Prices that work like you do",
    body: "Services with per-day pricing and durations, add-ons that upsell, and one-off special slots — all managed here.",
  },
  {
    id: "dash-clients",
    route: "clients",
    anchor: "client-book",
    title: "Your book, forever yours",
    body: "Every client with history, punch balances, and loyalty status. Filter it, export it — it's your list, not ours.",
  },
  {
    id: "dash-rewards",
    route: "rewards-manager",
    anchor: "menu",
    title: "The loyalty engine",
    body: "Design your reward menu and VIP cards once — punches earn themselves after every completed visit.",
  },
  {
    id: "dash-insights",
    route: "insights",
    anchor: "charts",
    title: "Know your numbers",
    body: "Cuts per week, revenue trends, top services, busiest days. That's the whole owner side — ready to run your shop?",
  },
];

/** 1-based position of a step id in the dashboard tour (0 = unknown id). */
export function dashboardTourStepNumber(id: string): number {
  return DASHBOARD_TOUR_STEPS.findIndex((s) => s.id === id) + 1;
}
