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
  /** Optional deep link rendered as a button under the answer. */
  action?: { label: string; href: string };
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
    keywords: ["set up", "setup", "start", "begin", "onboard", "new", "first steps", "getting started"],
    category: "start",
    action: { label: "Open booking setup", href: "/dashboard/booking" },
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
    keywords: ["link", "url", "share", "instagram bio", "my page", "booking link", "where do clients book"],
    category: "start",
    action: { label: "Open Shop page", href: "/dashboard/site" },
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
    action: { label: "Open client book", href: "/dashboard/clients" },
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
    keywords: ["online booking", "how does booking work", "book online", "appointments", "schedule"],
    category: "booking",
    action: { label: "Open booking", href: "/dashboard/booking" },
  },
  {
    id: "set-hours",
    q: "How do I set my hours?",
    a: "Your hours live on your services — each service carries the hours it's offered, so a service you only do on weekends simply isn't bookable midweek.\n\nIf you're the only barber in the shop, saving hours on a service widens your own weekly availability to match, so you set them once and you're done.",
    keywords: [
      "hours", "availability", "schedule", "open times", "when i work",
      "working hours", "shifts", "change hours", "edit hours", "update hours",
      "set availability", "days off", "opening times",
    ],
    category: "booking",
    action: { label: "Open services", href: "/dashboard/booking?tab=Services" },
  },
  {
    id: "add-services",
    q: "How do I add a service or change a price?",
    a: "Services carry the name, price, duration, and the hours you offer them — add or edit them under Services.\n\nYou can also charge differently by weekday or by time of day (a Saturday fade priced above a Tuesday one), and the client sees the honest price for the slot they're picking.",
    keywords: [
      "service", "price", "menu", "duration", "add service", "change price",
      "cost of cut", "how long", "haircut", "takes", "minutes", "length",
    ],
    category: "booking",
    action: { label: "Open services", href: "/dashboard/booking?tab=Services" },
  },
  {
    id: "add-staff",
    q: "How do I add another barber?",
    a: "Add them under Staff. Each barber gets their own services and their own hours, and clients pick who they want when they book.\n\nStaff is about who takes appointments. If you also want them to sign in and see the dashboard, that's Team logins — a separate thing.",
    keywords: ["staff", "barber", "add barber", "another barber", "provider", "chairs", "stylist", "employee"],
    category: "booking",
    action: { label: "Open staff", href: "/dashboard/booking?tab=Staff" },
  },
  {
    id: "time-off",
    q: "How do I block off time or take a day off?",
    a: "Block the time on your agenda and it stops being bookable — it shows as a blocked span on the day so you can see exactly what's held.\n\nIf your Acuity calendar has blocked time on it, that syncs across too, so you only have to block it in one place.",
    keywords: ["block", "time off", "vacation", "day off", "holiday", "lunch", "break", "unavailable", "close"],
    category: "booking",
    action: { label: "Open agenda", href: "/dashboard/booking" },
  },
  {
    id: "approval-mode",
    q: "Can I approve bookings before they're confirmed?",
    a: "Yes. Turn on request-before-booking and a new booking holds the slot as pending until you approve it — so nobody lands in your chair without you saying yes first.\n\nThe slot stays reserved while it's pending, so you're not racing anyone to it.",
    keywords: ["approve", "approval", "pending", "screen clients", "confirm first", "request before booking", "vet"],
    category: "booking",
    action: { label: "Open booking settings", href: "/dashboard/booking?tab=Settings" },
  },
  {
    id: "recurring",
    q: "Can I set up a standing appointment?",
    a: "Yes. Book a client's every-N-weeks slot once and the whole series goes on the calendar in one shot.\n\nYou can edit the series later, or change a single date in it without touching the rest.",
    keywords: ["recurring", "repeat", "every 2 weeks", "standing", "regular", "series", "weekly", "biweekly"],
    category: "booking",
    action: { label: "Open booking", href: "/dashboard/booking" },
  },
  {
    id: "waitlist",
    q: "What happens when I'm fully booked?",
    a: "Full days feed a waitlist instead of turning people away. When a slot frees up — a cancellation, a moved appointment — the queue gets pinged automatically.\n\nThat's usually where a cancelled Saturday gets refilled before you've even noticed it opened.",
    keywords: ["waitlist", "wait list", "fully booked", "full", "cancellation", "standby", "sold out", "no slots"],
    category: "booking",
    action: { label: "Open booking settings", href: "/dashboard/booking?tab=Settings" },
  },
  {
    id: "addons",
    q: "Can clients add extras to a booking?",
    a: "Yes. Set up add-ons — a hot towel, a beard trim, a wash — and clients tack them on while booking. The extra time and the extra money both land on the appointment.\n\nWhen the schedule has room for it, the add-on is offered; when it doesn't, it isn't.",
    keywords: ["add on", "addon", "extras", "upsell", "hot towel", "beard", "wash", "upgrade"],
    category: "booking",
    action: { label: "Open services", href: "/dashboard/booking?tab=Services" },
  },
  {
    id: "targeted-slots",
    q: "Can I publish a one-off slot at a special price?",
    a: "Yes — special-priced slots. Publish a specific time at its own price (a late-night cut, a model rate, a quiet-Tuesday special) and it shows up badged in the picker.\n\nYou can set them as a weekly schedule with start and end times, or as one-off dates, and edit either later.",
    keywords: ["special price", "targeted slot", "flash", "late night", "model rate", "discount slot", "one off", "deal slot"],
    category: "booking",
    action: { label: "Open services", href: "/dashboard/booking?tab=Services" },
  },
  {
    id: "reminders",
    q: "Do clients get reminders?",
    a: "Automatically. A confirmation when they book, then reminders 24 hours and 2 hours before the appointment. You don't do anything.\n\nThat pair is the single biggest thing you can do about no-shows.",
    keywords: ["reminder", "no show", "noshow", "confirmation", "notify", "forget", "24 hour", "text before"],
    category: "booking",
    action: { label: "Open booking settings", href: "/dashboard/booking?tab=Settings" },
  },
  {
    id: "check-in",
    q: "Can clients tell me they're on the way?",
    a: "Yes. They tap \"on my way\" once before the cut and you see their live status right on the agenda — so you know who's en route, who's arrived, and who's running late before they walk in.",
    keywords: ["check in", "on my way", "eta", "running late", "arrived", "en route", "status"],
    category: "booking",
    action: { label: "Open agenda", href: "/dashboard/booking" },
  },
  {
    id: "cancel-reschedule",
    q: "How does a client cancel or reschedule?",
    a: "Their confirmation carries a manage link — they cancel or move the appointment there themselves, and the freed slot goes straight back into the picker (and pings the waitlist).\n\nYou can also cancel or move anything yourself from the agenda.",
    keywords: ["cancel appointment", "reschedule", "move appointment", "change time", "client cancel"],
    category: "booking",
    action: { label: "Open agenda", href: "/dashboard/booking" },
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
    a: `The loyalty program — punch cards, rewards page, public mini-site, client book — is free forever, no card required.\n\nPremium (${proPrice}/month, ${proTexts} texts included) adds the texting that brings clients back: rebooking nudges, promo blasts, and auto-sync with Acuity or Square. Premium AI (${proAiPrice}/month, ${proAiTexts} texts included) adds an AI receptionist that answers client texts and books appointments 24/7.\n\nEvery new shop gets a ${BILLING.trialDays}-day full Premium trial, and one rebooked regular typically covers the month.`,
    keywords: ["cost", "price", "pricing", "how much", "plan", "subscription", "fee", "monthly", "expensive"],
    // A bare "price"/"cost" collides with add-services ("change a price").
    // A prospect asking the bot what it costs is by far the commoner intent.
    primaryFor: ["price", "cost", "pricing"],
    category: "money",
    hidesInApp: true,
    action: { label: "See plans", href: "/pricing" },
  },
  {
    id: "whats-free",
    q: "What do I get for free?",
    a: "Punch cards and rewards, your clients' rewards pages, your public booking mini-site, and your client book — free forever, no card required.\n\nThe paid plans add the outbound texting (rebooking nudges, promo blasts) and automatic syncing with Acuity or Square.",
    keywords: ["free", "free plan", "no card", "forever", "free forever", "without paying"],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "commission",
    q: "Do you take a cut of my bookings?",
    a: "Zero. 0% commission, no per-booking fee, no cut of tips. What you charge is what you get.\n\nWe make money on the flat monthly plan and nothing else — and your client list stays yours to export whenever you want.",
    keywords: ["commission", "cut", "percentage", "per booking fee", "take a cut", "fees", "0%", "royalty"],
    category: "money",
  },
  {
    id: "trial",
    q: "Is there a free trial?",
    a: `Yes — every new shop gets ${BILLING.trialDays} days of full Premium, and you don't need a card to start.\n\nWhen it ends, you drop to the free plan automatically. Nothing gets charged unless you choose a paid plan yourself.`,
    keywords: ["trial", "free trial", "try", "test", "30 days", "demo period", "trial end"],
    category: "money",
    hidesInApp: true,
  },
  {
    id: "get-paid",
    q: "How do I take payment?",
    a: "Two ways, and you can run both:\n\nCard and Apple Pay at booking — money goes straight into your own Stripe account, so payouts land in your bank on Stripe's normal schedule. Good for deposits and for cutting no-shows.\n\nOr show your Zelle, Venmo, or Cash App handle on the confirmation and get paid direct, with no processing fees at all.",
    keywords: ["payment", "get paid", "stripe", "apple pay", "card", "deposit", "prepay", "payout", "zelle", "venmo", "cash app", "money"],
    category: "money",
    action: { label: "Open payments", href: "/dashboard/payments" },
  },
  {
    id: "when-paid-out",
    q: "When does the money reach my bank?",
    a: "Card payments go into your own Stripe account, not ours — we never hold your money — so payouts follow Stripe's schedule for your account, typically a couple of business days.\n\nZelle, Venmo, and Cash App are direct between you and the client, so that's instant and fee-free.",
    keywords: ["payout", "when do i get paid", "bank", "deposit time", "settlement", "transfer", "hold my money"],
    category: "money",
    action: { label: "Open payments", href: "/dashboard/payments" },
  },
  {
    id: "cancel-subscription",
    q: "How do I cancel my subscription?",
    a: "From your billing settings on the web — you can cancel any time, in a couple of taps, and keep your plan until the period you've already paid for runs out.\n\nAfter that you drop to the free plan. Your shop, your clients, and their punch cards all stay exactly where they are.",
    keywords: ["cancel", "unsubscribe", "stop paying", "downgrade", "end subscription", "quit", "cancel plan"],
    category: "money",
    hidesInApp: true,
    action: { label: "Open billing", href: "/dashboard/billing" },
  },
  {
    id: "change-card",
    q: "How do I update my card?",
    a: "In your billing settings on the web — update the card, see your invoices, and change plan from the same place.",
    keywords: ["card", "update card", "payment method", "credit card", "expired", "invoice", "receipt", "billing"],
    category: "money",
    hidesInApp: true,
    action: { label: "Open billing", href: "/dashboard/billing" },
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
    action: { label: "Open rewards", href: "/dashboard/rewards" },
  },
  {
    id: "what-counts-punch",
    q: "What counts as a punch?",
    a: "Completed appointments — nothing else. Cancellations and no-shows never earn punches, so the cards stay honest.\n\nIf you ever need to correct one, you can adjust a client's balance from their profile in the client book.",
    keywords: ["counts", "what earns", "punch rules", "no show punch", "cancellation", "adjust balance", "fix punches"],
    category: "clients",
    action: { label: "Open client book", href: "/dashboard/clients" },
  },
  {
    id: "reward-threshold",
    q: "Can I change how many visits earn a reward?",
    a: `Yes — the threshold and what the reward actually is are both yours to set. New shops start at ${DEFAULTS.rewardThreshold} visits for a ${DEFAULTS.rewardLabel.toLowerCase()}, and you can change either any time.\n\nYou can also run more than one card type, including invite-only VIP cards for your best clients.`,
    keywords: ["threshold", "how many visits", "change reward", "10 visits", "reward menu", "free cut after"],
    category: "clients",
    action: { label: "Open rewards", href: "/dashboard/rewards" },
  },
  {
    id: "vip-cards",
    q: "What are VIP cards?",
    a: "Extra card types on top of your standard punch card — including invite-only VIP cards you hand to your best clients only.\n\nThere are also status tiers: clients climb Bronze → Silver → Gold on lifetime visits, automatically.",
    keywords: ["vip", "exclusive", "invite only", "tiers", "bronze", "silver", "gold", "status", "member"],
    category: "clients",
    action: { label: "Open rewards", href: "/dashboard/rewards" },
  },
  {
    id: "nudges",
    q: "How do rebooking nudges work?",
    a: "ChairBack watches how often each client normally comes in. When someone goes quiet past their own rhythm, they get an automatic \"time to rebook\" text or push — with a link straight to your booking page.\n\nIt's per-client, not a blanket blast, which is why it reads as your shop noticing rather than marketing.",
    keywords: ["nudge", "win back", "winback", "lapsed", "overdue", "come back", "retention", "drifting", "automatic text"],
    category: "clients",
    action: { label: "Open nudges", href: "/dashboard/nudges" },
  },
  {
    id: "promotions",
    q: "How do I run a promotion?",
    a: "Set up a promo and it shows on your public page — and you can text it out to the clients you choose.\n\nGood for filling a specific dead window: a slow Tuesday, a new barber's first month, a holiday push.",
    keywords: ["promo", "promotion", "deal", "special", "discount", "sale", "offer", "blast", "campaign"],
    category: "clients",
    action: { label: "Open promotions", href: "/dashboard/promotions" },
  },
  {
    id: "reviews",
    q: "How do reviews work?",
    a: "Clients leave reviews on your public page, and you approve what shows. Nothing goes live without you.",
    keywords: ["review", "rating", "stars", "testimonial", "feedback", "google review"],
    category: "clients",
    action: { label: "Open reviews", href: "/dashboard/reviews" },
  },
  {
    id: "referrals",
    q: "Do I get anything for referring another barber?",
    a: "Yes. Send your referral link — they get an extra month on top of their trial the moment they sign up, and you get a free month once their first invoice clears.\n\nNo cap on how many you refer.",
    keywords: ["referral", "refer", "refer a friend", "affiliate", "free month", "invite barber", "share link"],
    category: "clients",
    hidesInApp: true,
    action: { label: "Open referrals", href: "/dashboard/referrals" },
  },
  {
    id: "own-my-list",
    q: "Do I own my client list?",
    a: "Completely. It's your list, and you can export it whenever you want — no lock-in, no holding your contacts hostage if you leave.\n\nThat's deliberate: the whole point is that the relationship is yours, not ours.",
    keywords: ["own", "export", "my clients", "download list", "csv", "leave", "lock in", "take my data"],
    category: "clients",
    action: { label: "Open client book", href: "/dashboard/clients" },
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
    action: { label: "Open insights", href: "/dashboard/insights" },
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
    action: { label: "Open inbox", href: "/dashboard/inbox" },
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
    action: { label: "Open billing", href: "/dashboard/billing" },
  },

  /* ============================ Acuity & Square ========================== */
  {
    id: "acuity",
    q: "Does it work with my Acuity account?",
    a: "Yes. Connect Acuity once with one click. Past appointments backfill automatically, and new ones flow in as they happen.\n\nBlocked time on your Acuity calendar syncs too, so your ChairBack availability matches reality without you maintaining two calendars.",
    keywords: ["acuity", "acuity scheduling", "connect acuity", "squarespace scheduling", "sync"],
    category: "integrations",
    action: { label: "Connect a calendar", href: "/dashboard/booking?tab=Settings" },
  },
  {
    id: "square",
    q: "Does it work with Square?",
    a: "Yes — connect Square the same way, with one click, and your appointments sync across automatically.",
    keywords: ["square", "square appointments", "connect square", "pos", "point of sale"],
    category: "integrations",
    action: { label: "Connect a calendar", href: "/dashboard/booking?tab=Settings" },
  },
  {
    id: "what-syncs",
    q: "What actually syncs from my calendar?",
    a: "Appointments and blocked time, both directions of change: a booking that moves in Acuity moves here, and one that's deleted there disappears here.\n\nSynced appointments also block your ChairBack slots, so the two calendars can't double-book you. It re-syncs on its own every 30 minutes on top of the live updates.",
    keywords: ["sync", "syncing", "what syncs", "how often", "refresh", "update", "backfill", "two calendars"],
    category: "integrations",
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
    action: { label: "Open Shop page", href: "/dashboard/site" },
  },
  {
    id: "branding",
    q: "Can I change the colors and logo?",
    a: "Yes — themes, fonts, accent colour, and your logo, so your page and your clients' rewards hub look like your shop and not like a template.",
    keywords: ["theme", "colors", "colours", "logo", "font", "branding", "customize", "look", "design", "style"],
    category: "brand",
    action: { label: "Open Shop page", href: "/dashboard/site" },
  },
  {
    id: "gallery",
    q: "Can I show photos of my work?",
    a: "Yes — the photo gallery on your public page. It's the thing new clients actually scroll before they book, so it's worth keeping fresh.",
    keywords: ["photos", "gallery", "pictures", "portfolio", "images", "my work", "before after"],
    category: "brand",
    action: { label: "Open Shop page", href: "/dashboard/site" },
  },

  /* ======================= Account, team & data ========================== */
  {
    id: "change-login",
    q: "How do I change my password or email?",
    a: "Both live in your Account settings, along with your name and profile photo.",
    keywords: ["password", "change password", "email", "change email", "login", "forgot", "reset", "profile", "photo"],
    category: "account",
    action: { label: "Open account", href: "/dashboard/account" },
  },
  {
    id: "team-logins",
    q: "Can my barbers have their own logins?",
    a: "Yes. Invite them under Team logins and each one signs in to their own view — an employee sees their own chair and their own clients, not the whole shop's numbers.\n\nThat's separate from Staff, which is just who takes appointments.",
    keywords: ["team", "logins", "invite", "seats", "roles", "permissions", "employee login", "manager", "access"],
    category: "account",
    action: { label: "Open team", href: "/dashboard/team" },
  },
  {
    id: "delete-account",
    q: "How do I delete my account and data?",
    a: "From your Account settings — choose Delete account. It permanently removes your login, every shop you own, and all of its clients, visits, punches, and nudges, and cancels any active subscription.\n\nIt can't be undone. If you'd rather we handled it, email support@getchairback.com from the address on your account.",
    keywords: ["delete", "delete account", "remove data", "close account", "erase", "gdpr", "wipe", "shut down"],
    category: "account",
    action: { label: "Open account", href: "/dashboard/account" },
  },
  {
    id: "privacy",
    q: "Is my data safe? Who can see it?",
    a: "Your shop's data is yours and is isolated from every other shop on ChairBack — nobody else's dashboard can reach it.\n\nWe never sell client data, and we never text your clients on our own behalf. The Privacy Policy lists exactly what we store and how long we keep it.",
    keywords: ["privacy", "safe", "secure", "security", "who sees", "sell data", "gdpr", "encrypted", "confidential"],
    category: "account",
    action: { label: "Read the privacy policy", href: "/privacy" },
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
    action: { label: "Open Shop page", href: "/dashboard/site" },
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
    action: { label: "Open Shop page", href: "/dashboard/site" },
  },
  {
    id: "shop-name",
    q: "How do I change my shop name?",
    a: "In your Account settings — your shop's name and details live there, next to your own profile.\n\nThe look of your public page — logo, colours, photos — is separate, on the Shop page.",
    // "address" deliberately NOT a keyword here: the street address lives on
    // the Shop page (it feeds Google), and show-up-on-google owns that word.
    keywords: ["shop name", "rename", "business name", "change name", "shop details"],
    category: "account",
    action: { label: "Open account", href: "/dashboard/account" },
  },
  {
    id: "contact-human",
    q: "How do I talk to a real person?",
    a: "Email support@getchairback.com — one channel for everything, and a real person reads every message. We typically reply within 1–2 business days.\n\nInclude your shop name so we can find your account quickly.",
    keywords: ["support", "contact", "human", "help", "email", "talk to someone", "phone number", "reach you", "someone"],
    category: "account",
    action: { label: "Open support", href: "/support" },
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
    action: { label: "Open payments", href: "/dashboard/payments" },
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
    action: { label: "Open rewards", href: "/dashboard/rewards" },
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
    action: { label: "Open services", href: "/dashboard/booking?tab=Services" },
  },
  {
    id: "client-didnt-get-text",
    q: "A client didn't get their text",
    a: "Check these three, in order:\n\n1. They replied STOP at some point — that opts them out permanently until they opt back in. Their profile in the client book shows it.\n2. Their number is wrong or is a landline.\n3. You've hit your monthly text quota, which stops sending.\n\nThe Inbox holds every message we sent them, so you can see exactly what went out and when.",
    keywords: [
      "didnt get", "not received", "no text", "text didnt send", "missing text",
      "never got", "delivery", "not delivered", "failed", "wasnt sent",
    ],
    category: "texting",
    action: { label: "Open inbox", href: "/dashboard/inbox" },
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
