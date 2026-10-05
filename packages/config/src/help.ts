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
import { PARTNER_PROGRAM } from "./partnerProgram.js";

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

const dollars = (cents: number) => `$${cents / 100}`;
const partnerReward = dollars(PARTNER_PROGRAM.rewardCents);
const partnerCashouts = PARTNER_PROGRAM.cashoutAmountsCents.map(dollars).join(" or ");
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
    id: "find-my-shop",
    q: "A client says they can't find my shop when they search for it",
    a: "They need your exact handle — the last part of your booking link — not your shop's name typed into a search box. “drickcuttinup” finds that shop; “drick” finds nothing.\n\nIt's forgiving about the shape of it: capitals, a leading @, or the whole pasted link all work. So the fix is to send them your link, or tell them the handle exactly as it appears in it.\n\nThat's on purpose, not a gap. A search over shop names would turn every shop on ChairBack into a browsable directory that a rival could scroll — so a shop can only be found by someone who already knows its handle, which is exactly the position a client with your link is in.",
    keywords: [
      "cant find", "can't find", "find my shop", "search", "searching",
      "not coming up", "doesnt show up", "handle", "username", "lookup",
      "find me", "look me up",
    ],
    category: "start",
    action: { label: "Your booking link", featureId: "online-booking" },
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
    // 🔴 Three things this used to leave out, each of which a shop acted on:
    // backfilled visits from before rewards were switched on earn no punches
    // until credited (#528), an import never writes over a client on a shared
    // phone (#510/#517/#522), and an import never counts as a yes to texts or
    // marketing email.
    a: "Yes. If you connect Acuity or Square, your past appointments backfill automatically and those clients land in your client book with their history intact. Visits from before you switched rewards on don't earn punches by themselves — you can credit them under Rewards → Past visits.\n\nComing from a spreadsheet? Clients → Import CSV takes names, phones and emails. It never writes over a client you already have: a row that shares a phone or email with someone in your book is skipped and listed so you can decide, and so is a name-only row for someone you already have.\n\nImported clients aren't texted, or sent your marketing emails, until they say yes themselves — a contact list isn't proof anyone agreed. Your Acuity services come across separately, from Booking → Services.",
    keywords: [
      "import", "existing clients", "migrate", "bring over", "transfer", "upload", "csv", "backfill",
      "import csv", "spreadsheet", "import from acuity",
    ],
    // A bare "import" means the client list. The Acuity service import owns
    // its own multi-word phrases; without this its generated "Where do I find
    // Import services from Acuity?" pointer took the bare word on its question
    // text alone.
    primaryFor: ["import"],
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
    a: "Services carry the name, price, duration, and the hours you offer them — add or edit them under Services.\n\nYou can also charge differently by weekday or by time of day (a Saturday fade priced above a Tuesday one), and the client sees the honest price for the slot they're picking.\n\nAlready set up in Acuity? Bring them across instead of typing them again — see “Can I copy what I sell on Acuity into ChairBack?”.",
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
    a: "Full days feed a waitlist instead of turning people away. When a slot frees up — a cancellation, a moved appointment — the queue gets pinged automatically.\n\nThat's usually where a cancelled Saturday gets refilled before you've even noticed it opened.\n\nThe people waiting are under Booking → Waitlist. Each card has Book appointment, and a Text button that opens a message to them from your own phone.",
    keywords: ["waitlist", "wait list", "fully booked", "full", "cancellation", "standby", "sold out", "no slots", "use the waitlist"],
    category: "booking",
    action: { label: "Open booking settings", featureId: "waitlist" },
  },
  {
    id: "addons",
    q: "Can clients add extras to a booking?",
    a: "Yes. Set up add-ons under Booking → Services → Add-ons — a hot towel, a beard trim, a wash — and clients tack them on while booking. The extra time and the extra money both land on the appointment, and the calendar card shows them: “Haircut + Hot towel”.\n\nWhen the schedule has room for it, the add-on is offered; when it doesn't, it isn't.\n\nYou can add them yourself too, when you book someone in — see “Can I include extras when I book someone in myself?”.",
    keywords: ["add on", "addon", "extras", "upsell", "hot towel", "beard", "wash", "upgrade"],
    category: "booking",
    action: { label: "Open services", featureId: "addons" },
  },
  {
    id: "targeted-slots",
    q: "Can I publish a one-off slot at a special price?",
    a: "Yes — special-priced slots. Publish a specific time at its own price (a late-night cut, a model rate, a quiet-Tuesday special) and it shows up badged in the picker.\n\nYou can set them as a weekly schedule with start and end times, or as one-off dates, and edit either later.\n\nThey can sit outside your regular hours, but your booking rules still apply: clients can't book one inside your minimum notice, or further ahead than you take bookings. You can still book a client into any of them yourself from New appointment.",
    keywords: ["special price", "targeted slot", "flash", "late night", "model rate", "discount slot", "one off", "deal slot"],
    category: "booking",
    action: { label: "Open services", featureId: "targeted-slots" },
  },
  {
    id: "reminders",
    q: "Do clients get reminders?",
    a: "Automatically. A confirmation when they book — by email, and as a push if they use the app — then reminders 24 hours and 2 hours before the appointment. You don't do anything.\n\nThat pair is the single biggest thing you can do about no-shows.",
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
    // 🔴 This used to say a flat "No." That stopped being the whole truth when
    // walk-ins started being RECORDED over a booked chair on purpose (a receipt
    // for a cut that already happened is not a reservation request). A barber
    // reading the amber warning and asking this question was being told it
    // could not happen.
    // 🔴 And "the one deliberate exception" stopped being true with Book anyway
    // (#538): an owner or manager can now double-book on purpose. CUSTOMERS
    // still cannot, on any path - that half of the old answer stands.
    a: "Not by a customer. A slot is held the instant it's taken and stops being offered to anyone else — including bookings that arrive from Acuity or Square, and time you've blocked off. A customer trying to take a chair that's already booked for that time is refused, whether they use your booking page, their appointment link or the texting receptionist.\n\nThere are two deliberate exceptions, and both are yours to make:\n\n• Book anyway. When you book someone in, or move a booking, over a taken time, ChairBack names what's there and asks first. Say yes and both stay on the calendar, with yours marked Double-booked.\n• A walk-in. A walk-in is a receipt for a cut that already happened — the money's in the till and the person is in the chair — so ChairBack records it even if that chair was already booked for the time, and warns you straight away: an amber panel on the calendar, a push to whoever's chair it is, and a line under the Conflicts tab until someone deals with it.\n\nNothing gets cancelled for you either way. You ring whoever's booked and decide.",
    keywords: ["double book", "double booking", "double-booked", "double booked", "overlap", "conflict", "two clients", "same time", "collide"],
    category: "booking",
    action: { label: "Open Conflicts", featureId: "conflicts" },
  },
  {
    id: "slot-taken",
    q: "It says the slot is taken when I try to book someone in",
    // 🔴 "Booking is refused rather than squeezed in" stopped being the whole
    // truth with Book anyway (#538). The panel that says the time is taken now
    // offers it - except over a customer's live hold, which it never overrides.
    a: "Because that chair really is occupied for that time — by another booking, a synced appointment from Acuity or Square, or a hold someone still has on it. The form lists what's there.\n\nPick another time. If you mean to double-book, tap Book anyway, then Yes, book it: both stay on the calendar and yours is marked Double-booked. That isn't offered while a customer is paying for or confirming that exact time — wait until their hold runs out.\n\nIf you're recording a cut that already happened, use the walk-in instead. A walk-in is a receipt, not a reservation, so it goes on the books even when the chair was busy, with a warning if it overlaps something.",
    keywords: [
      "slot taken", "slot_taken", "time taken", "already taken", "cant book that time",
      "can't book that time", "wont let me book", "won't let me book", "refused",
      "taken when i book", "overlapping booking",
    ],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "walk-in-double-booked",
    q: "It says “Walk-in recorded - but this chair is double-booked”. What do I do?",
    a: "Two things happened, and neither is bad news about the money.\n\nThe walk-in went on the books — the amount you typed is recorded and nothing was thrown away. (That's a record of what you took at the chair; ChairBack didn't take the payment itself.)\n\nAnd the time you recorded overlaps something already on that chair — a booking, a synced appointment from Acuity or Square, or blocked time. Somebody may be about to turn up to a chair that's taken. Check the calendar and ring whoever is booked. ChairBack won't cancel or move anyone for you; that's your call.\n\nThe warning stays until you dismiss it, and the collision is listed under the Conflicts tab, so it's still there tomorrow if the panel was closed.",
    keywords: [
      "chair is double-booked", "chair is double booked", "walk-in recorded but", "walk in recorded but",
      "amber", "amber warning", "orange warning", "warning on walk-in", "walk-in warning",
      "overlaps", "already booked", "what do i do",
    ],
    category: "booking",
    action: { label: "Open Conflicts", featureId: "conflicts" },
  },
  {
    id: "conflicts-tab",
    q: "What's the Conflicts tab, and the number on it?",
    a: "It's the list of double-booked chairs — every time a walk-in was recorded over something that was already on that chair. The number is how many nobody has dealt with yet; it disappears at zero.\n\nEach one shows the chair, the overlapping time, what was already there (a ChairBack booking, a synced booking from Acuity or Square, or blocked time) and the walk-in that landed on top. Open both on the calendar, ring whoever's affected, then mark it resolved.\n\nIt's for owners and managers; barber seats don't see it. Whoever logs the walk-in gets the amber warning at the time, and the chair's barber — or the owner, if the chair isn't linked to a login — gets a push, plus a text if the shop has an alert number set.",
    keywords: [
      "conflicts", "conflicts tab", "conflict tab", "number on conflicts", "badge",
      "amber number", "orange number", "unresolved", "double booked list",
      "double-booked chairs", "list of conflicts",
    ],
    category: "booking",
    action: { label: "Open Conflicts", featureId: "conflicts" },
  },
  {
    id: "resolve-conflict",
    q: "What does “Mark resolved” do on a conflict?",
    a: "It notes that a person has dealt with it — that's all. Nothing about either booking changes: it doesn't cancel, move or refund anything, and it doesn't message the customer. If someone needs moving, do that on the calendar as you normally would.\n\nYou can add a line saying what you did (“rang him, moved to 3pm”) for whoever reads the list next. It's kept, with who resolved it and when — resolved conflicts move to the Resolved filter rather than disappearing.\n\nDone with them? A resolved one has a Delete button, and the Resolved and All filters have Delete all resolved. Deleting only takes it off this list: no booking changes and nobody is told. Open conflicts can't be deleted — resolve them first.\n\nIf you see “Already resolved by …”, a teammate got there first; the list shows their name, not yours.",
    keywords: [
      "mark resolved", "marking resolved", "mark it resolved", "resolve", "resolved", "resolving",
      "delete resolved", "delete resolved conflicts", "delete a conflict", "delete conflicts",
      "remove resolved conflicts", "clear resolved conflicts", "delete all resolved",
      "already resolved", "resolved by", "resolved by someone", "someone else resolved",
      "resolve conflict", "resolve a conflict", "resolving a conflict", "marking a conflict resolved",
      "does resolving cancel", "cancel the other appointment", "clear the conflict", "dismiss conflict",
      "what does that mean",
    ],
    // "resolved" is this entry's word. Without it declared, "already resolved
    // by someone else" scored "already" against slot-taken, and "cancel the
    // other appointment" pulled toward the cancellation entries - both were
    // near-misses in the eval, one suggestion away from a right answer.
    primaryFor: ["resolved", "resolve"],
    category: "booking",
    action: { label: "Open Conflicts", featureId: "conflicts" },
  },
  {
    id: "walk-in-saved-twice",
    q: "I tapped Save twice on a walk-in — is it in there twice?",
    a: "No. A double tap, a timeout or a flaky connection on ONE walk-in lands as one walk-in: the app tags each save, so a retry of the same one is recognised and folds into it.\n\nTwo real walk-ins seconds apart are two, though — separate cuts, separate money. ChairBack never merges two receipts just because they look alike.",
    keywords: [
      "twice", "double tap", "tapped save twice", "pressed save twice", "duplicate walk-in",
      "recorded twice", "two walk-ins", "timed out", "saved twice", "did it save", "in there twice",
    ],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
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
    a: `No — but every new shop gets the whole thing free for ${BILLING.trialDays} days. No card to start, nothing to cancel if you walk away.

When the trial ends your shop stops taking bookings until you pick a plan, starting at $${PLANS.starter.priceMonthlyUsd}/month for the booking site and the everyday tools. Your clients, history and loyalty data stay exactly where they are, and you can read or export your client book at any time.`,
    keywords: ["free", "free plan", "no card", "forever", "free forever", "without paying", "cheapest plan", "starter"],
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
      "trial", "free trial", "try", "test", "14 days", "30 days", "demo period", "trial end",
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
    id: "booking-questions",
    q: "Can I ask customers for more information when they book?",
    a: "Yes. Booking \u2192 Settings \u2192 \"What you ask when someone books\". Add any question you like \u2014 a service address, a vehicle, a gate code, a note about what they want \u2014 and choose whether it's optional or required.\n\nThere's a one-tap set of suggestions for your kind of business. A mobile mechanic gets the service address and the vehicle's year, make and model, all required, because you can't drive to a job or quote parts without them. A barbershop gets one optional \"anything I should know?\".\n\nThe answers show on the booking in your calendar, under \"What they told you\" \u2014 tap an address and it opens in maps.\n\nOne thing worth knowing: every REQUIRED question is one more thing standing between someone and a booking. Make required the things the job genuinely can't start without, and leave the rest optional.",
    keywords: [
      "intake",
      "intake form",
      "custom questions",
      "custom fields",
      "extra fields",
      "more information",
      "ask customer",
      "service address",
      "address at booking",
      "vehicle information",
      "year make model",
      "specific requests",
      "notes at booking",
      "required fields",
    ],
    category: "booking",
    action: { label: "Open booking settings", featureId: "booking-questions" },
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
    a: "Automatically. Once rewards are on, every completed visit punches the client's card — you don't hand out anything, and they don't carry anything.\n\nThey see their card on a private rewards page you text them, and when they hit the threshold the reward redeems right at the chair.\n\nRewards start the moment you switch them on, so earlier visits don't punch by themselves — Past visits on the Rewards page can add them.",
    keywords: ["punch card", "loyalty", "stamps", "punches", "rewards", "free cut", "card"],
    category: "clients",
    action: { label: "Open rewards", featureId: "punch-cards" },
  },
  {
    id: "what-counts-punch",
    q: "What counts as a punch?",
    a: "Completed appointments that finish while rewards are on — nothing else. Cancellations and no-shows never earn punches, so the cards stay honest. Visits from before you switched rewards on can be credited under Past visits on the Rewards page.\n\nIf you ever need to correct one, you can adjust a client's balance from their profile in the client book.",
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
    a: "Extra card types on top of your standard punch card — including invite-only VIP cards you hand to your best clients only.\n\nThere are also status tiers a client climbs automatically, and you decide what earns each one — see “How do loyalty tiers work?”.",
    keywords: ["vip", "exclusive", "invite only", "member"],
    category: "clients",
    action: { label: "Open rewards", featureId: "vip-cards" },
  },
  {
    id: "loyalty-tier-rules",
    q: "How do loyalty tiers work, and can I change what they take?",
    a: "Clients climb tiers automatically, and you set the bar for each one. A tier can require visits, money spent, or both together — and you choose whether that's counted over a month or across their whole history with you.\n\nSo “Gold = 3 cuts a month” and “Gold = $300 a month” and “Gold = 3 cuts AND $300 a month” are all expressible, per tier, in your rewards settings.\n\nMoney counts what a client has actually earned you. Nothing is retroactive in a way that demotes someone unfairly — a client sees their current tier and exactly what the next one takes.",
    keywords: [
      "tiers", "tier", "bronze", "silver", "gold", "status", "levels",
      "tier rules", "change tiers", "customize", "requirements", "how to reach",
      "spend", "visits per month",
    ],
    category: "clients",
    action: { label: "Open tiers", featureId: "loyalty-tiers" },
  },
  {
    id: "tier-progress",
    q: "What does a client see about their tier?",
    a: "On their own profile: the tier they're in, and a progress bar showing what's left to reach the next one — in your terms, so if Gold takes 3 cuts and $300 a month that's what it counts down.\n\nOn your side, a client's standing shows on their page in your client book, so you know who you're looking at before they sit down.",
    keywords: [
      "progress", "progress bar", "next tier", "how close", "client sees",
      "profile", "standing", "what tier am i",
    ],
    category: "clients",
    action: { label: "Open tiers", featureId: "loyalty-tiers" },
  },
  {
    id: "tier-openings",
    q: "Can I offer an open slot to my best clients first?",
    a: "Yes. When you have a gap, you can hold it for a tier instead of putting it straight back on the public page: pick the time, pick the tier, and everyone in it gets a notification with a link to claim it.\n\nFirst to book gets it. If nobody in that tier takes it by the time you set, it opens to everyone as normal, so a held slot never quietly rots.\n\nIt's the same idea as the waitlist, pointed at loyalty instead of at whoever asked first.",
    keywords: [
      "offer", "open slot", "opening", "push", "best clients", "first dibs",
      "early access", "hold a slot", "cancellation", "gap", "tier only",
      "notify tier",
    ],
    category: "clients",
    action: { label: "Open tiers", featureId: "loyalty-tiers" },
  },
  {
    id: "saved-shops",
    q: "Can clients save my shop so they can find it again?",
    a: "Yes. When someone finds your shop they can add it to their account, and it stays on their home screen — next appointment, your rewards, and a way straight back to booking, without hunting for the link again.\n\nOn your side you can see which clients have saved you, which is a cleaner signal than a follower count: it's the people who chose to keep you one tap away.",
    keywords: [
      "save", "saved", "add shop", "my shops", "favourite", "favorite",
      "find me again", "keep", "bookmark", "follow",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    id: "nudges",
    q: "How do rebooking nudges work?",
    // 🔴 "a link straight to your booking page" was not what every shop sends:
    // a ChairBack-booking shop with no outside link saved sends the client's
    // rewards link. The after-visit push (#521) had no entry at all.
    a: "ChairBack watches how often each client normally comes in. When someone goes quiet past their own rhythm, they get an automatic \"time to rebook\" text or push with a link back to your shop.\n\nIt's per-client, not a blanket blast, which is why it reads as your shop noticing rather than marketing.\n\nSeparately, about half an hour after a visit, a client with the ChairBack app gets a push asking if they want to lock in their next one. It skips anyone who's already booked again — in ChairBack, or in Acuity or Square if you sync one.",
    keywords: ["nudge", "win back", "winback", "lapsed", "overdue", "come back", "retention", "drifting", "automatic text"],
    category: "clients",
    action: { label: "Open nudges", featureId: "rebook-nudges" },
  },
  {
    id: "promotions",
    q: "How do I run a promotion?",
    a: "Set up a promo and it shows on your public page — and you can text it out to the clients you choose: everyone, just the ones who are overdue, or only a loyalty tier such as your Gold members.\n\nTexting uses your text allowance. To send the same promo as an app notification or an email instead — also to just one tier — tap Email or notify on it.\n\nGood for filling a specific dead window: a slow Tuesday, a new barber's first month, a holiday push.",
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
    // The PARTNER program (partnerProgram.ts): a person's code, paid in cash.
    // Multi-word keywords only, no primaryFor - "cash" or "code" alone must not
    // pull payout or booking questions here.
    id: "partner-program",
    q: "How do partner referral codes work?",
    a: `If someone gave you a referral code, type it when you set up your business. It's optional, and it's entered once, at signup.\n\nPartners earn ${partnerReward}, once, for each business that signs up with their code and pays for a plan. Cashout unlocks at ${PARTNER_PROGRAM.unlock.referrals} paying businesses within ${PARTNER_PROGRAM.unlock.windowDays} days of the first, in ${partnerCashouts} amounts, from the partner's earnings page.`,
    keywords: ["referral code", "partner code", "partner program", "partner earnings", "affiliate earnings", "cash out referral", "referral money"],
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
    // 🔴 "opt anyone out (or back in)" was wrong on both counts: the client
    // page's switch is TEXTS only, and a client who texted STOP can only be
    // opted back in by themselves. Email has its own rules (#525/#529).
    a: "They reply STOP to any message and they're opted out instantly — that's automatic and required by law.\n\nYou can also opt someone out of texts yourself, from their page in the client book. If they texted STOP, only they can opt back in — by texting START, or from their rewards page.\n\nEmail is separate: a text STOP doesn't stop your emails, and unsubscribing from your emails doesn't stop texts. See “A client unsubscribed from my emails — can I turn them back on?”.",
    keywords: ["stop", "opt out", "unsubscribe", "no texts", "quit texting", "remove from texts", "spam"],
    category: "texting",
  },
  {
    id: "consent",
    q: "Do I need permission to text clients?",
    a: "Yes, and ChairBack handles it. Clients consent when they book or sign up, STOP replies opt them out instantly, and send caps stop any runaway texting.\n\nA client you add or import yourself isn't texted until they agree — tick the box on Add client only if they told you yes. Every message is logged, so if it's ever questioned you have the record.\n\nMarketing email has its own yes — see “How does a client say yes to getting my emails?”.",
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
    a: "Yes. Connect Acuity once with one click. Past appointments backfill automatically, and new ones flow in as they happen.\n\nBlocked time on your Acuity calendar syncs too, so your ChairBack availability matches reality without you maintaining two calendars. Your Acuity services can come across as well, from Booking → Services → Import services from Acuity.\n\nIt can also run the other way: with holding switched on, a ChairBack booking blocks that time in Acuity, so the same hour can't be sold on both. See “Can I keep taking bookings in Acuity while I use ChairBack?”.\n\nIf Acuity ever stops accepting ChairBack's sign-in, you'll see Reconnect Acuity on your home screen and in Settings — one tap fixes it.",
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
    id: "acuity-both-at-once",
    q: "Can I keep taking bookings in Acuity while I use ChairBack?",
    a: "Yes — that's the normal way to move across, and you don't have to pick a day to switch.\n\nBookings made in Acuity flow into ChairBack and hold the chair here. Going the other way is a setting: with holding switched on, a booking taken in ChairBack blocks that time in Acuity, so neither page can sell an hour the other already sold. Until you turn that on, ChairBack bookings are invisible to Acuity and the same slot can go twice.\n\nIf your chair is sold through several Acuity calendars, one ChairBack booking blocks every one of them — which is why you may see more than one “Blocked Time” entry for a single appointment.",
    keywords: [
      "both", "at the same time", "same time", "transition", "switching",
      "move over", "keep using acuity", "two calendars", "side by side",
      "migrate", "still use acuity",
    ],
    category: "integrations",
    action: { label: "Open integrations", featureId: "integrations" },
  },
  {
    id: "acuity-blocked-times",
    q: "Why do several “Blocked Time” entries appear in Acuity for one booking?",
    a: "Because an Acuity block covers one calendar at a time, and your chair is sold on more than one calendar.\n\nWhen someone books you in ChairBack we block that time in Acuity, so the same hour can't be sold twice. Acuity's blocks belong to a single calendar and there is no way to make one cover several — so if you run Haircut, Retwists, After hours and the rest as separate calendars, one booking needs one block on each. Four calendars, four entries, same half hour. It is the blocking you were already doing by hand, done for you.\n\nAcuity also adds copies of its own when a calendar belongs to more than one service group. Those carry the same ChairBack note and are cleared along with the rest when the booking is cancelled or moved.\n\nDon't delete them. Deleting one puts that hour back on sale in Acuity while ChairBack still has the chair booked — the exact double booking this exists to stop. If you want fewer entries the fix is fewer calendars: merge the ones that are really the same chair in Acuity and the blocks drop to match.",
    keywords: [
      "blocked time", "block off", "blocks", "so many blocks", "many blocks",
      "stacked", "six blocks", "multiple blocks", "duplicate blocks", "extra blocks",
      "why blocks", "delete block", "remove block", "acuity blocks",
      "blocking my calendar", "pops up",
    ],
    category: "integrations",
    action: { label: "Open integrations", featureId: "integrations" },
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
    a: "It lives at the bottom of your page settings: open your dashboard, tap More, then Public shop page, and scroll down to \"Use your own domain.\"\n\nOne thing first: if that domain already has a website on it, connecting it here REPLACES that site. Visitors will see your ChairBack page instead. Your email on that domain isn't affected.\n\nFrom there:\n1. Type your domain (like drickcuttinup.com) and tap Connect.\n2. Three records appear. Add them wherever you bought the domain (GoDaddy, Namecheap, Squarespace, Google Domains…) in that site's DNS settings:\n   • an A record, name @ (some registrars want it blank), value 76.76.21.21\n   • a CNAME record, name www, value cname.vercel-dns.com\n   • a TXT record, also name @, with the exact value shown in your dashboard — that one proves the domain is yours, so it's different for every shop.\n   If there's already an A record or a \"parking\" record for @, delete it — two A records on @ and the wrong one wins. Leave any other TXT records on @ alone; those are usually your email.\n3. Come back and tap \"I've added them — check again.\" The card tells you which record it can see and what it currently points at, so you know exactly what's left. It usually says Connected within minutes; DNS can occasionally take up to 48 hours.\n\nOnce it's Connected, anyone who types your domain — with or without www — lands straight on your ChairBack page over https, automatically. Google search results show your page's getchairback.com address: your domain is the door, your ChairBack page is the shop.\n\nIf you ever disconnect it, remove those three records at your registrar too, so the domain stops pointing here.",
    keywords: [
      // "my website URL", not "address": the word "address" belongs to the
      // street-address answer (show-up-on-google) since #204 added real ones.
      "domain", "custom domain", "own url", "dns", "www", "my website url",
      "godaddy", "namecheap", "squarespace domain", "connect domain",
      "point domain", "bought a domain", "add domain", "where domain",
      "a record", "cname", "hook up domain", "link domain",
      "txt record", "verify domain", "domain not working", "replace my website",
    ],
    primaryFor: ["domain", "dns"],
    category: "brand",
    action: { label: "Open Shop page", featureId: "custom-domain" },
  },
  {
    id: "show-up-on-google",
    q: "How do I show up on Google?",
    a: "Three things, all on your page settings (dashboard → More → Public shop page):\n\n1. Fill in your address — street, city, state, ZIP. That's what tells Google you're a real local business, which is how you appear for searches like \"barber near me.\" It's the single biggest lever. Rather not put your street on the map — say you work from home? Turn on \"Keep my street address private\" under it: Google then gets only your city and state, and clients who book still get the full address.\n2. Keep your page live, with your services, photos, and reviews on it — that's the page Google reads and shows, at your getchairback.com/s/ link.\n3. Own a domain? Connect it in the same place, and people who type it land straight on your page.\n\nGoogle indexes on its own schedule, so a brand-new page can take days to appear — but the address is what does the heavy lifting.",
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
    // 🔴 "Turning it back on later keeps the visit history, so nobody loses
    // credit for cuts they already had" read as "the pause backfills itself".
    // Since #528 rewards START at the switch-on: punches already earned are
    // kept, but visits from before it earn only when the owner credits them.
    a: "Yes — loyalty is a switch in your Rewards settings, and everything else (booking, reminders, your public page) works exactly the same with it off.\n\nTurning it off keeps every punch clients have already earned. But visits don't earn while it's off, and switching it back on starts rewards from that moment — cuts from before then don't punch by themselves.\n\nTo give them credit, use Past visits on the Rewards page: pick 3, 6 or 12 months, tap Check to see what it would give, then Credit them.",
    keywords: ["turn off", "disable", "switch off", "dont want", "hide rewards", "no loyalty", "remove punch"],
    category: "clients",
    action: { label: "Open rewards", featureId: "punch-cards" },
  },
  {
    id: "slot-not-showing",
    q: "A time isn't showing up for clients — why?",
    a: "Almost always one of these, in the order worth checking:\n\n1. The service's own hours don't cover that time — hours live on the service, so a service can be narrower than your day. If a whole DAY is missing, see “I turned a day on and clients still can't book it”.\n2. Something already occupies it: a booking, blocked time, or an appointment synced in from Acuity or Square.\n3. The service is long enough that it won't fit before you close.\n4. You've hit a daily cap for that service or group.\n\nIf none of those explain it, email support@getchairback.com with the date and service and we'll look at the actual slot data.",
    keywords: [
      "not showing", "missing slot", "no times", "cant book", "no availability",
      "doesnt show", "wont show", "empty calendar", "no slots", "why cant",
      "disappeared", "not bookable",
    ],
    category: "booking",
    action: { label: "Open services", featureId: "services" },
  },
  {
    id: "confirmation-text",
    q: "My client didn't get a confirmation TEXT when they booked",
    a: "That one isn't a text. A booking confirmation goes out by email, and as a push notification if the client uses the app — the confirmation SMS is deliberately off, because a text per booking costs every shop money for something the email already does.\n\nThe texts clients do get are the reminders: 24 hours and 2 hours before the appointment.\n\nSo if they're waiting on a confirmation, check the email side — their address on the booking, and their spam folder. If a REMINDER didn't arrive, that's a different question with different causes.",
    keywords: [
      "confirmation text", "confirmation sms", "no text when they booked",
      "booking text", "text after booking",
      "no confirmation",
    ],
    // 🔴 NOT "didnt get a text". Scoring is per token, so that phrase handed
    // this entry "didnt"/"get"/"text" at keyword weight and it swallowed the
    // plain "my client didnt get her text" - a reminder or promo question that
    // belongs to client-didnt-get-text. The confirmation question still lands
    // here on "confirmation" and "booked", which the generic one never says.
    category: "texting",
  },
  {
    id: "standing-unavailable",
    q: "Why can't a client book a standing appointment?",
    a: "Standing appointments are offered only where the series can be booked cleanly, so they're switched off in two cases:\n\n1. Your shop takes money at booking — a deposit, payment ahead, or a card on file. Twelve fortnightly bookings is a real money question (twelve deposits, one, or none), and that's a decision for you rather than something to settle silently.\n2. You approve each booking. A series would be a dozen requests to approve, which isn't what approval mode was asking for.\n\nShops that get paid at the chair, with instant booking, see the option. It's the same rule on the booking page and on the save, so a client is never offered a series the booking then refuses.",
    keywords: [
      "standing", "recurring", "series", "every 2 weeks", "repeat booking",
      "not offered", "cant book recurring", "option missing", "no standing",
    ],
    category: "booking",
  },
  {
    id: "day-not-bookable",
    q: "I turned a day on in my hours and clients still can't book it",
    a: "Two things decide whether a day is bookable, and the hours screen is only the first one.\n\n1. YOUR HOURS say when you work — that's the day you just ticked.\n2. EACH SERVICE has its own available hours, and a service can be switched off for a whole weekday. That setting is applied after your hours, so if every service is off on Sundays, ticking Sunday changes nothing a client can see.\n\nFix it under Services → open a service → “Available hours for this service” → set that day to Open (or press “All days: open” so the service simply follows your hours). Do it for every service you want bookable that day — there's a “Copy hours from another service” dropdown so you only set it once. Your booking page updates the moment you save.\n\nThe hours screen now warns you on any day this applies to, so you'll see it there before your clients do.",
    keywords: [
      "turned on", "still cant book", "day not showing", "sunday", "monday",
      "availability not working", "changed my availability", "day is blocked",
      "blocked off", "whole day", "day missing", "not bookable", "didnt save",
      "link is blocked",
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
      // The plain report, in the words a shop actually uses. Without these the
      // confirmation-text entry's own question ("MY CLIENT didn't get...")
      // out-scored this one on "my"/"client" and took the generic complaint.
      "my client didnt get her text", "my client didnt get his text", "client says she didnt get",
      "client says he didnt get", "didnt get her text", "didnt get his text", "didnt get their text",
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
    // "offers a link to book another time" was true only when there was one
    // to offer (#523): the button follows the shop's booking mode.
    a: "Yes — whether you cancel it or they do. It tells them the appointment is no longer booked, with a Book another appointment button that goes wherever you take bookings: your ChairBack booking page, or the booking link you've saved if you book through Acuity, Square or your own site. If your booking page is off and no link is saved, it goes out without the button.\n\nIt's queued the instant the cancellation saves, so it survives a restart or a hiccup at our end and can't go out twice.\n\nTwo deliberate exceptions: marking someone a no-show sends nothing, and an appointment with no email address on it has nobody to write to.",
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
    // 🔴 "greys itself out if the booking is canceled" promised a look that is
    // Wallet's decision, not ours, and the pass now also ends when the visit
    // does (#531). ChairBack can never delete a pass from someone's phone.
    a: "Yes, in two pieces: a punch card that lives in Wallet and updates its balance on its own, and an appointment pass that keeps itself up to date — if the time moves, it moves, and once the visit is over it reads COMPLETED, MISSED (a no-show) or CANCELED.\n\nOn an iPhone, the Add to Apple Wallet button for the appointment is on their confirmation email, the booking confirmation screen, their appointment link and their rewards page — for booked appointments, not requests still waiting on you. The punch card's button is on their rewards page. If a button doesn't show inside the ChairBack app, open the page in Safari.\n\nChairBack can't delete a pass from anyone's phone. When the visit ends the pass is marked as over, and Wallet decides whether to grey it out, file it with expired passes or hide it. The customer can always delete it themselves.\n\nNo button at all on an iPhone, for a booked appointment? Email support@getchairback.com and we'll look into it.",
    keywords: [
      "wallet", "apple wallet", "pkpass", "add to wallet", "phone wallet", "passbook",
      "digital punch card", "card in wallet", "wallet pass",
      "appointment pass", "pass after the visit", "remove the pass", "delete the pass",
      "pass says completed", "pass says missed",
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
    a: "Dashboard → Your page, in the \"About\" card: street, city, state and ZIP.\n\nBe aware of what it's actually for. It's what puts you in Google's results as a local business, and it's what fills in the location when a client saves the appointment to their calendar. It is not printed as text on your public page — if you want clients to read your address there, put it in the free-text hours or description field as well.\n\nDon't want your street on Google? Turn on \"Keep my street address private\", right under the address. Your page and Google then get only your city and state, and so does anyone who texts your AI receptionist before booking. Clients who book still get the full address in their confirmation, reminders and calendar entry.",
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
    a: "Dashboard → Payments holds all of it: how customers pay, the free-cancel cutoff in hours, and the fee charged inside that cutoff.\n\nA cutoff of 0 means every cancellation is a full refund. A fee of 100% means no refund inside the cutoff.\n\nIf you take deposits, Deposit refunds lets you make them non-refundable: a client who cancels doesn't get the deposit back, whatever the cutoff, unless you choose to refund it from that appointment. Bookings keep the terms they were made on, and if you cancel, the deposit is always refunded in full.\n\nOne catch worth knowing: a cancellation fee can only actually be charged if you take payment through ChairBack. If you're set to pay-in-person, the fee sits there as a number and nothing collects it.\n\nYour own rules in your own words — lateness, what to bring — plus a checklist customers tick before booking are a separate card: Booking → Settings → Your policies.",
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
    a: "On the calendar, add a walk-in on the chair and time they sat down. No name, no phone number, no signup — it exists so the money and the chair time get recorded without making someone stand there while you type their details.\n\nIt counts in Insights and Chair time like any other cut. If they want the loyalty punch, add them as a client instead.\n\nIf that chair was already booked for the time you're recording, the walk-in still goes on the books — and an amber warning says so, right there, because someone may be about to turn up to a taken chair. See “It says the chair is double-booked” for what to do.",
    keywords: ["walk in", "walkin", "walk-in", "off the street", "no appointment", "someone walked in", "add walk"],
    category: "booking",
    action: { label: "Open calendar", featureId: "online-booking" },
  },
  {
    id: "record-payment",
    q: "How do I record what someone paid?",
    a: "Open the appointment on the calendar and tap Start checkout. The amount due is already filled in — change it if they paid something different (a tip or a discount goes there), pick how they paid, and tap Mark paid. You record what they actually handed over — cash, card, whatever — and that's what feeds Insights.\n\nIt's deliberately what you TOOK, not what the service is priced at, so a discount or a friend rate doesn't quietly inflate your numbers.",
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
    a: "You can't remove a client outright, and that's deliberate — their visits, punches and payment history are your books, so deleting one would quietly rewrite your own numbers.\n\nWhat you can do: merge them if they're a duplicate of another client, stop texting them (their profile has the opt-out), or block them from booking online — see “Can I block a client from booking?”. If you need a client's data erased for a privacy request, email support@getchairback.com and we'll handle it properly.\n\nThis is a different thing from closing your OWN account — that's in Account, and it removes everything.",
    keywords: [
      "delete a client", "remove a client", "delete client", "remove client",
      "get rid of a client", "duplicate client", "merge client", "wrong client",
      "clean up my list", "delete customer", "remove customer",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    // A shop, 2026-10-01: "Can you block a client from booking". Multi-word
    // keywords only - a bare "block" belongs to blocking off time.
    id: "block-client",
    q: "Can I block a client from booking?",
    a: "Yes. Open them in your client book and tap Block from booking, under Online booking. Owners and managers can do this; other team logins don't see it.\n\nAfter that they can't book, join your waitlist or move a booking online with that phone number or email — not on your booking page, not from their appointment link, not by text. They're asked to contact you instead, and aren't told why. They also stop getting your rebook reminders, deals and announcements.\n\nAnything they already have booked stays booked — cancel it yourself if you don't want to keep it. They can still cancel on their own, and you can always book them yourself. Unblock gives them online booking back.\n\nSomeone who comes back with a new number and a new email is a new client to block too. Pick Blocked from booking in your client book's filter to see everyone you've blocked.",
    keywords: [
      "block a client", "block client", "block someone", "block this client",
      "ban a client", "ban client", "banned", "unblock",
      "stop a client booking", "stop someone booking", "stop them booking",
      "dont want them to book", "dont let them book", "not allowed to book",
      "problem client", "difficult client",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    id: "add-client-manually",
    q: "How do I add a client myself?",
    // 🔴 This said a name and a number made a client "immediately eligible for
    // reminders and rebooking nudges" - not true without their yes to texts -
    // and said nothing about a number that is already on someone (#517).
    a: "Clients → Add client. A first name is all it needs; add a mobile number or an email if you have one. Tick “This client agreed to receive text reminders” only if they told you yes — without it they aren't texted, reminders or nudges, until they opt in themselves.\n\nIf that phone number — or, with no phone, that email — already belongs to a client, nothing is added or changed, and it tells you who has it. Same person? Open their page and update them there. Someone else on a shared family phone? Add them with their own phone or email, or with no contact details.\n\nMoving a whole book across? Use Import CSV rather than typing them in one at a time.",
    keywords: [
      "add a client", "new client", "add customer", "enter a client", "put a client in",
      "add someone", "create client", "add them manually",
      "client already exists", "already has this phone number", "already has this email",
      "add client says", "cant add client",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    id: "text-everyone",
    q: "How do I text all my clients at once?",
    a: "Write it as a promotion and send it out — that's the blast. It only goes to clients who haven't opted out, and it counts against your monthly text allowance.\n\nIt doesn't have to be a text: Message your clients on the Clients page sends the same news as an app notification or an email — to everyone, a loyalty tier, or the clients who had a certain service — and uses no texts at all.\n\nOne piece of advice worth more than the feature: a blast to everyone converts worse than a rebooking nudge to the twenty people who are actually overdue. Use it for genuine news, not for filling a Tuesday.",
    keywords: [
      "text everyone", "text all", "blast", "mass text", "bulk text", "send to everyone",
      "text my list", "everyone at once",
    ],
    category: "texting",
    action: { label: "Open promotions", featureId: "promotions" },
  },
  {
    // The free channel, and the one Drick went looking for on Promotions
    // ("send to only gold or whatever tier member"). Announcement / broadcast
    // questions used to land on text-everyone and send the barber to spend SMS
    // allowance on something an app notification does for nothing - and a text
    // never reaches the client's Announcements.
    // Multi-word keywords only: a bare "email" would swallow every email question.
    id: "message-all-clients",
    q: "How do I send an announcement to all my clients, or just my Gold members?",
    // Corrected against #532/#534: the app channel reaches people who INSTALLED
    // the app (the preview's own words), several tiers or services mean any of
    // them, and the count box lists every reason someone is left out.
    a: "Use Message your clients on the Clients page — tap Write a message. Send it as an app notification — free, and it reaches anyone who installed the ChairBack app — or as an email, which counts against your monthly email allowance and only goes to clients who have said yes to your marketing emails.\n\nUnder Who gets it, pick Everyone, the loyalty tiers you want (like just your Gold members — each chip shows how many), or By service: only clients who had the services you pick, at any time or in the last 90 days or 12 months. Pick a tier and a service together and a client has to match both.\n\nBefore you send, the count shows how many will get it — on both channels — and lists why the rest won't: no email address, unsubscribed, bounced, hasn't said yes to email yet, hasn't installed the app, or not in the group you picked.\n\nIt uses no texts. Owners and managers can send, on any active plan. Every message that reaches a client also stays in their Announcements, the bell in the ChairBack app, so it's still there after they swipe the notification away.\n\nRunning a promo? Tap Email or notify on it and the message starts already written. Want to text everyone instead? That's a promotion, and it uses your text allowance.",
    keywords: [
      "announcement", "announcements", "broadcast", "newsletter", "send news",
      "message all clients", "message my clients", "message everyone", "message my gold",
      "gold members", "silver members", "bronze members", "tier members", "only gold", "only my gold",
      "email all my clients", "email my clients", "email everyone", "email my gold",
      "notify my clients", "notify all my clients", "notification to all", "app notification",
      "app notification to everyone", "push notification",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
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
    a: "Turn on deposit mode in Payments and set the amount. Clients pay that when they book and the rest in the chair, so a no-show has already left something behind. Under Deposit refunds you choose what happens when a client cancels: your cancellation policy decides, or the deposit is non-refundable.\n\nThe money goes into your own Stripe account, not ours. You can also take the full price up front instead, if that suits your shop better.",
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
    a: "If they paid by card through ChairBack, open the appointment on your calendar. A deposit you kept when they cancelled or didn't show, and a card payment taken at checkout, are refunded from there, back to the card they used. Don't refund from your own Stripe account: that takes the money back from you, and the client gets nothing. For anything else paid online, contact ChairBack support.\n\nIf they paid you cash, or direct by Zelle, Venmo or Cash App, the money never touched us: hand it back and adjust what you recorded so your numbers match reality.",
    keywords: [
      "refund", "refund a client", "refunded", "pay them back", "reverse a charge",
      "return payment", "cancel a payment", "refund a customer", "money back",
    ],
    category: "money",
    action: { label: "Open calendar", featureId: "appointments" },
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

  /* ======================= Shipped late September =========================
   * Booking policies (#537), Book anyway (#538), add-ons in New appointment
   * (#539/#519), messaging by service (#532/#534), the marketing-email yes
   * (#515/#525/#527/#529), Acuity service import and reconnect (#524/#526),
   * past-visit credit (#528), the waitlist Text button (#518), client import
   * safety (#510/#517/#522) and the saved-card service charge (#533/#535).
   *
   * Every screen, card and button name below is the one the code renders.
   * 🔴 Multi-word keywords only, and no `primaryFor` on a generic word:
   * scoring is per TOKEN, so a bare "email", "card", "service" or "add" here
   * would swallow every other question that contains it.
   * ====================================================================== */
  {
    id: "booking-policies",
    q: "How do I add my booking policies, or a checklist customers have to tick?",
    a: "Booking → Settings → “Your policies”, near the bottom of that tab.\n\nPolicy is your rules in your own words — deposits, lateness, no-shows, what to bring — up to 2,000 characters. Checklist is up to 8 short lines, like “I'll arrive 5 minutes early”: type one, tap Add, and when you're done tap Save policies.\n\nCustomers see it under “Before you book” on the last step of your booking page, right above Confirm. Every checklist line is a box they have to tick — Confirm stays off until they do. If you change your policies while someone is mid-booking, their ticks clear and they're asked to read them again.\n\nThey agree once, not every visit: a client who already ticked your policies on their phone isn't shown the boxes again — just a line saying when they agreed. Change a word and everyone is asked again. Their name, number and email are filled in from last time too, with a “Not you?” for a shared phone.\n\nWhat they agreed to is kept on the appointment: open it and you'll see “Agreed to your policies when booking” — or “when they first booked”, for a returning client who wasn't asked again — with the lines they ticked and the policy they read.\n\nLeave both blank and nothing shows. Policy text with no checklist is shown, but nobody has to tick anything. Keep the list short — every line is one more step between someone and their booking. It doesn't apply to appointments you book in yourself.",
    keywords: [
      "add my policy", "add a policy", "booking policy", "booking policies", "shop policy",
      "shop rules", "house rules", "my rules", "policy checklist", "checklist", "tick boxes",
      "tick each line", "agree to my rules", "agree before booking", "agreed to your policies",
      "before you book", "lateness policy", "late policy", "what to bring",
    ],
    category: "booking",
    action: { label: "Open your policies", featureId: "booking-policies" },
  },
  {
    // The answer has to carry BOTH halves of the rule: an owner or manager may
    // double-book on purpose, a customer never can, and a customer's live hold
    // is the one thing Book anyway will not override.
    id: "book-anyway",
    q: "Can I book someone in over a time that's taken?",
    a: "Yes — that's Book anyway, for when you mean to double-book. In New appointment, or when you move a booking with Edit, pick the time and save. If something's already there, the form lists who and what, with Book anyway and Choose another time. Tap Book anyway, read the question (“This overlaps … Book it anyway?”) and tap Yes, book it. Need a time that isn't offered? Use Custom time.\n\nBoth appointments stay on the calendar, and the one you forced shows a Double-booked chip, so anyone can see it was on purpose. Nobody is cancelled or messaged, and it isn't listed under Conflicts — that tab is for walk-ins.\n\nIt won't book over a customer who is paying for or confirming that time right now — wait until their hold runs out. Two appointments can't start at the exact same minute on one chair (start one at :05), and a weekly repeat skips clashing dates instead of forcing them.\n\nIf ChairBack holds your bookings in Acuity and Acuity refuses to block the time, a forced new booking is undone and you're told why — otherwise that hour would still be for sale on Acuity.\n\nCustomers can never do this: your booking page, their appointment link and the texting receptionist always refuse a taken time. Owners and managers only.",
    keywords: [
      "book anyway", "force a booking", "force booking", "force it", "book over",
      "book over someone", "book on top", "double book on purpose", "double-book on purpose",
      "overbook", "squeeze in", "squeeze someone in", "double-booked chip",
      "yes book it", "choose another time", "custom time", "overlaps another booking",
    ],
    // "anyway" is this entry's word and nobody else's. Without it declared,
    // "book anyway" went to the generated "Where do I find Book anyway?"
    // pointer by a tenth of a point.
    primaryFor: ["anyway"],
    category: "booking",
    action: { label: "Open appointments", featureId: "book-anyway" },
  },
  {
    // A barber, 2026-09-29: a client wanted 10 PM, after his hours, and "I
    // can't book it after hours". The way existed (Custom time) but read as
    // small print, and it booked at the menu price instead of his late rate.
    id: "book-after-hours",
    // Not "How do I book…": the q text scores too, and that opening stole the
    // bare "How do I book?" from the booking how-to (support eval, book-howto).
    q: "Can I take a client after hours, at my after-hours price?",
    a: "On the calendar, tap the hour you want — say 10 PM. If it isn't one of your open times, New appointment offers it anyway: under Time you'll see “10:00 PM · The time you tapped” with Book this time. Tap it, pick the client and schedule.\n\nAny other time works the same way from Custom time (top right of the Time card): pick the date and time yourself.\n\nCustom time also has a Price box. Leave it blank for the service's regular price, or type your after-hours rate — $60, say — and that's what the booking is for. Add-ons still add on top. A typed price is for one visit, so it can't be used with Weekly.\n\nIf something's already at that time, you're shown who and asked before it's booked (see Book anyway). Want customers to book late times themselves? Publish them as special-priced slots on the Services tab.",
    keywords: [
      "book after hours", "book someone after hours", "after hours appointment",
      "can't book after hours", "can't book it after hours", "cant book after hours",
      "book outside my hours", "outside my hours", "book late", "late appointment",
      "after-hours price", "after hours price", "after hours rate", "late night rate",
      "charge a different price", "custom price", "type a price", "book this time",
      "the time you tapped", "book at 10 pm",
    ],
    category: "booking",
    action: { label: "Open appointments", featureId: "appointments" },
  },
  {
    // A barber, 2026-09-29: "when I tap a notification it should take me
    // directly to that day and time's appointment". The iPhone app ignored the
    // link until the update that shipped this - say so, don't promise it.
    id: "tap-appointment-alert",
    q: "What happens when I tap an appointment alert?",
    a: "Next up, new booking, moved and cancelled alerts each link to their appointment. Tapping one opens your calendar on that day with the appointment open, so the phone number, address and checkout are right there. Other alerts open your calendar.\n\nIn a web browser this works now. In the iPhone app it comes with the next app update; until you have it, tapping opens the app where you left it and the appointment is on your calendar.",
    keywords: [
      "tap a notification", "tap the notification", "tapping a notification", "tap an alert",
      "notification opens", "open the appointment from the notification", "next up notification",
      "notification take me to the appointment", "notification goes nowhere",
    ],
    category: "booking",
    action: { label: "Open appointments", featureId: "appointments" },
  },
  {
    // A barber, 2026-09-29: "if we could add notes to the confirmations. Like
    // I would tell people please arrive 10 minutes early."
    id: "client-note",
    q: "Can I add a note to my clients' confirmations?",
    a: "Yes. Booking → Settings → Note for clients. Write a line or two (up to 300 characters), like “Please arrive 10 minutes early. Parking is around the back”, and save.\n\nIt shows under “A note from” your shop name on the screen clients see right after booking, on their appointment page, and in the confirmation and reminder emails. It isn't added to text messages, which cost per character. Clear the box and save to remove it.\n\nThis isn't your policies: those are what clients tick before they can book. The note is just information for after.",
    keywords: [
      "note for clients", "note to clients", "note on confirmations", "note on the confirmation",
      "add a note to confirmations", "add notes to the confirmations", "confirmation note",
      "arrive 10 minutes early", "arrive early message", "message on the confirmation",
      "tell clients to arrive early", "parking instructions",
    ],
    category: "booking",
    action: { label: "Open booking settings", featureId: "booking-policies" },
  },
  {
    // A barber, 2026-09-29: "a service that is NOT visible to clients and only
    // me ... tap the eye icon to turn it off" (Acuity's "Private" types).
    id: "hidden-service",
    q: "Can I have a service clients can't see, that only I can book?",
    a: "Yes. Booking → Services, then tap the eye on that service. It shows “Hidden” and comes off your booking page, the texting receptionist and the walk-in kiosk, and clients can't book it even with a direct link. Tap the eye again to put it back.\n\nYou can still book it yourself from New appointment, like any other service. Anyone already booked into it keeps their appointment, and can still move or cancel it from their link.\n\nA special-priced slot listed only under hidden services isn't offered to clients either. List it under a visible service too if you want it on your page.\n\nComing from Acuity? Its “Private” types aren't imported automatically: add the service here, then tap its eye.",
    keywords: [
      "hidden service", "hide a service", "hide service", "private service", "private appointment type",
      "service clients can't see", "only I can book", "not visible to clients", "eye icon",
      "hide from booking page", "invisible service", "secret service",
    ],
    category: "booking",
    action: { label: "Open services", featureId: "services" },
  },
  {
    id: "special-chip-meaning",
    q: "Why does a booking say Special, Premium hour or After hours?",
    // 🔴 Two barbers asked this the same day (2026-09-29): "Special" reads as a
    // deal, but their slots all charged MORE than the service. The chip is
    // accurate - it only appears on a booking made into a published slot - so
    // this answer says what each word means rather than calling it a fault.
    a: "It means that booking was made into one of your special-priced slots — a time you published in advance with its own price. The word says what kind:\n\n• After hours — the slot starts outside your regular weekly hours.\n• Premium hour — the slot charges more than the service's normal price, like a late-night or weekend rate.\n• Special — any other slot, for example one priced below the service.\n\nIt's only a label by the client's name. The client, service and price are exactly what was booked.\n\nOne thing catches people out: the word follows your hours as they are set today. If you later stretch your hours across a slot's time, an “After hours” slot reads “Premium hour” or “Special” — nothing is wrong, it's judged against your current hours.\n\nTo stop new bookings landing in these slots, turn them off or delete them under Special-priced slots on the Services tab.",
    keywords: [
      "why does it say special", "what is the special", "special chip", "special tag",
      "premium hour", "after hours chip", "after hours tag", "what does special mean",
      "says special", "special on my booking", "special on random clients",
    ],
    category: "booking",
    action: { label: "Open special-priced slots", featureId: "targeted-slots" },
  },
  {
    id: "addons-when-you-book",
    q: "Can I include extras when I book someone in myself?",
    a: "Yes. In New appointment, pick the service and an Add-ons card appears with the extras that go with it, each with its price and time (“+$10 · +15 min”). Tick what they want and a Total shows the new length and price. The open times reload to fit the longer visit.\n\nOn the calendar the card then reads “Haircut + Hot towel”, and the length and price on it already include the extras. Add-ons customers pick on your booking page show the same way.\n\nThree things it won't do: a special has its own length and price, so add-ons don't apply to it; a weekly repeat can't carry add-ons (ticking one turns Weekly off); and you can't add or remove add-ons on a booking that's already made. Set up your add-ons under Booking → Services → Add-ons.",
    keywords: [
      "add-ons when i book", "add ons when i book", "add-on to an appointment",
      "add an add-on", "add extras when booking",       "add-ons on the calendar", "add ons on the calendar", "calendar card add-ons",
      "plus on the calendar card", "hot towel on a booking",
    ],
    category: "booking",
    action: { label: "Open appointments", featureId: "appointments" },
  },
  {
    id: "message-by-service",
    q: "How do I message only the clients who had a certain service?",
    a: "Clients → Message your clients → Write a message. Under Who gets it, tap By service, pick the services under Who had, and choose how far back: Any time, Last 90 days or Last 12 months (the default).\n\nA client counts if they finished one of those services in that time, or are booked in for one. No-shows, cancellations, requests still waiting on you, and visits nobody marked done don't count. Pick several services and any of them counts; pick a tier too and they have to match both.\n\nServices from Acuity show up too, marked “(from Acuity)”, and match on the exact name. Square visits carry no service name, so they can't be picked this way.\n\nBefore you send, the count shows how many will get it and why the rest won't.",
    keywords: [
      "by service", "message by service", "send by service", "clients who had",
      "people who had", "send to people who had", "had a certain service",
      "email clients who had", "notify clients who had", "who had a haircut",
      "service they had", "last 90 days", "last 12 months",
    ],
    category: "clients",
    action: { label: "Open Message your clients", featureId: "message-clients" },
  },
  {
    id: "email-marketing-yes",
    q: "How does a client say yes to getting my emails?",
    a: "Three ways, and your emails from Message your clients go only to people with one:\n\n1. They tick “Email me news and offers” on your booking page. It starts unticked.\n2. They tap “Email me news and offers” on their rewards page.\n3. You record it. Open the client, find the Marketing email card, tap Record their yes, and pick how they told you: In person, By text, By email or Paper form. Only record a yes they actually gave you. It needs an email address on file.\n\nThe card then shows when and how they said yes. A yes belongs to one address — if their email changes, it's cleared and they're back to “Not yet”. Adding or importing a client never counts as a yes.\n\nBooking emails, like confirmations, go out either way.",
    keywords: [
      "yes to marketing emails", "marketing email", "marketing emails", "record their yes",
      "record a yes", "email consent", "email opt in", "opt in to email", "agree to emails",
      "email me news and offers", "news and offers", "said yes to email",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    // The composer's own sentence when email reaches nobody, answered with the
    // reason and the two ways forward. Without this, "why can't email reach
    // anyone" landed on the spam-folder answer - a confident wrong one.
    id: "email-reaches-nobody",
    q: "Why can't my email reach anyone?",
    a: "Because nobody in that group has said yes to your marketing emails yet. Email from Message your clients only goes to people who agreed to it — having their address isn't enough, and adding or importing a client never counts as a yes.\n\nThe count box lists everyone left out and why: no email address, unsubscribed, bounced or marked as spam, hasn't agreed to your marketing emails yet, or not in the group you picked.\n\nWhat to do:\n• Send it as an app notification instead — free, and it reaches everyone who installed the app.\n• Collect yeses: clients tick the box on your booking page or tap the button on their rewards page, and you can record a yes they gave you on their page (Marketing email → Record their yes).\n\nIf it says the email can't be sent from your shop yet, add your shop's street address first — marketing email has to carry it by law.",
    keywords: [
      "email reach anyone", "email reaches nobody", "email cant reach", "email says 0 people",
      "email to nobody", "no one gets my email", "nobody said yes", "cant send email",
      "email wont send", "email skipped", "hasnt agreed to your marketing emails",
      "cant be sent from your shop",
    ],
    category: "clients",
    action: { label: "Open Message your clients", featureId: "message-clients" },
  },
  {
    id: "email-unsubscribed",
    q: "A client unsubscribed from my emails — can I turn them back on?",
    a: "No — only they can. Every marketing email carries an “Unsubscribe from these emails” link, and their rewards page has Stop these emails. Once they use either, their page shows Unsubscribed and your messages skip that address.\n\nTo come back, they open the Unsubscribe link at the bottom of one of your emails and press Resubscribe. You can't record a yes for them over an unsubscribe.\n\nUnsubscribing only stops your news and offers — their booking emails still arrive. And texts are separate: an email unsubscribe doesn't stop texts, and a text STOP doesn't stop email.",
    keywords: [
      "unsubscribed", "unsubscribed from my emails", "resubscribe", "subscribe again",
      "turn emails back on", "stop these emails", "opted out of email",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    id: "acuity-import-services",
    q: "Can I copy what I sell on Acuity into ChairBack?",
    a: "Yes — Booking → Services → “Import services from Acuity”, at the top of the tab while Acuity is connected. Tap Check my Acuity services and you see the whole list first — nothing is added until you say so.\n\nEach service shows New, or why it's left out: already in ChairBack (same name), turned off or private in Acuity, a class, or a length that can't be booked here. The button then counts the New ones (“Add 6 services”) and brings in all of them or none.\n\nWhat comes across: the name, length, price and description, and the Acuity category as a service group. Services you already have are never changed, and running it again adds nothing twice. New services are offered by everyone on your team and use your regular hours, so set per-service hours or day pricing afterwards if you use them. Add-ons don't come across — add those under Add-ons.\n\nIf it says it couldn't reach Acuity, try again; if it keeps happening, reconnect Acuity in Settings.",
    keywords: [
      "import services", "import my services", "import acuity services", "import my acuity services",
      "import services from acuity", "copy services from acuity", "services from acuity", "acuity services",
      "check my acuity services", "bring my services over",
    ],
    category: "integrations",
    action: { label: "Open services", featureId: "acuity-service-import" },
  },
  {
    id: "acuity-reconnect",
    q: "Acuity says Reconnect — what do I do?",
    a: "Tap Reconnect Acuity and sign in to Acuity again. It means Acuity stopped accepting ChairBack's sign-in, so nothing is syncing: new Acuity bookings, moves and cancellations aren't reaching ChairBack.\n\nYou'll see it on your home screen, on the Acuity tile under Booking → Settings (it says Not syncing), and in your setup list on the Assistant tab.\n\nReconnecting keeps your appointments, clients and settings. It switches live updates back on and imports your history again.\n\nUntil you do, past Acuity visits aren't marked done and don't earn punches, reminder texts for Acuity appointments are held back, and if ChairBack holds your bookings in Acuity, those holds are refused. Owners and managers can reconnect.",
    keywords: [
      "reconnect acuity", "acuity says reconnect", "reconnect", "not syncing",
      "acuity not syncing", "acuity disconnected", "acuity stopped syncing", "acuity sign in",
      "acuity login", "acuity stopped working", "sync stopped",
    ],
    category: "integrations",
    action: { label: "Reconnect Acuity", featureId: "acuity-reconnect" },
  },
  {
    id: "rewards-past-visits",
    q: "How do I credit past visits from before I turned rewards on?",
    a: "Rewards → Past visits, just under the rewards switch (it shows while rewards are on). Rewards start the moment you switch them on, so visits that ended before then don't earn punches by themselves.\n\nPick how far back — 3 months, 6 months or 12 months — and tap Check. It shows what that would give, like “Credit 40 past visits: 40 punches to 25 customers”, and the dates it covers. Tap Credit them, or Cancel.\n\nOnly finished visits count, never cancellations or no-shows, and a visit is never credited twice, so pressing it again is safe. Customers aren't sent anything. To take back one punch, use Undo in that client's punch history.\n\nTiers aren't affected — they already count every finished visit, credited or not.",
    keywords: [
      "past visits", "credit past visits", "credit old visits", "old visits", "credit them",
      "visits before rewards", "before i turned rewards on", "punches for old visits",
      "rewards start date", "when rewards started", "old visits didnt count", "earlier visits",
      "old cuts didnt count", "backdate visits",
    ],
    category: "clients",
    action: { label: "Open past visits", featureId: "past-visits" },
  },
  {
    id: "waitlist-text",
    q: "How do I text someone who's waiting for a spot?",
    a: "Booking → Waitlist, then tap Text on their card. It opens a new message to them in your own phone's Messages — you write it, it comes from your number, and ChairBack sends nothing, so it costs none of your texts.\n\nTexting doesn't change their status: tap Contacted once you have, or Book appointment to put them straight on the calendar.\n\nNo Text button? There's no usable phone number on that card. If they gave an email, it shows as a link instead.",
    keywords: [
      "text someone on the waitlist", "text the waitlist", "waitlist text", "text button",
      "message the waitlist", "contact the waitlist", "text them from the waitlist",
      "reach out to the waitlist", "call the waitlist",
    ],
    category: "booking",
    action: { label: "Open waitlist", featureId: "waitlist" },
  },
  {
    id: "import-skipped-rows",
    q: "Why did some of my clients get skipped?",
    a: "A client import never writes over a client you already have, so a row it can't be sure about is skipped and listed:\n\n• It shares a phone or email with a client you have. Families often share a phone, and it can't tell if it's the same person, so your client isn't changed — even where the file only had details they were missing. Same person? Open them and update them there. Someone else? Add them with Add client using their own phone or email.\n• It has only a name, and you already have someone by that name, so it doesn't add a second one.\n• The phone number couldn't be read — fix that row and import the file again.\n\nImporting the same file again is safe; nobody is added a second time. And an import never counts as anyone agreeing to texts or marketing email — they opt in themselves.",
    keywords: [
      "import skipped", "skipped rows", "skipped clients", "csv skipped", "why skipped",
      "shares a phone", "share a phone", "shared phone", "family phone", "same phone as",
      "import didnt add", "import opt in", "importing clients opt them in",
    ],
    category: "clients",
    action: { label: "Open clients", featureId: "clients" },
  },
  {
    // 🔴 Only some shops' checkout can charge a saved card, so every answer
    // here is conditional on the option being THERE. No general payments
    // answer promises it.
    id: "saved-card-charge",
    q: "How do I charge a customer's card after the appointment?",
    a: "Where your checkout offers it: open the appointment, tap Start checkout, and pick “Charge card ending ••••”. It's only there when the customer ticked “Let this shop charge my saved card for the service when my appointment is done” when they booked.\n\nThe rules they agreed to:\n• Only after the appointment — once you've marked it done or its end time has passed.\n• Capped at what they booked: the agreed amount, less anything already paid. If the balance is higher, the card can't be used — take it another way.\n• Within 72 hours of the end.\n\nThey get an email receipt each time (when there's an email on the booking), with a link to stop further charges. Charging doesn't mark the appointment done, so tap Done when you're finished.\n\nNo card option in your checkout? Then it isn't available for your shop — record what they paid with Mark paid as usual.",
    keywords: [
      "charge the saved card", "charge their saved card", "charge saved card",
      "charge the card after", "charge card ending", "saved card", "charge a customer's card",
    ],
    category: "money",
    action: { label: "Open calendar", featureId: "appointments" },
  },
  {
    id: "saved-card-refused",
    q: "Why won't it let me charge the customer's card?",
    a: "Your checkout says why, where the card would be:\n\n• “The saved card can be charged once the appointment is done” — mark it done, or wait for its end time.\n• “The saved card was approved only up to $…” — the balance is above what they agreed to when they booked. Take the balance another way.\n• “The customer stopped charges to this card” — they switched it off from their appointment link, and nobody can switch it back on. Take payment another way.\n• “This card was only approved for no-show fees” — they saved it for fees, not for the service.\n• “Too long since this appointment to charge the saved card” — it's been over 72 hours.\n\nIn every case, cash and your other ways to take payment still work.",
    keywords: [
      "cant charge the card", "card was refused", "approved only up to",
      "customer stopped charges", "stopped charges to this card",
      "saved card not working", "saved card refused",
    ],
    category: "money",
    action: { label: "Open calendar", featureId: "appointments" },
  },
  {
    id: "customer-stop-card-charges",
    q: "How does a customer stop the shop charging their card?",
    a: "From their appointment link — the one in their confirmation and in every card receipt. It says they let the shop charge their card for the service, with a button: Stop letting the shop charge this card. They confirm with Yes, stop charges to this card.\n\nAfter that nobody can switch it back on, you included, and your checkout shows “The customer stopped charges to this card”, so take payment another way. For a standing appointment it stops the whole series.\n\nIt doesn't delete the card: it stays on file for a no-show or late-cancel fee, if you charge those. A charge that's already going through isn't stopped.",
    keywords: [
      "stop card charges", "stop charging my card", "stop charges", "wants to stop card charges",
      "stop letting the shop charge", "customer wants to stop", "remove permission to charge",
      "dont charge my card",
    ],
    category: "money",
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
