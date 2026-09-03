/**
 * The help bot's knowledge base: every question a shop owner or a prospect can
 * ask, with a written answer.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT A MODEL: the bot answers instantly, offline,
 * at zero per-message cost, and it physically cannot invent a price, a policy,
 * or a feature we don't ship. The trade is that it only knows what's in this
 * file — so the file has to cover the product, and `helpMatch.ts` never
 * dead-ends when it doesn't.
 *
 * THREE RULES when adding an answer:
 *  1. Only state what's TRUE and verifiable in the app. If a mechanic is
 *     uncertain, answer with the destination ("that lives on X, here's the
 *     link") instead of guessing at behaviour. A confident wrong answer is
 *     worse than a confident pointer.
 *  2. `keywords` carries the matching load — put the words a barber would
 *     actually type, not the words we use internally. Typos are handled by the
 *     matcher; SYNONYMS are not, so list real alternate vocabulary.
 *  3. Mark `hidesInApp` on anything that quotes a plan price or steers to
 *     billing. Apple forbids both inside the iOS shell (Guideline 3.1.1) and
 *     this bot renders in-app like everything else.
 *
 * Every feature in FEATURE_INDEX is ALSO answerable without an entry here —
 * `helpMatch.ts` derives a "where do I find X" answer for each one, so this
 * file only carries the how/why/policy questions the index can't express.
 */

import { BILLING, DEFAULTS, PLANS } from "./constants.js";

export type HelpCategoryId =
  | "start"
  | "booking"
  | "money"
  | "clients"
  | "texting"
  | "integrations"
  | "brand"
  | "account";

export interface HelpCategory {
  id: HelpCategoryId;
  /** Section heading in the bot's "browse everything" view. */
  name: string;
}

/** Render order when the bot lists what it can help with. */
export const HELP_CATEGORIES: HelpCategory[] = [
  { id: "start", name: "Getting started" },
  { id: "booking", name: "Bookings & calendar" },
  { id: "money", name: "Plans & getting paid" },
  { id: "clients", name: "Clients, loyalty & promos" },
  { id: "texting", name: "Texting & the AI receptionist" },
  { id: "integrations", name: "Acuity & Square" },
  { id: "brand", name: "Your page & brand" },
  { id: "account", name: "Account, team & data" },
];

export interface HelpAnswer {
  id: string;
  /** The canonical phrasing. Doubles as the label on suggestion chips. */
  q: string;
  /** Body copy. `\n\n` separates paragraphs; no markup. */
  a: string;
  /** Alternate vocabulary a barber might type. Weighted heavily when matching. */
  keywords: string[];
  /**
   * Words this entry OWNS when they're ambiguous. Use sparingly, and only to
   * settle a genuine collision: "price" legitimately means both "what does
   * ChairBack cost" and "what do I charge for a fade", and without a declared
   * winner the tie falls wherever the wording happens to land. Declaring it
   * makes the editorial call explicit instead of accidental — the losing
   * reading is still one tap away in the suggestions.
   */
  primaryFor?: string[];
  category: HelpCategoryId;
  /**
   * Optional destination rendered as a button under the answer.
   *
   * 🔴 A FEATURE ID, never a route. The corpus used to carry 72 hand-written
   * hrefs, and they drifted from the feature index they were duplicating -
   * "how do I connect Acuity" and the index disagreed about which booking tab
   * the connect card lives on, and only one of them was right. Naming the
   * feature also makes the button role-aware for free: `resolveFeature` simply
   * refuses for a seat that cannot open it, instead of rendering a link that
   * 403s.
   */
  action?: { label: string; featureId: string };
  /**
   * Quotes a plan price or steers to the subscription flow — filtered out of
   * the corpus inside the native app (App Store Guideline 3.1.1), the same way
   * FeatureSearch drops its billing entries.
   */
  hidesInApp?: boolean;
}

const proPrice = `$${PLANS.pro.priceMonthlyUsd}`;
const proAiPrice = `$${PLANS.pro_ai.priceMonthlyUsd}`;
const proTexts = PLANS.pro.smsMonthlyQuota.toLocaleString();
const proAiTexts = PLANS.pro_ai.smsMonthlyQuota.toLocaleString();

export const HELP_ANSWERS: HelpAnswer[] = [
  /* ============================ Getting started ========================== */
  {
    id: "what-is-it",
    q: "What is ChairBack?",
    a: "It's booking, loyalty, and rebooking texts for barbershops, salons, and studios — in one place.\n\nClients book you online, every completed visit punches their card automatically, and the ones who drift get a perfectly-timed text to come back. You keep 100% of what you charge and you own your client list.",
    keywords: ["what is", "about", "explain", "overview", "what does it do", "chairback"],
    category: "start",
  },
  {
    id: "get-started",
    q: "How do I get set up?",
    a: "Four things, about fifteen minutes:\n\n1. Add your services with prices and durations.\n2. Set the hours you take appointments.\n3. Add any other barbers in the shop.\n4. Share your booking link.\n\nEverything else — punch cards, reminders, your public page — is already on and working the moment your first appointment lands.",
    keywords: [
      "set up", "setup", "start", "begin", "onboard", "new", "first steps",
      "getting started", "finish setting up", "finish setup", "setting up my shop",
      "go live", "finish my shop", "ready to launch",
    ],
    category: "start",
    action: { label: "Open booking setup", featureId: "online-booking" },
  },
  {
    id: "clients-need-app",
    q: "Do my clients need to download an app?",
    a: "No. Each client gets a private magic link to their punch card that opens right in their browser from a text. No account, no password, no app store.",
    keywords: ["download", "app store", "install", "client app", "do they need"],
    category: "start",
  },
  {
    id: "booking-link",
    q: "Where's my booking link?",
    a: "Your public page is your booking link — it's on your Shop page settings, ready to copy.\n\nPut it in your Instagram bio, your Google listing, and your text signature. It's the one link that does everything: services, prices, live openings, and booking.",
    keywords: [
      "link", "url", "share", "instagram bio", "my page", "booking link",
      "where do clients book", "booking page unavailable", "page unavailable",
      "booking page off", "booking page down",
    ],
    category: "start",
    action: { label: "Open Shop page", featureId: "mini-site" },
  },
  {
    id: "no-acuity",
    q: "I'm not on Acuity — can I still use it?",
    a: "Yes, completely. Add clients in seconds and tap \"Log visit\" after each appointment: punches, rewards, and rebooking texts all work exactly the same.\n\nYou can also just take bookings through ChairBack directly. Acuity only makes the syncing automatic, and you can connect it any time.",
    keywords: ["without acuity", "no acuity", "not on acuity", "manual", "log visit", "by hand"],
    category: "start",
  },
  {
    id: "import-clients",
    q: "Can I bring my existing clients over?",
    a: "Yes. If you connect Acuity or Square, your past appointments backfill automatically and those clients land in your client book with their history intact.\n\nIf you're coming from paper or a phone, add them from the client book — name and number is enough to start.",
    keywords: ["import", "existing clients", "migrate", "bring over", "transfer", "upload", "csv", "backfill"],
    category: "start",
    action: { label: "Open client book", featureId: "clients" },
  },
  {
    id: "which-industries",
    q: "Is it only for barbershops?",
    a: "No. Salons, nail studios, lash artists, spas, and tattoo studios run the exact same playbook: visits earn punches, drifting clients get a perfectly-timed text.\n\nPick your industry at signup and the defaults match your business — including what a visit is called.",
    keywords: ["salon", "nails", "lash", "spa", "tattoo", "industry", "barbershop only", "hair"],
    category: "start",
  },

  /* ========================== Bookings & calendar ======================== */
  {
    id: "how-booking-works",
    q: "How does online booking work?",
    a: "Clients open your page, pick a service, pick a barber, and pick from the times you're actually free. The slot is held the moment they confirm, and it disappears for everyone else immediately — no double bookings.\n\nThey get a confirmation right away, then automatic reminders before the appointment.",
    keywords: [
      "online booking", "how does booking work", "book online", "appointments", "schedule",
      "how do i book", "how to book", "available times", "what times", "times available",
      "openings", "free times",
    ],
    category: "booking",
    action: { label: "Open booking", featureId: "online-booking" },
  },
  {
    id: "set-hours",
    q: "How do I set my hours?",
    a: "Two layers, and the order matters.\n\nThe ceiling is per person: Calendar → Staff → Hours sets the days and times someone actually works. Nothing can be booked outside that.\n\nThen each service can narrow it further — a service you only do on weekends simply isn't bookable midweek. Service hours can shorten your day, never extend it, so if a time is missing, widen the staff hours first.\n\nIf you're the only one in the shop, saving hours on a service widens your own week to match, so you set them once and you're done.",
    keywords: [
      "hours", "availability", "schedule", "open times", "when i work",
      "working hours", "shifts", "change hours", "edit hours", "update hours",
      "set availability", "days off", "opening times",
      // "what are the shop's hours" was landing on reminders: "hours" hit here
      // but "shop" did not, and half-coverage loses.
      "shop hours", "business hours", "store hours", "what are your hours",
    ],
    primaryFor: ["hours"],
    category: "booking",
    action: { label: "Open services", featureId: "services" },
  },
  {
    id: "add-services",
    q: "How do I add a service or change a price?",
    a: "Services carry the name, price, duration, and the hours you offer them — add or edit them under Services.\n\nYou can also charge differently by weekday or by time of day (a Saturday fade priced above a Tuesday one), and the client sees the honest price for the slot they're picking.",
    keywords: [
      "service", "price", "menu", "duration", "add service", "change price",
      "cost of cut", "how long", "haircut", "takes", "minutes", "length",
      "services available", "what services", "which services", "available services",
      "service list", "what do you offer",
    ],
    category: "booking",
    action: { label: "Open services", featureId: "services" },
  },
  {
    id: "add-staff",
    q: "How do I add another barber?",
    a: "Add them under Staff. Each barber gets their own services and their own hours, and clients pick who they want when they book.\n\nStaff is about who takes appointments. If you also want them to sign in and see the dashboard, that's Team logins — a separate thing.",
    keywords: ["staff", "barber", "add barber", "another barber", "provider", "chairs", "stylist", "employee"],
    // "barber" on its own is the most ambiguous word in the corpus - it is in
    // move-appointment, remove-team-member, barber-cant-sign-in and the
    // per-barber pricing answer. Settle it here: a question that reduces to
    // just "barber" is about having barbers at all. This matters most INSIDE
    // the app, where the pricing answer is filtered out by 3.1.1 and a query
    // like "do you charge per barber" would otherwise fall to whichever entry
    // happened to list the word.
    primaryFor: ["barber"],
    category: "booking",
    action: { label: "Open staff", featureId: "staff" },
  },
  {
    id: "time-off",
    q: "How do I block off time or take a day off?",
    a: "Block the time on your agenda and it stops being bookable — it shows as a blocked span on the day so you can see exactly what's held.\n\nIf your Acuity calendar has blocked time on it, that syncs across too, so you only have to block it in one place.",
    keywords: ["block", "time off", "vacation", "day off", "holiday", "lunch", "break", "unavailable", "close"],
    category: "booking",
    action: { label: "Open agenda", featureId: "online-booking" },
  },
  {
    id: "approval-mode",
    q: "Can I approve bookings before they're confirmed?",
    a: "Yes. Turn on request-before-booking and a new booking holds the slot as pending until you approve it — so nobody lands in your chair without you saying yes first.\n\nThe slot stays reserved while it's pending, so you're not racing anyone to it.",
    keywords: ["approve", "approval", "pending", "screen clients", "confirm first", "request before booking", "vet"],
    category: "booking",
    action: { label: "Open booking settings", featureId: "booking-approval" },
  },
  {
    id: "recurring",
    q: "Can I set up a standing appointment?",
    a: "Yes. Book a client's every-N-weeks slot once and the whole series goes on the calendar in one shot.\n\nYou can edit the series later, or change a single date in it without touching the rest.",
    keywords: ["recurring", "repeat", "every 2 weeks", "standing", "regular", "series", "weekly", "biweekly"],
    category: "booking",
    action: { label: "Open booking", featureId: "online-booking" },
  },
  {
    id: "waitlist",
    q: "What happens when I'm fully booked?",
    a: "Full days feed a waitlist instead of turning people away. When a slot frees up — a cancellation, a moved appointment — the queue gets pinged automatically.\n\nThat's usually where a cancelled Saturday gets refilled before you've even noticed it opened.",
    keywords: ["waitlist", "wait list", "fully booked", "full", "cancellation", "standby", "sold out", "no slots"],
    category: "booking",
    action: { label: "Open booking settings", featureId: "waitlist" },
  },
  {
    id: "addons",
    q: "Can clients add extras to a booking?",
    a: "Yes. Set up add-ons — a hot towel, a beard trim, a wash — and clients tack them on while booking. The extra time and the extra money both land on the appointment.\n\nWhen the schedule has room for it, the add-on is offered; when it doesn't, it isn't.",
    keywords: ["add on", "addon", "extras", "upsell", "hot towel", "beard", "wash", "upgrade"],
    category: "booking",
    action: { label: "Open services", featureId: "addons" },
  },
  {
    id: "targeted-slots",
    q: "Can I publish a one-off slot at a special price?",
    a: "Yes — special-priced slots. Publish a specific time at its own price (a late-night cut, a model rate, a quiet-Tuesday special) and it shows up badged in the picker.\n\nYou can set them as a weekly schedule with start and end times, or as one-off dates, and edit either later.",
    keywords: ["special price", "targeted slot", "flash", "late night", "model rate", "discount slot", "one off", "deal slot"],
    category: "booking",
    action: { label: "Open services", featureId: "targeted-slots" },
  },
  {
    id: "reminders",
    q: "Do clients get reminders?",
    a: "Automatically. A confirmation when they book, then reminders 24 hours and 2 hours before the appointment. You don't do anything.\n\nThat pair is the single biggest thing you can do about no-shows.",
    keywords: ["reminder", "no show", "noshow", "confirmation", "notify", "forget", "24 hour", "text before"],
    category: "booking",
    action: { label: "Open booking settings", featureId: "reminders" },
  },
  {
    id: "check-in",
    q: "Can clients tell me they're on the way?",
    a: "Yes. They tap \"on my way\" once before the cut and you see their live status right on the agenda — so you know who's en route, who's arrived, and who's running late before they walk in.",
    keywords: ["check in", "on my way", "eta", "running late", "arrived", "en route", "status"],
    category: "booking",
    action: { label: "Open agenda", featureId: "online-booking" },
  },
  {
    id: "cancel-reschedule",
    q: "How does a client cancel or reschedule?",
    a: "Their confirmation carries a manage link — they cancel or move the appointment there themselves, and the freed slot goes straight back into the picker (and pings the waitlist).\n\nYou can also cancel or move anything yourself from the agenda.",
    keywords: [
      "cancel appointment", "reschedule", "move appointment", "change time", "client cancel",
      "edit an appointment", "edit appointment", "change an appointment", "amend booking",
      "change a booking", "edit booking",
    ],
    category: "booking",
    action: { label: "Open agenda", featureId: "online-booking" },
  },
  {
    id: "double-booking",
    q: "Can I get double-booked?",
    a: "No. A slot is held the instant it's taken and stops being offered to anyone else — including bookings that arrive from Acuity or Square, and including time you've blocked off.\n\nSynced appointments from your other calendar block your ChairBack slots too, so the two can't collide.",
    keywords: ["double book", "double booking", "overlap", "conflict", "two clients", "same time", "collide"],
    category: "booking",
  },

  /* ========================= Plans & getting paid ======================== */
  {
    id: "pricing",
    q: "How much does it cost?",
    a: `ChairBack is one plan. Premium (${proPrice}/month, ${proTexts} texts included) adds the texting that brings clients back: rebooking nudges, promo blasts, and auto-sync with Acuity or Square. Premium AI (${proAiPrice}/month, ${proAiTexts} texts included) adds an AI receptionist that answers client texts and books appointments 24/7.\n\nEvery new shop gets a ${BILLING.trialDays}-day full Premium trial, and one rebooked regular typically covers the month.`,
    keywords: ["cost", "price", "pricing", "how much", "plan", "subscription", "fee", "monthly", "expensive"],
    // A bare "price"/"cost" collides with add-services ("change a price").
    // A prospect asking the bot what it costs is by far the commoner intent.
    primaryFor: ["price", "cost", "pricing"],
    category: "money",
    hidesInApp: true,
    action: { label: "See plans", featureId: "pricing" },
  },
  {
    id: "whats-free",
    q: "Is there a free plan?",
    a: `No — ChairBack is one plan, and you get the whole thing free for ${BILLING.trialDays} days. No card to start, nothing to cancel if you walk away.

When the trial ends your shop stops taking bookings until you subscribe. Your clients, history and loyalty data stay exactly where they are, and you can read or export your client book at any time.`,
    keywords: ["free", "free plan", "no card", "forever", "free forever", "without paying"],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "commission",
    q: "Do you take a cut of my bookings?",
    a: "Zero. 0% commission, no per-booking fee, no cut of tips. What you charge is what you get.\n\nWe make money on the flat monthly plan and nothing else — and your client list stays yours to export whenever you want.",
    keywords: [
      "commission", "cut", "percentage", "per booking fee", "take a cut", "fees", "0%",
      "royalty", "cut of my haircuts", "cut of my cuts", "take a percentage", "your cut",
    ],
    // "cut" is the most overloaded word a barber can type - it is their JOB.
    // Editorially: someone asking what WE take is asking about commission;
    // someone asking about a haircut says so with other words.
    primaryFor: ["commission", "take a cut"],
    category: "money",
  },
  {
    id: "trial",
    q: "Is there a free trial?",
    // 🔴 This used to say "you drop to the free plan automatically", which
    // is not what the code does: hasActiveAccess() is subscription-or-trial,
    // so an expired trial with no subscription sets bookingPaused on the
    // public page and walls the dashboard. Two entries disagreeing about
    // money is the worst failure this file can have - whats-free had it right.
    a: `Yes — every new shop gets ${BILLING.trialDays} days of full Premium, and you don't need a card to start.\n\nNothing is ever charged unless you subscribe yourself. But the trial ending is not a downgrade: your booking page stops taking new bookings until you do. Your clients, history and loyalty data stay exactly where they are, and you can read or export your client book at any time.`,
    keywords: [
      "trial", "free trial", "try", "test", "30 days", "demo period", "trial end",
      "try it first", "try before", "before paying", "before i pay", "test drive", "try it out",
    ],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "get-paid",
    q: "How do I take payment?",
    a: "Two ways, and you can run both:\n\nCard and Apple Pay at booking — money goes straight into your own Stripe account, so payouts land in your bank on Stripe's normal schedule. Good for deposits and for cutting no-shows.\n\nOr show your Zelle, Venmo, or Cash App handle on the confirmation and get paid direct, with no processing fees at all.",
    keywords: ["payment", "get paid", "stripe", "apple pay", "card", "deposit", "prepay", "payout", "zelle", "venmo", "cash app", "money"],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "link-existing-stripe",
    q: "I already have a Stripe account — can I use that one?",
    a: "Yes — that's the only way it works now. On the Payments page tap \"Connect your Stripe account\", log in at Stripe and approve it. Payments then land in the account you already use, and you manage everything from the Stripe dashboard you already know.\n\nNo Stripe account yet? Create one free at stripe.com first (it takes a few minutes), then come back and tap Connect.\n\nIf you set one up through ChairBack earlier and it says Express, it still works — but if it was never finished, tapping Connect replaces it with your own account in one step.\n\nThe account is yours. ChairBack never holds your money.",
    keywords: ["existing stripe", "already have stripe", "link stripe", "connect stripe", "my stripe account", "use my own stripe", "stripe login", "same stripe"],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "when-paid-out",
    q: "When does the money reach my bank?",
    a: "Card payments go into your own Stripe account, not ours — we never hold your money — so payouts follow Stripe's schedule for your account, typically a couple of business days.\n\nZelle, Venmo, and Cash App are direct between you and the client, so that's instant and fee-free.",
    keywords: ["payout", "when do i get paid", "bank", "deposit time", "settlement", "transfer", "hold my money"],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "cancel-subscription",
    q: "How do I cancel my subscription?",
    a: "From your billing settings on the web — you can cancel any time, in a couple of taps, and keep your plan until the period you've already paid for runs out.\n\nAfter that you drop to the free plan. Your shop, your clients, and their punch cards all stay exactly where they are.",
    keywords: ["cancel", "unsubscribe", "stop paying", "downgrade", "end subscription", "quit", "cancel plan"],
    category: "money",
    hidesInApp: true,
    action: { label: "Open billing", featureId: "billing" },
  },
  {
    id: "change-card",
    q: "How do I update my card?",
    a: "In your billing settings on the web — update the card, see your invoices, and change plan from the same place.",
    keywords: ["card", "update card", "payment method", "credit card", "expired", "invoice", "receipt", "billing"],
    category: "money",
    hidesInApp: true,
    action: { label: "Open billing", featureId: "billing" },
  },
  {
    id: "billing-problem",
    q: "I have a billing problem or want a refund",
    a: "Email support@getchairback.com from the address on your account and we'll sort it out — a real person reads every message, usually within 1–2 business days.\n\nInclude your shop name so we can find the account straight away.",
    keywords: ["refund", "money back", "overcharged", "charged twice", "wrong charge", "billing issue", "dispute"],
    category: "money",
    hidesInApp: true,
  },

  /* ===================== Clients, loyalty & promos ======================= */
  {
    id: "punch-cards",
    q: "How do punch cards work?",
    a: "Automatically. Every completed visit punches the client's card — you don't hand out anything, and they don't carry anything.\n\nThey see their card on a private rewards page you text them, and when they hit the threshold the reward redeems right at the chair.",
    keywords: ["punch card", "loyalty", "stamps", "punches", "rewards", "free cut", "card"],
    category: "clients",
    action: { label: "Open rewards", featureId: "punch-cards" },
  },
  {
    id: "what-counts-punch",
    q: "What counts as a punch?",
    a: "Completed appointments — nothing else. Cancellations and no-shows never earn punches, so the cards stay honest.\n\nIf you ever need to correct one, you can adjust a client's balance from their profile in the client book.",
    keywords: ["counts", "what earns", "punch rules", "no show punch", "cancellation", "adjust balance", "fix punches"],
    category: "clients",
    action: { label: "Open client book", featureId: "clients" },
  },
  {
    id: "reward-threshold",
    q: "Can I change how many visits earn a reward?",
    a: `Yes — the threshold and what the reward actually is are both yours to set. New shops start at ${DEFAULTS.rewardThreshold} visits for a ${DEFAULTS.rewardLabel.toLowerCase()}, and you can change either any time.\n\nYou can also run more than one card type, including invite-only VIP cards for your best clients.`,
    keywords: ["threshold", "how many visits", "change reward", "10 visits", "reward menu", "free cut after"],
    category: "clients",
    action: { label: "Open rewards", featureId: "punch-cards" },
  },
  {
    id: "vip-cards",
    q: "What are VIP cards?",
    a: "Extra card types on top of your standard punch card — including invite-only VIP cards you hand to your best clients only.\n\nThere are also status tiers: clients climb Bronze → Silver → Gold on lifetime visits, automatically.",
    keywords: ["vip", "exclusive", "invite only", "tiers", "bronze", "silver", "gold", "status", "member"],
    category: "clients",
    action: { label: "Open rewards", featureId: "vip-cards" },
  },
  {
    id: "nudges",
    q: "How do rebooking nudges work?",
    a: "ChairBack watches how often each client normally comes in. When someone goes quiet past their own rhythm, they get an automatic \"time to rebook\" text or push — with a link straight to your booking page.\n\nIt's per-client, not a blanket blast, which is why it reads as your shop noticing rather than marketing.",
    keywords: ["nudge", "win back", "winback", "lapsed", "overdue", "come back", "retention", "drifting", "automatic text"],
    category: "clients",
    action: { label: "Open nudges", featureId: "rebook-nudges" },
  },
  {
    id: "promotions",
    q: "How do I run a promotion?",
    a: "Set up a promo and it shows on your public page — and you can text it out to the clients you choose.\n\nGood for filling a specific dead window: a slow Tuesday, a new barber's first month, a holiday push.",
    keywords: ["promo", "promotion", "deal", "special", "discount", "sale", "offer", "blast", "campaign"],
    category: "clients",
    action: { label: "Open promotions", featureId: "promotions" },
  },
  {
    id: "reviews",
    q: "How do reviews work?",
    a: "Clients leave reviews on your public page, and you approve what shows. Nothing goes live without you.",
    keywords: ["review", "rating", "stars", "testimonial", "feedback", "google review"],
    category: "clients",
    action: { label: "Open reviews", featureId: "reviews" },
  },
  {
    id: "referrals",
    q: "Do I get anything for referring another barber?",
    a: "Yes. Send your referral link — they get an extra month on top of their trial the moment they sign up, and you get a free month once their first invoice clears.\n\nNo cap on how many you refer.",
    keywords: ["referral", "refer", "refer a friend", "affiliate", "free month", "invite barber", "share link"],
    category: "clients",
    hidesInApp: true,
    action: { label: "Open referrals", featureId: "referrals" },
  },
  {
    id: "own-my-list",
    q: "Do I own my client list?",
    a: "Completely. It's your list, and you can export it whenever you want — no lock-in, no holding your contacts hostage if you leave.\n\nThat's deliberate: the whole point is that the relationship is yours, not ours.",
    keywords: ["own", "export", "my clients", "download list", "csv", "leave", "lock in", "take my data"],
    category: "clients",
    action: { label: "Open client book", featureId: "clients" },
  },
  {
    id: "insights",
    q: "What numbers can I see?",
    a: "Visits, revenue, retention, and loyalty trends over time — plus how much of your open chair time is actually booked, which is usually the number that changes behaviour.\n\nRevenue counts money actually earned, not the sum of tickets: a no-show is $0, not a sale.",
    keywords: [
      "insights", "analytics", "stats", "numbers", "revenue", "reports", "trends",
      "chair time", "how am i doing", "made", "earned", "earnings", "income",
      "last month", "profit", "much did i make", "busy", "utilization",
    ],
    category: "clients",
    action: { label: "Open insights", featureId: "insights" },
  },

  /* =================== Texting & the AI receptionist ===================== */
  {
    id: "how-many-texts",
    q: "How many texts do I get?",
    a: `Premium includes ${proTexts} a month, Premium AI includes ${proAiTexts}. That covers rebooking nudges, win-backs, and promo blasts.\n\nIt's a hard stop at the quota — no surprise overage bills, ever. The dashboard shows a usage meter so you can see where you are.`,
    keywords: ["texts", "sms", "quota", "how many", "limit", "messages", "overage", "run out"],
    category: "texting",
    hidesInApp: true,
  },
  {
    id: "opt-out",
    q: "How does a client stop texts?",
    a: "They reply STOP to any message and they're opted out instantly — that's automatic and required by law.\n\nYou can also opt anyone out (or back in) yourself from their profile in the client book.",
    keywords: ["stop", "opt out", "unsubscribe", "no texts", "quit texting", "remove from texts", "spam"],
    category: "texting",
  },
  {
    id: "consent",
    q: "Do I need permission to text clients?",
    a: "Yes, and ChairBack handles it. Clients consent when they book or sign up, STOP replies opt them out instantly, and send caps stop any runaway texting.\n\nEvery message is logged, so if it's ever questioned you have the record.",
    keywords: ["consent", "permission", "legal", "compliance", "tcpa", "allowed", "opt in", "10dlc"],
    category: "texting",
  },
  {
    id: "text-replies",
    q: "Where do client replies go?",
    a: "Your Inbox. Every text conversation with a client lands there, including the ones the AI receptionist handled — so you can read the whole thread and jump in whenever you want.",
    keywords: ["reply", "replies", "inbox", "conversation", "respond", "messages", "thread", "they texted back"],
    category: "texting",
    action: { label: "Open inbox", featureId: "inbox" },
  },
  {
    id: "receptionist",
    q: "What does the AI receptionist do?",
    a: "It answers client texts and books appointments 24/7, while you're behind the chair.\n\nIt knows your services, your prices, and your real openings, so it books into actual free slots — and it hands off to you in the Inbox whenever something needs a human.\n\nTo be clear about what it isn't: it handles text messages, not voice calls. It won't pick up the phone. It's included on the Premium AI plan.",
    keywords: [
      "ai", "receptionist", "answering", "missed call", "text booking", "assistant",
      "robot", "auto reply", "bot", "phone", "call", "voice", "answer", "24/7",
    ],
    primaryFor: ["receptionist", "ai"],
    category: "texting",
    hidesInApp: true,
    action: { label: "Open billing", featureId: "billing" },
  },

  /* ============================ Acuity & Square ========================== */
  {
    id: "acuity",
    q: "Does it work with my Acuity account?",
    a: "Yes. Connect Acuity once with one click. Past appointments backfill automatically, and new ones flow in as they happen.\n\nBlocked time on your Acuity calendar syncs too, so your ChairBack availability matches reality without you maintaining two calendars.",
    keywords: ["acuity", "acuity scheduling", "connect acuity", "squarespace scheduling", "sync"],
    category: "integrations",
    action: { label: "Connect a calendar", featureId: "integrations" },
  },
  {
    id: "square",
    q: "Does it work with Square?",
    a: "Yes — connect Square the same way, with one click, and your appointments sync across automatically.",
    keywords: ["square", "square appointments", "connect square", "pos", "point of sale"],
    category: "integrations",
    action: { label: "Connect a calendar", featureId: "integrations" },
  },
  {
    id: "what-syncs",
    q: "What actually syncs from my calendar?",
    a: "Appointments and blocked time, both directions of change: a booking that moves in Acuity moves here, and one that's deleted there disappears here.\n\nSynced appointments also block your ChairBack slots, so the two calendars can't double-book you. It re-syncs on its own every 30 minutes on top of the live updates.",
    keywords: ["sync", "syncing", "what syncs", "how often", "refresh", "update", "backfill", "two calendars"],
    category: "integrations",
  },
  {
    id: "connect-ai-assistant",
    q: "How do I connect ChatGPT or Claude to my shop?",
    a: "Open the Assistant tab and press “Show me step-by-step” — it walks you through it for whichever one you use.\n\nThe short version: copy the connection address on that page, then in Claude or ChatGPT go to Settings → Connectors, add a custom connector, and paste it. You'll be asked to sign in to ChairBack and approve exactly what the assistant can read.\n\nOne thing people get wrong: in Claude's setup box, leave the options it marks “Detected”. Don't switch the OAuth client to the one labelled “Recommended” — ChairBack registers your assistant automatically, and that other option won't connect.\n\nBefore you start, check your plan can do it at all. Claude: a paid personal plan is enough. ChatGPT: custom connectors are limited to Business, Enterprise and Edu workspaces, an admin has to turn on developer mode, and the feature is in beta — a personal ChatGPT plan can't add one at any price, so use Claude instead.\n\nYour AI provider handles the conversation under your own plan. ChairBack never charges you for AI.",
    keywords: [
      "connect",
      "chatgpt",
      "claude",
      "ai",
      "assistant",
      "connector",
      "mcp",
      "hook up",
      "link ai",
      "custom connector",
    ],
    category: "integrations",
    action: { label: "Open the Assistant", featureId: "assistant" },
  },
  {
    id: "ai-assistant-cant-connect",
    q: "My AI assistant won't connect — what now?",
    a: "Three things cover almost every case:\n\n1. In Claude, the OAuth client option has to be the one marked “Detected” — “No client ID — register one automatically”. The one labelled “Recommended” doesn't work with ChairBack.\n2. No option to add a custom connector at all? That's your AI plan, and the two are not alike. In Claude it comes with a paid personal plan. In ChatGPT it is limited to Business, Enterprise and Edu workspaces, an admin has to turn on developer mode, and it is still in beta — so a personal ChatGPT plan won't show the option however much you pay for it. On a personal plan, use Claude. Either way it isn't something ChairBack can switch on.\n3. Sign in to ChairBack in the same browser first, then start the connection again.\n\nIf it connected but can't see something, check the Assistant tab — it lists exactly what you approved. Disconnect and reconnect to change it.",
    keywords: [
      "won't connect",
      "connection failed",
      "error connecting",
      "can't connect",
      "connector not working",
      "recommended",
      "detected",
      "oauth",
      "troubleshoot ai",
    ],
    category: "integrations",
    action: { label: "Open the Assistant", featureId: "assistant" },
  },
  {
    id: "ai-assistant-what-it-sees",
    q: "What can a connected AI assistant see, and can it change anything?",
    a: "It can only READ, and only what you ticked when you connected it. It cannot book, cancel, move, refund or message anyone — there's nothing in ChairBack that lets it.\n\nIt never sees phone numbers, email addresses or your private notes. Clients come back as a first name and a last initial, which is enough to answer “who's my 2:15?” without copying your client list into someone else's system.\n\nThe Assistant tab lists every connected assistant, what it can read, and when it last looked. Disconnect stops it immediately — not whenever something expires.",
    keywords: [
      "what can it see",
      "privacy",
      "safe",
      "read only",
      "permissions",
      "can it book",
      "can it cancel",
      "data",
      "phone numbers",
      "security ai",
    ],
    category: "integrations",
    action: { label: "Open the Assistant", featureId: "assistant" },
  },
  {
    id: "ai-assistant-disconnect",
    q: "How do I disconnect an AI assistant?",
    a: "Assistant tab → find it in the list → Disconnect. It stops on that assistant's very next request; you don't wait for anything to expire.\n\nIf someone leaves your shop, their assistant is cut off automatically the moment you remove them from the team — you don't have to remember to do it.",
    keywords: [
      "disconnect",
      "revoke",
      "remove ai",
      "stop assistant",
      "unlink",
      "turn off ai",
      "cut off",
    ],
    category: "integrations",
    action: { label: "Open the Assistant", featureId: "assistant" },
  },
  {
    id: "ai-assistant-plan",
    q: "Which ChairBack plan do I need to connect an AI assistant?",
    a: "Premium or Premium AI, or an active trial.\n\nEverything else on the Assistant tab — your setup status, what's blocking bookings, guides, and finding your way around — works on any plan, connected or not. Only the connection itself needs the plan.\n\nSeparately, your AI provider's own plan decides whether you can add custom connectors at all. ChairBack doesn't sell or provide AI credits.",
    keywords: [
      "plan",
      "premium",
      "which plan",
      "cost",
      "price ai",
      "upgrade",
      "trial",
      "included",
    ],
    category: "integrations",
    action: { label: "Open the Assistant", featureId: "assistant" },
  },
  {
    id: "other-tools",
    q: "I use a different booking tool — can you support it?",
    a: "Acuity and Square are the two we connect to directly today.\n\nIf you're on something else, email support@getchairback.com and tell us which one — that's genuinely how we decide what to build next. In the meantime everything works manually, and it's fast.",
    keywords: ["booksy", "vagaro", "fresha", "styleseat", "google calendar", "calendly", "other", "different tool", "schedulicity"],
    category: "integrations",
  },

  /* =========================== Your page & brand ========================= */
  {
    id: "public-page",
    q: "What is my public page?",
    a: "Your own booking mini-site — services, prices, photos, reviews, promos, and a book button. It's the link you put in your Instagram bio.\n\nIt's free on every plan, and it's live the moment you add your first service.",
    keywords: ["public page", "mini site", "website", "landing page", "my site", "shop page", "profile"],
    category: "brand",
    action: { label: "Open Shop page", featureId: "mini-site" },
  },
  {
    id: "branding",
    q: "Can I change the colors and logo?",
    a: "Yes — themes, fonts, accent colour, and your logo, so your page and your clients' rewards hub look like your shop and not like a template.",
    keywords: [
      "theme", "colors", "colours", "logo", "font", "branding", "customize", "look",
      "design", "style", "add my logo", "upload logo", "my logo", "change logo", "picture of my shop",
    ],
    category: "brand",
    action: { label: "Open Shop page", featureId: "themes" },
  },
  {
    id: "gallery",
    q: "Can I show photos of my work?",
    a: "Yes — the photo gallery on your public page. It's the thing new clients actually scroll before they book, so it's worth keeping fresh.",
    keywords: ["photos", "gallery", "pictures", "portfolio", "images", "my work", "before after"],
    category: "brand",
    action: { label: "Open Shop page", featureId: "gallery" },
  },

  /* ======================= Account, team & data ========================== */
  {
    id: "change-login",
    q: "How do I change my password or email?",
    a: "Both live in your Account settings, along with your name and profile photo.",
    keywords: ["password", "change password", "email", "change email", "login", "forgot", "reset", "profile", "photo"],
    category: "account",
    action: { label: "Open account", featureId: "account" },
  },
  {
    id: "team-logins",
    q: "Can my barbers have their own logins?",
    a: "Yes. Invite them under Team logins and each one signs in to their own view — an employee sees their own chair and their own clients, not the whole shop's numbers.\n\nThat's separate from Staff, which is just who takes appointments.",
    keywords: ["team", "logins", "invite", "seats", "roles", "permissions", "employee login", "manager", "access"],
    category: "account",
    action: { label: "Open team", featureId: "team" },
  },
  {
    id: "delete-account",
    q: "How do I delete my account and data?",
    a: "From your Account settings — choose Delete account. It permanently removes your login, every shop you own, and all of its clients, visits, punches, and nudges, and cancels any active subscription.\n\nIt can't be undone. If you'd rather we handled it, email support@getchairback.com from the address on your account.",
    keywords: ["delete", "delete account", "remove data", "close account", "erase", "gdpr", "wipe", "shut down"],
    category: "account",
    action: { label: "Open account", featureId: "account" },
  },
  {
    id: "privacy",
    q: "Is my data safe? Who can see it?",
    a: "Your shop's data is yours and is isolated from every other shop on ChairBack — nobody else's dashboard can reach it.\n\nWe never sell client data, and we never text your clients on our own behalf. The Privacy Policy lists exactly what we store and how long we keep it.",
    keywords: ["privacy", "safe", "secure", "security", "who sees", "sell data", "gdpr", "encrypted", "confidential"],
    category: "account",
    action: { label: "Read the privacy policy", featureId: "privacy" },
  },
  {
    id: "ios-app",
    q: "Is there an app for me, the owner?",
    a: "Yes — ChairBack is on the iOS App Store, and it's the same dashboard in a native shell with push notifications.\n\nYour clients still don't need it: they use the magic link you text them.",
    keywords: ["ios", "iphone", "app", "android", "download", "native", "push", "mobile app", "app store"],
    category: "account",
  },
  {
    id: "custom-domain",
    q: "How do I connect my own domain?",
    a: "It lives at the bottom of your page settings: open your dashboard, tap More, then Public shop page, and scroll down to \"Use your own domain.\"\n\nFrom there:\n1. Type your domain (like drickcuttinup.com) and tap Connect.\n2. Two records appear. Add them wherever you bought the domain (GoDaddy, Namecheap, Squarespace…) — in that site's DNS settings, add an A record with name @ and value 76.76.21.21, and a CNAME record with name www and value cname.vercel-dns.com.\n3. Come back and tap \"I've added them — check again.\" It usually flips to Connected within minutes; DNS can occasionally take up to 48 hours.\n\nOnce it's Connected, anyone who types your domain lands straight on your ChairBack page. Google search results show your page's getchairback.com address — your domain is the door, your ChairBack page is the shop.",
    keywords: [
      // "my website URL", not "address": the word "address" belongs to the
      // street-address answer (show-up-on-google) since #204 added real ones.
      "domain", "custom domain", "own url", "dns", "www", "my website url",
      "godaddy", "namecheap", "squarespace domain", "connect domain",
      "point domain", "bought a domain", "add domain", "where domain",
      "a record", "cname", "hook up domain", "link domain",
    ],
    primaryFor: ["domain", "dns"],
    category: "brand",
    action: { label: "Open Shop page", featureId: "custom-domain" },
  },
  {
    id: "show-up-on-google",
    q: "How do I show up on Google?",
    a: "Three things, all on your page settings (dashboard → More → Public shop page):\n\n1. Fill in your address — street, city, state, ZIP. That's what tells Google you're a real local business, which is how you appear for searches like \"barber near me.\" It's the single biggest lever.\n2. Keep your page live, with your services, photos, and reviews on it — that's the page Google reads and shows, at your getchairback.com/s/ link.\n3. Own a domain? Connect it in the same place, and people who type it land straight on your page.\n\nGoogle indexes on its own schedule, so a brand-new page can take days to appear — but the address is what does the heavy lifting.",
    keywords: [
      "google", "search", "seo", "show up", "found", "findable", "searchable",
      "rank", "near me", "google maps", "search results", "visibility",
      "discover", "appear", "address", "add my address", "street address",
      "my location", "zip",
    ],
    primaryFor: ["google", "seo", "address"],
    category: "brand",
    action: { label: "Open Shop page", featureId: "mini-site" },
  },
  {
    id: "shop-name",
    q: "How do I change my shop name?",
    a: "In your Account settings — your shop's name and details live there, next to your own profile.\n\nThe look of your public page — logo, colours, photos — is separate, on the Shop page.",
    // "address" deliberately NOT a keyword here: the street address lives on
    // the Shop page (it feeds Google), and show-up-on-google owns that word.
    keywords: ["shop name", "rename", "business name", "change name", "shop details"],
    category: "account",
    action: { label: "Open account", featureId: "account" },
  },
  {
    id: "contact-human",
    q: "How do I talk to a real person?",
    a: "Email support@getchairback.com — one channel for everything, and a real person reads every message. We typically reply within 1–2 business days.\n\nInclude your shop name so we can find your account quickly.",
    keywords: [
      "support", "contact", "human", "help", "email", "talk to someone", "phone number",
      "reach you", "someone", "call you", "speak to", "customer service", "get hold of you",
    ],
    // Someone asking for a number to CALL wants us, not the AI receptionist
    // (which answers THEIR clients). The receptionist entry owns "receptionist"
    // and "ai"; this one owns being contacted.
    primaryFor: ["phone number", "call you", "support"],
    category: "account",
    action: { label: "Open support", featureId: "support" },
  },

  /* =============================== The rest ==============================
   * Questions that came out of watching what people actually type — money
   * mechanics we hadn't stated, and the four or five "something looks wrong"
   * questions that are the real bulk of support.
   * ====================================================================== */
  {
    id: "contract",
    q: "Am I locked into a contract?",
    a: "No. It's month to month and you can cancel any time — no term, no cancellation fee, no phone call to get out of it.\n\nIf you leave, you keep your client list. Export it on your way out.",
    keywords: ["contract", "locked in", "commitment", "term", "annual", "long term", "obligation", "trap"],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "tips",
    q: "Do you take a cut of tips?",
    a: "Never. Not a cent, same as bookings.\n\nCard payments land in your own Stripe account, and Zelle, Venmo, and Cash App are straight between you and the client. Whatever they add on top is yours.",
    keywords: ["tip", "tips", "tipping", "gratuity", "cut of tips"],
    category: "money",
  },
  {
    id: "no-show-fee",
    q: "Can I charge for a no-show?",
    a: "Yes — take card at booking. Once you're collecting payment up front, a no-show has already paid, which is the only thing that reliably changes the behaviour.\n\nOn top of that, the automatic 24-hour and 2-hour reminders do most of the work, and a no-show never earns a punch.",
    keywords: ["no show", "noshow", "no show fee", "charge for missing", "flake", "didnt turn up", "missed appointment", "penalty"],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "texts-run-out",
    q: "What happens if I run out of texts?",
    a: "Sending stops at your monthly quota — that's a hard stop, so you never get a surprise bill for going over.\n\nThe quota resets at the start of each calendar month, and the dashboard shows a usage meter so it isn't a surprise either.",
    keywords: [
      "run out", "go over", "over quota", "exceed", "limit", "out of texts",
      "used up", "happens", "overage", "extra texts", "more texts",
    ],
    category: "texting",
    hidesInApp: true,
  },
  {
    id: "more-clients",
    q: "How do I get more clients?",
    a: "Three things, in the order that actually works:\n\n1. Put your booking link in your Instagram bio and your Google listing — most shops leak more bookings here than anywhere else.\n2. Turn on rebooking nudges, so the clients you already have come back on their own rhythm. Winning back a regular is far cheaper than finding a stranger.\n3. Ask for reviews, and run a promo into your slowest window.",
    keywords: ["more clients", "grow", "marketing", "new clients", "busy", "empty chair", "slow", "fill my chair", "advertise"],
    category: "clients",
  },
  {
    id: "turn-off-rewards",
    q: "Can I turn punch cards off?",
    a: "Yes — loyalty is a switch in your Rewards settings, and everything else (booking, reminders, your public page) works exactly the same with it off.\n\nTurning it back on later keeps the visit history, so nobody loses credit for cuts they already had.",
    keywords: ["turn off", "disable", "switch off", "dont want", "hide rewards", "no loyalty", "remove punch"],
    category: "clients",
    action: { label: "Open rewards", featureId: "punch-cards" },
  },
  {
    id: "slot-not-showing",
    q: "A time isn't showing up for clients — why?",
    a: "Almost always one of these, in the order worth checking:\n\n1. The service's own hours don't cover that time — hours live on the service, so a service can be narrower than your day.\n2. Something already occupies it: a booking, blocked time, or an appointment synced in from Acuity or Square.\n3. The service is long enough that it won't fit before you close.\n4. You've hit a daily cap for that service or group.\n\nIf none of those explain it, email support@getchairback.com with the date and service and we'll look at the actual slot data.",
    keywords: [
      "not showing", "missing slot", "no times", "cant book", "no availability",
      "doesnt show", "wont show", "empty calendar", "no slots", "why cant",
      "disappeared", "not bookable",
    ],
    category: "booking",
    action: { label: "Open services", featureId: "services" },
  },
  {
    id: "client-didnt-get-text",
    q: "A client didn't get their text",
    a: "Check these three, in order:\n\n1. They replied STOP at some point — that opts them out permanently until they opt back in. Their profile in the client book shows it.\n2. Their number is wrong or is a landline.\n3. You've hit your monthly text quota, which stops sending.\n\nThe Inbox holds every message we sent them, so you can see exactly what went out and when.",
    keywords: [
      "didnt get", "not received", "no text", "text didnt send", "missing text",
      "never got", "delivery", "not delivered", "failed", "wasnt sent",
      "never got the reminder", "didnt get the reminder", "no reminder", "reminder didnt",
    ],
    category: "texting",
    action: { label: "Open inbox", featureId: "inbox" },
  },
  /* ===================== Email, calendar and Wallet =======================
   * Everything a client receives after booking, and the three questions the
   * corpus could not answer at all before: where the confirmation went, how
   * the appointment reaches a phone calendar, and what Apple Wallet does.
   *
   * 🔴 Written against the shipping code, not the roadmap. The confirmation
   * SMS is switched OFF, so email is the ONLY thing that tells a client their
   * booking exists; the calendar file is a LINK in that email rather than an
   * attachment; and the Wallet passes need an Apple certificate that is a
   * ChairBack-side step, so the copy says "if the button isn't there" instead
   * of promising one.
   * ====================================================================== */
  {
    id: "confirmation-email",
    q: "What does a client receive after booking?",
    a: "Yes — an email, immediately. It confirms the service, who they're with and the time, and it carries their own reschedule-or-cancel link so they can move it without calling you.\n\nThat email is the only confirmation we send, which is why the booking form asks for an email address. The reminder before the appointment still goes out as a text.\n\nIf you take bookings as requests, the confirmation goes out when you approve — not when they ask.",
    keywords: [
      "confirmation", "confirmation email", "booking email", "do they get an email",
      "does the client get", "receipt", "booking confirmed email", "what do they receive",
    ],
    category: "booking",
    action: { label: "Open booking", featureId: "online-booking" },
  },
  {
    id: "email-didnt-arrive",
    q: "A client didn't get their confirmation email",
    a: "Work down this list — it's ordered by how often each one is the answer:\n\n1. It's in spam or Promotions. Ask them to look there first; it's the usual culprit.\n2. The address has a typo, or they booked with an old one. The appointment shows the address it was sent to.\n3. You take bookings as requests and haven't approved this one yet — nothing is sent until you approve.\n4. The appointment was added by you or came in from Acuity or Square without an email address, so there was nobody to write to.\n\nIf none of those fit, email support@getchairback.com with the shop name and the appointment time and we'll trace that specific message.\n\nWorth knowing: their booking is real either way. The email is a notification, not the booking, so nothing is lost while you sort it out.",
    keywords: [
      "didnt get email", "no confirmation email", "email never arrived", "email didnt send",
      "missing confirmation", "never got the email", "email not received", "no email",
      "client didnt get the email", "confirmation didnt arrive",
    ],
    // 🔴 NO primaryFor HERE, AND IT IS NOT AN OVERSIGHT. It reads as "this
    // entry owns the phrase", but scoring is per TOKEN: declaring
    // "confirmation email" hands this entry the bare word "email" at primary
    // weight, and it then swallows every question about spam, cancellations
    // and texts. Measured, not guessed - it cost three right answers.
    category: "booking",
  },
  {
    id: "email-in-spam",
    q: "Our emails are going to spam",
    a: "Ask the client to open the message, mark it as \"not spam\", and add the sender to their contacts. That teaches their mailbox for every future one, and it's the single most effective thing anyone can do.\n\nWe can't promise where a mailbox files a message — no sender can — but the sending domain is set up properly on our side, so this is usually a one-time fix per client.\n\nIf a whole run of clients reports it at once, email support@getchairback.com and we'll look into it.",
    keywords: [
      "spam", "junk", "junk folder", "promotions tab", "not in inbox", "filtered",
      "going to spam", "spam folder", "blocked", "confirmation", "went to spam",
      "email went to spam", "confirmation email went to spam",
    ],
    primaryFor: ["spam", "junk"],
    category: "booking",
  },
  {
    id: "cancellation-email",
    q: "Does a client get an email when an appointment is canceled?",
    a: "Yes — whether you cancel it or they do. It tells them the appointment is no longer booked and offers a link to book another time.\n\nIt's queued the instant the cancellation saves, so it survives a restart or a hiccup at our end and can't go out twice.\n\nTwo deliberate exceptions: marking someone a no-show sends nothing, and an appointment with no email address on it has nobody to write to.",
    keywords: [
      "cancellation email", "canceled email", "cancel email", "do they get told",
      "does the client know", "notify cancel", "cancellation notice",
      "cancellation email never arrived", "never got the cancellation email",
      "no cancellation email", "cancellation email didnt arrive",
    ],
    category: "booking",
  },
  {
    id: "add-to-calendar",
    q: "How does a client add the appointment to their calendar?",
    a: "The confirmation email has an \"Add to Calendar\" button. Tapping it opens the appointment in whatever calendar they use — Apple Calendar, Google Calendar and Outlook all handle it.\n\nIf they reschedule, the new confirmation updates the entry they already saved instead of leaving two.\n\nOne thing to tell them: cancelling doesn't remove it from their calendar. We don't reach into a calendar we don't own, so they'll want to delete that entry themselves.",
    keywords: [
      "add to calendar", "calendar", "ics", "apple calendar", "google calendar", "outlook",
      "calendar invite", "save the appointment", "iphone calendar", "put it in my calendar",
    ],
    primaryFor: ["add to calendar", "calendar invite", "ics"],
    category: "booking",
  },
  {
    id: "apple-wallet",
    q: "Can a client keep their punch card or appointment in Apple Wallet?",
    a: "That's built, in two pieces: a punch card that lives in Wallet and updates its balance on its own, and an appointment pass that shows the time and greys itself out if the booking is canceled.\n\nOn an iPhone, the Add to Apple Wallet button shows up on their rewards page, and on the confirmation email for the appointment one. It doesn't appear inside the ChairBack app itself — that's an Apple limitation, so send them to the page in Safari.\n\nIf the button isn't there at all, Wallet passes aren't switched on yet. That's a one-time setup on our side, not something you can enable — email support@getchairback.com and we'll tell you where it stands.",
    keywords: [
      "wallet", "apple wallet", "pkpass", "add to wallet", "phone wallet", "passbook",
      "digital punch card", "card in wallet", "wallet pass",
    ],
    primaryFor: ["wallet", "apple wallet"],
    category: "clients",
    action: { label: "Open rewards", featureId: "punch-cards" },
  },
  /* ======================== Rewards access ================================
   * How a client gets back to their punch card. Three questions the corpus
   * could not answer at all, two of which it answered CONFIDENTLY WRONG:
   * "how do I recover my rewards" returned the entry about switching rewards
   * OFF, and a broken rewards link returned the generic page-not-loading one.
   *
   * 🔴 The one-shop rule shapes this copy: a rewards surface must never reveal
   * that a phone number exists at another shop. The recovery flow only shows
   * a chooser AFTER the person proves they hold the phone, so the answers
   * below describe verification first and never promise a lookup by name.
   * ====================================================================== */
  {
    id: "rewards-link-broken",
    q: "A client's rewards link stopped working",
    a: "Their punches are fine — the link is just a door, and the punches live on their profile.\n\nSend them to the \"Find my rewards\" page. They put in the mobile number you have for them, we text a 6-digit code, and they're back in. It's on your booking page, and a dead link now offers it automatically.\n\nA link stops working for one of two reasons: someone replaced it (the \"New link\" button on their profile kills every old one, which is exactly what you want if a link leaked), or the number moved to a different profile.\n\nIf they can't get the code, check the number on their profile is the one they're texting from.",
    keywords: [
      "link not working", "rewards link broken", "link expired", "link doesnt work",
      "lost link", "lost rewards", "cant open rewards", "rewards link dead",
      "punch card link", "qr code", "qr not working", "link stopped working",
    ],
    // No primaryFor: "reward" belongs to the punch-card entry. A broken link
    // is a door problem, not what rewards ARE.
    category: "clients",
    action: { label: "Open rewards", featureId: "punch-cards" },
  },
  {
    id: "recover-rewards",
    q: "How does a client get their rewards back if they lost the link?",
    a: "They verify their phone. On the \"Find my rewards\" page they enter their mobile number, we text a 6-digit code that lasts five minutes, and once it checks out they pick their business and land straight on their punch card.\n\nThe number has to be one you already have on their profile and they must not have texted STOP. Nothing is revealed before they verify — the page looks identical whether or not that number is on file, which is deliberate: it stops anyone fishing for whether someone is a client here.\n\nIf their number changed, update it on their profile first and then send them through.",
    keywords: [
      "recover", "recovery", "find my rewards", "get rewards back", "verify phone",
      "forgot link", "restore rewards", "lost punches", "cant find rewards",
      "phone verification", "6 digit code", "verification code",
    ],
    // Single words only, and deliberately not "rewards": see above.
    primaryFor: ["recover", "recovery"],
    category: "clients",
  },
  {
    id: "resend-rewards-link",
    q: "How do I send a client their rewards link again?",
    a: "It depends which seat you're in.\n\nOn a chair seat, the \"Your clients\" card on your home screen has a \"Text link\" button next to everyone you've served — one tap and it's sent.\n\nAs the owner or a manager, open the client and use \"Copy rewards link\", then send it however you like. That page also has \"New link\", which mints a fresh one and kills every link they've been sent before — use that if a link ended up somewhere it shouldn't have, not for a routine resend.\n\nTexting is limited on purpose: the same link won't resend for five minutes, there's a daily cap per client, and anyone who texted STOP can't be texted at all until they text START themselves. If you're blocked, point them at \"Find my rewards\" instead — that door is theirs, not yours.",
    keywords: [
      "resend", "send link again", "text link", "send rewards link", "text their link",
      "send them their link", "share rewards link", "copy rewards link", "new link",
    ],
    primaryFor: ["resend", "text link"],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  /* ===================== Shop settings people ask about ===================
   * Three more the corpus could not answer. All three were measured returning
   * a confidently WRONG answer: business type landed on renaming the shop, and
   * "what's my cancellation policy" landed on generic billing copy.
   * ====================================================================== */
  {
    id: "change-business-type",
    q: "How do I change my business type?",
    a: "It's on your dashboard home, in the \"Business type\" card — pick the one that fits and save. Nine are on the list, from barbershop and hair salon through nails, lashes, spa, tattoo and detailing.\n\nIt changes wording only: what ChairBack calls your team, your workspaces and a visit. Nothing is renamed or moved — your services, appointments, clients, team and connected calendars are all untouched, and it never affects your plan or what anyone can do.\n\nYou can change it as often as you like. Owners and managers can; a chair seat doesn't see the card.",
    keywords: [
      "business type", "industry", "vertical", "not a barbershop", "nail salon",
      "change industry", "salon instead", "type of business", "what kind of business",
      "nail studio", "studio", "switch", "i run a", "im not a barbershop",
      "spa", "tattoo", "detailing", "lashes", "vocabulary", "wording",
    ],
    primaryFor: ["business type", "industry"],
    category: "account",
  },
  {
    id: "shop-address",
    q: "Where do I set my shop's address?",
    a: "Dashboard → Your page, in the \"About\" card: street, city, state and ZIP.\n\nBe aware of what it's actually for. It's what puts you in Google's results as a local business, and it's what fills in the location when a client saves the appointment to their calendar. It is not printed as text on your public page — if you want clients to read your address there, put it in the free-text hours or description field as well.",
    keywords: [
      "address", "location", "where is the shop", "street", "city", "zip", "postcode",
      "set my address", "shop address", "directions", "map",
    ],
    primaryFor: ["address", "location"],
    category: "brand",
    action: { label: "Open your page", featureId: "mini-site" },
  },
  {
    id: "my-policy",
    q: "What is my cancellation policy set to?",
    a: "Dashboard → Payments holds all of it: how customers pay, the free-cancel cutoff in hours, and the fee charged inside that cutoff.\n\nA cutoff of 0 means every cancellation is a full refund. A fee of 100% means no refund inside the cutoff.\n\nOne catch worth knowing: a cancellation fee can only actually be charged if you take payment through ChairBack. If you're set to pay-in-person, the fee sits there as a number and nothing collects it.",
    keywords: [
      "cancellation policy", "my policy", "cancel policy", "refund policy", "cutoff",
      "cancellation fee", "late cancel", "what is my policy", "policy set",
      "free cancel", "cancellation window",
    ],
    primaryFor: ["policy", "cutoff"],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "holiday-pricing",
    q: "How do I set holiday pricing?",
    a: "That's day pricing, on the Services tab. Open a service, add a date override, and set what that day costs — you can pick a stretch of dates at once, so Christmas week is one entry rather than seven.\n\nThe higher price is shown honestly at booking, so nobody is surprised at the chair.\n\nIf what you actually want is to be CLOSED that day, block the time on your calendar instead.",
    keywords: [
      "holiday pricing", "holiday price", "christmas", "new year", "thanksgiving",
      "date pricing", "price for a day", "date override", "december 25",
      // NOT "charge more" / "surge": those belong to day pricing generally, and
      // claiming them here stole "can i charge more on saturday".
    ],
    // 🔴 "holiday" is DECLARED here on purpose. It was owned by the time-off and
    // pause-account entries (its vacation sense), so "holiday pricing" landed on
    // "can I pause my account". Both readings are real; this one is the one
    // people type, and the vacation answers are still one tap away.
    primaryFor: ["holiday"],
    category: "money",
    action: { label: "Open services", featureId: "day-pricing" },
  },
  /* ========================= Asked, but unanswered ========================
   * A second pass driven by measurement rather than imagination: 70 questions
   * phrased the way a barber texts them, run through findHelp(). 22 got a
   * shrug and about a dozen more got a CONFIDENT WRONG ANSWER, which this file
   * rates as the worse failure. The entries below close both, and a few of
   * them exist mainly to out-score a bad match ("delete a client" was landing
   * on delete-account, which is a very expensive place to send someone).
   * ====================================================================== */
  {
    id: "walk-in",
    q: "How do I add a walk-in?",
    a: "On the calendar, add a walk-in on the chair and time they sat down. No name, no phone number, no signup — it exists so the money and the chair time get recorded without making someone stand there while you type their details.\n\nIt counts in Insights and Chair time like any other cut. If they want the loyalty punch, add them as a client instead.",
    keywords: ["walk in", "walkin", "walk-in", "off the street", "no appointment", "someone walked in", "add walk"],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "record-payment",
    q: "How do I record what someone paid?",
    a: "Open the appointment on the calendar and check them out. You record what they actually handed over — cash, card, whatever — plus a tip if there was one, and that's what feeds Insights.\n\nIt's deliberately what you TOOK, not what the service is priced at, so a discount or a friend rate doesn't quietly inflate your numbers.",
    keywords: [
      "mark as paid", "record payment", "checkout", "check out", "cash", "took payment",
      "paid me", "how much they paid", "close out", "ring up", "settle up",
    ],
    category: "money",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "mark-no-show",
    q: "A client didn't show up — what do I do?",
    a: "Mark the appointment as a no-show. It frees the chair, records the miss on that client's history, earns them no punch, and counts as $0 rather than a sale you never made.\n\nIf no-shows are a pattern, taking card or a deposit at booking is the thing that actually changes it.",
    keywords: [
      "no show", "didnt show", "didn't show up", "never showed", "ghosted",
      "stood me up", "missed their appointment", "didnt turn up", "no showed",
    ],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "close-early",
    q: "How do I close early today?",
    a: "Block the rest of the day on your calendar. Blocked time beats everything else — it pulls those slots off your booking page immediately, so nobody can take a time you've already left for.\n\nUse it for a one-off. If you're changing the day you work every week, change your hours instead.",
    keywords: [
      "close early", "leave early", "shut early", "finish early", "going home",
      "rest of the day", "closing today", "cancel the rest",
    ],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "lead-time",
    q: "Can I stop people booking last minute?",
    a: "Yes — set how much notice you need, and anything inside that window stops being offered. A two-hour notice means the 10am slot disappears at 8am.\n\nIt's the setting worth getting right early: too long and you turn away the walk-past trade, too short and someone books while you're mid-fade.",
    keywords: [
      "last minute", "notice", "lead time", "too soon", "same day", "book right now",
      "minimum notice", "advance notice", "how much notice", "stop booking",
    ],
    category: "booking",
    action: { label: "Open booking settings", featureId: "booking-rules" },
  },
  {
    id: "see-the-day",
    q: "How do I see tomorrow's appointments?",
    a: "The calendar has a Day view beside the month — pick the date and you get that day as a single column, chair by chair, in order.\n\nThe dashboard home also opens on today's agenda, so the first thing you see each morning is who's coming in.",
    keywords: [
      "tomorrow", "todays appointments", "today's list", "day view", "whats my day",
      "schedule for", "who's coming in", "whos coming", "my day", "agenda", "next day",
    ],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "delete-client",
    q: "How do I delete a client?",
    a: "You can't remove a client outright, and that's deliberate — their visits, punches and payment history are your books, so deleting one would quietly rewrite your own numbers.\n\nWhat you can do: merge them if they're a duplicate of another client, and stop texting them (their profile has the opt-out). If you need a client's data erased for a privacy request, email support@getchairback.com and we'll handle it properly.\n\nThis is a different thing from closing your OWN account — that's in Account, and it removes everything.",
    keywords: [
      "delete a client", "remove a client", "delete client", "remove client",
      "get rid of a client", "duplicate client", "merge client", "wrong client",
      "clean up my list", "delete customer", "remove customer",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    id: "add-client-manually",
    q: "How do I add a client myself?",
    a: "Add them in your client book with a name and a mobile number — that's all it takes, and they're immediately eligible for punches, reminders and rebooking nudges.\n\nIf you're moving a whole book across, import the list in one go rather than typing them in one at a time.",
    keywords: [
      "add a client", "new client", "add customer", "enter a client", "put a client in",
      "add someone", "create client", "add them manually",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    id: "text-everyone",
    q: "How do I text all my clients at once?",
    a: "Write it as a promotion and send it out — that's the blast. It only goes to clients who haven't opted out, and it counts against your monthly text allowance.\n\nOne piece of advice worth more than the feature: a blast to everyone converts worse than a rebooking nudge to the twenty people who are actually overdue. Use it for genuine news, not for filling a Tuesday.",
    keywords: [
      "text everyone", "text all", "blast", "mass text", "bulk text", "send to everyone",
      "message all clients", "text my list", "announcement", "broadcast", "everyone at once",
    ],
    category: "texting",
    action: { label: "Open promotions", featureId: "promotions" },
  },
  {
    id: "who-is-overdue",
    q: "Can I see who hasn't been in for a while?",
    a: "Your client book shows each client's last visit and roughly how often they come, so the drift is visible at a glance.\n\nBut you shouldn't have to go looking: rebooking nudges watch every client's own rhythm and text the ones who are overdue, automatically. That's the feature built for this question.",
    keywords: [
      "havent been in", "hasnt been", "overdue", "lapsed", "stopped coming",
      "not been back", "long time", "who is due", "due back", "missing clients",
      "lost clients", "havent seen",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    id: "comp-a-cut",
    q: "How do I give someone a free cut?",
    a: "Two different situations, two different answers:\n\nThey earned it — redeem their reward when you check them out, and the punch card resets on its own.\n\nYou're just being generous — check them out for what you actually took, which may be nothing. Recording a $0 cut keeps your Insights honest and still counts as a visit for their loyalty.",
    keywords: [
      "free cut", "comp", "on the house", "free haircut", "no charge", "gift",
      "discount", "friend rate", "give away", "redeem reward",
    ],
    category: "clients",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "take-a-deposit",
    q: "How do I charge a deposit?",
    a: "Turn on deposit mode in Payments and set the amount. Clients pay that when they book and the rest in the chair, so a no-show has already left something behind.\n\nThe money goes into your own Stripe account, not ours. You can also take the full price up front instead, if that suits your shop better.",
    keywords: [
      "deposit", "deposits", "upfront", "up front", "partial payment", "hold a slot",
      "secure the booking", "booking fee", "pay to book",
      // The literal phrase help_find_feature's schema tells a model to send.
      // Kept deliberately narrow: broader deposit wording out-ranked day
      // pricing on "can i charge more on saturday".
      "take a deposit", "taking a deposit",
    ],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "refund-a-client",
    q: "How do I refund a client?",
    a: "If they paid by card through ChairBack, refund it from that appointment's payment — it goes back to the card they used.\n\nIf they paid you cash, or direct by Zelle, Venmo or Cash App, the money never touched us: hand it back and adjust what you recorded so your numbers match reality.",
    keywords: [
      "refund", "refund a client", "refunded", "pay them back", "reverse a charge",
      "return payment", "cancel a payment", "refund a customer", "money back",
    ],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "payout-timing",
    q: "Why hasn't my money landed yet?",
    a: "Card payments go to YOUR Stripe account, and Stripe pays out to your bank on its own schedule — usually a couple of business days, longer for the first payout while they verify a new account.\n\nSo if a payment shows here but not in your bank, the answer is in your Stripe dashboard: check the payout schedule and whether Stripe is still waiting on any verification details.",
    keywords: [
      "payout", "payout late", "not in my bank", "where is my money", "when do i get paid",
      "when do i get my money", "havent been paid", "money hasnt arrived", "stripe payout",
      "bank transfer", "delayed", "hasnt landed",
    ],
    category: "money",
    action: { label: "Open payments", featureId: "pay-ahead" },
  },
  {
    id: "chargeback",
    q: "What happens if a client disputes a payment?",
    a: "It's between you and Stripe — the payment was made into your own Stripe account, so the dispute, the evidence and the decision all live there. We don't hold your money and we don't take a cut of it.\n\nYour best evidence is the record you already have: the booking, the reminders that went out, and the check-in.",
    keywords: [
      "chargeback", "charge back", "dispute", "disputed", "claimed it back",
      "reversed", "fraud", "bank claim",
    ],
    category: "money",
  },
  {
    id: "setup-cost",
    q: "Is there a setup fee?",
    a: "No. No setup fee, no onboarding fee, no per-booking fee, and no cut of what you charge.\n\nThe monthly plan is the whole cost, and the trial runs before any of it.",
    keywords: [
      "setup fee", "set up fee", "onboarding fee", "hidden fees", "hidden cost",
      "extra charges", "any other fees", "installation", "upfront cost", "catch",
    ],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "price-per-barber",
    q: "Do you charge per barber?",
    a: "No — the plan is per shop, not per chair. Add your whole team without the bill moving.\n\nWhat scales with a bigger shop is texting: more clients means more reminders and nudges out of the same monthly allowance.",
    keywords: [
      // Every keyword here is scoped to "per <someone>". Deliberately NOT
      // "charge per", "cost per" or anything carrying a bare "charge"/"more":
      // those tokens belong to a barber pricing their OWN services (day
      // pricing), and lending them to a billing answer sent "can i charge more
      // on saturday" here instead.
      "per barber", "per chair", "per seat", "per person", "per user",
      "per stylist", "per employee", "per head",
    ],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "pause-account",
    q: "Can I pause my account for a month?",
    a: "There's no pause button — you cancel, and you come back when you're ready. Nothing is deleted in between: your clients, visit history, punches and settings are all waiting when you resubscribe.\n\nWhile it's cancelled your booking page stops taking new bookings, so if you're going away rather than closing, blocking the dates on your calendar is usually what you actually want.",
    keywords: [
      "pause", "freeze", "on hold", "suspend", "take a break", "closed for a month",
      "holiday", "vacation", "temporarily", "stop for a while", "seasonal",
    ],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "remove-team-member",
    q: "How do I remove someone from my team?",
    a: "Remove their access on the Team page. It takes away their sign-in and nothing else — their chair, their hours and every appointment they ever cut stay exactly where they are, so your history and your numbers don't move.\n\nOnly the owner can do this, and the owner's own seat can't be removed.",
    keywords: [
      "remove", "remove barber", "fire", "let go", "take away access", "revoke",
      "someone left", "quit", "no longer works", "remove access", "kick out",
      "delete barber", "remove employee",
    ],
    category: "account",
    action: { label: "Open team", featureId: "team" },
  },
  {
    id: "barber-cant-sign-in",
    q: "My barber can't sign in",
    a: "Two things to check, and it's nearly always the first:\n\n1. They have to sign in with the EXACT email address you invited. An invitation is tied to that address on purpose, so forwarding it to a different one grants nothing.\n2. The invitation may have expired — they last seven days — or been used already. Send a fresh one from the Team page and it takes seconds.\n\nIf they've never had a ChairBack account, they make one as part of accepting: in the app that's \"Join your shop\" on the sign-in screen, which opens a secure browser page and brings them back signed in.",
    keywords: [
      // Full phrases, not the bare pair "barber cant": "cant" is one edit from
      // "can", so "barber cant" fuzzy-matched any question shaped
      // "can i ... barber ...".
      "cant sign in", "cant log in", "barber cant sign in", "barber cant log in",
      "employee cant sign in", "invite not working",
      "invitation expired", "didnt get invite", "wrong email", "join your shop",
      "staff login", "team login", "they cant get in",
    ],
    category: "account",
    action: { label: "Open team", featureId: "team" },
  },
  {
    id: "i-cant-log-in",
    q: "I can't log in",
    a: "Use Forgot password on the sign-in page — it works even if you originally signed up with Google or Apple, because it doubles as a way to SET a password for an account that never had one.\n\nIf you made your account with Google or Apple, the buttons are the faster route. And if the app keeps signing you out, sign in once more on the sign-in screen: that stores a fresh session on the device.",
    keywords: [
      "cant log in", "cant login", "cant sign in", "locked out", "forgot password",
      "reset password", "wrong password", "logged out", "keeps logging me out",
      "signed out", "password not working", "cant get in",
    ],
    category: "account",
  },
  {
    id: "report-a-problem",
    q: "Something's broken — how do I report it?",
    a: "Email support@getchairback.com with what you were doing, what you expected, and what happened instead. A screenshot and the rough time it happened make it far quicker to track down.\n\nInclude your shop name. A real person reads every message.",
    keywords: [
      "bug", "broken", "report", "not working", "glitch", "error", "problem",
      "issue", "crash", "froze", "stuck", "wrong",
    ],
    category: "account",
    action: { label: "Open support", featureId: "support" },
  },
  {
    id: "page-not-loading",
    q: "My booking page won't load",
    a: "Check these in order:\n\n1. The address — your page lives at your ChairBack handle, and changing your handle changes the link, which breaks any old one you've shared.\n2. If you've pointed a custom domain at it, the DNS can take a few hours to settle after you set it up.\n3. If your trial has ended and there's no subscription, the page stops taking bookings on purpose.\n\nStill stuck, send us the link at support@getchairback.com and we'll look at it directly.",
    keywords: [
      "page wont load", "booking page down", "link doesnt work", "site is down",
      "404", "not found", "broken link", "page not working", "cant open my page",
    ],
    category: "brand",
    action: { label: "Open your page", featureId: "mini-site" },
  },
  {
    id: "data-protection",
    q: "How do you handle client data and privacy?",
    a: "Your client list is yours: we don't sell it, we don't market to it, and you can export it whenever you like.\n\nEach shop's data is isolated from every other shop's at the database level, not just in the app. Texts only go to clients who consented, and STOP opts someone out permanently and immediately.\n\nFor a specific erasure or access request from one of your clients, email support@getchairback.com and we'll handle it — that's a request we act on rather than a setting you toggle.",
    keywords: [
      "gdpr", "ccpa", "privacy", "data protection", "personal data", "compliance",
      "compliant", "right to be forgotten", "erasure", "data request", "secure",
      "where is my data", "who can see",
    ],
    category: "account",
    action: { label: "Read the privacy policy", featureId: "privacy" },
  },
  {
    id: "picture-message",
    q: "Can I text a photo to a client?",
    a: "Not today — outgoing messages are text only.\n\nIf you want to show work, put it in your gallery and share your page link: the photos live there, it costs nothing to send, and it doubles as the thing that books the next client.",
    keywords: [
      "photo", "picture", "image", "mms", "send a photo", "attach", "picture message",
      "send pictures", "media",
    ],
    category: "texting",
    action: { label: "Open your page", featureId: "mini-site" },
  },
  {
    id: "how-long-setup",
    q: "How long does it take to set up?",
    a: "About fifteen minutes to be taking bookings: your hours, your services and prices, and your booking link. Everything else — loyalty, promos, your page, your team — can wait until you feel like it.\n\nIf you're coming from Acuity or Square, connect it instead and your existing appointments and calendar come across on their own.",
    keywords: [
      "how long", "set up", "setup time", "get going", "quick", "take long",
      "how much work", "time to set up", "onboarding", "start using",
    ],
    category: "start",
    action: { label: "Get started", featureId: "signup" },
  },
  {
    id: "move-appointment",
    q: "Can I move an appointment to another barber?",
    a: "Open the appointment on the calendar — the chair and the time are both editable there, and the client gets the updated details.\n\nIf the new time doesn't appear as available, that chair's hours or an existing booking are in the way rather than anything being broken.",
    keywords: [
      // NOT "change barber": Damerau counts "charge" as one edit from "change",
      // so that keyword fuzzy-matched "do you charge per barber" and answered a
      // PRICING question with appointment mechanics - and did it worst inside
      // the app, where the real pricing answer is filtered out by 3.1.1.
      // "barber on a booking" carries the BOOKING token as well as the barber
      // one, which is what lets "can i change the barber on a booking" reach
      // 2-of-3 coverage without lending this entry a bare "change".
      "move appointment", "another barber", "different barber", "switch barber",
      "barber on a booking", "barber on an appointment",
      "swap", "reassign", "give it to", "move to", "transfer appointment",
      "someone else cut",
    ],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
];


/**
 * What the bot offers before the barber types anything. Ordered by what gets
 * asked most, and deliberately short — a wall of chips is a menu, not a
 * conversation.
 */
export const HELP_STARTERS: string[] = [
  "How much does it cost?",
  "How do I set my hours?",
  "Does it work with my Acuity account?",
  "How do punch cards work?",
  "How do I take payment?",
  "Do you take a cut of my bookings?",
];
