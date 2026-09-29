import { describe, expect, it } from "vitest";
import { featureById, isBillingHref, resolveFeature } from "./features.js";
import { HELP_ANSWERS, HELP_CATEGORIES, HELP_STARTERS } from "./help.js";
import { HELP_CORPUS, findHelp, helpAnswerById } from "./helpMatch.js";

/** Assert the top answer for `query` is `id`, with a readable failure. */
function expectAnswer(query: string, id: string) {
  const res = findHelp(query);
  expect(
    res.answer?.id,
    `"${query}" → ${res.answer?.id ?? `(no confident answer; closest: ${res.suggestions
      .map((s) => s.id)
      .join(", ")})`}, expected ${id}`,
  ).toBe(id);
}

describe("help knowledge base", () => {
  it("has unique ids and non-empty copy everywhere", () => {
    const ids = HELP_CORPUS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of HELP_CORPUS) {
      expect(e.q.trim().length, `${e.id} question`).toBeGreaterThan(0);
      expect(e.a.trim().length, `${e.id} answer`).toBeGreaterThan(0);
      expect(e.keywords.length, `${e.id} keywords`).toBeGreaterThan(0);
      for (const k of e.keywords) expect(k.trim().length, `${e.id} keyword`).toBeGreaterThan(0);
    }
  });

  it("every entry sits in a real category", () => {
    const catIds = new Set(HELP_CATEGORIES.map((c) => c.id));
    for (const e of HELP_CORPUS) {
      expect(catIds.has(e.category), `${e.id} -> ${e.category}`).toBe(true);
    }
  });

  // 🔴 The whole point of the corpus naming FEATURES instead of routes: an
  // unknown id renders no button at all, silently. Nothing else would catch a
  // typo'd or deleted id, because `resolveFeature` is deliberately quiet.
  it("every action names a feature that actually resolves", () => {
    for (const e of HELP_CORPUS) {
      if (!e.action) continue;
      const r = resolveFeature(e.action.featureId);
      expect(r.ok, `${e.id} -> unknown feature "${e.action.featureId}"`).toBe(true);
      expect(r.ok && r.href.startsWith("/"), `${e.id} -> ${e.action.featureId}`).toBe(true);
      expect(e.action.label.trim().length, `${e.id} action label`).toBeGreaterThan(0);
    }
  });

  // App Store 3.1.1: an answer that links the subscription page is a purchase
  // back door, exactly like the FeatureSearch entries we already filter.
  it("anything steering to billing is marked hidesInApp", () => {
    for (const e of HELP_CORPUS) {
      if (!e.action) continue;
      const href = featureById(e.action.featureId)?.href ?? "";
      if (isBillingHref(href) || href === "/pricing") {
        expect(e.hidesInApp, `${e.id} links billing but is not hidesInApp`).toBe(true);
      }
    }
  });

  // Belt and braces on top of hidesInApp: even if an answer slipped through the
  // corpus filter, the REGISTRY refuses a billing destination inside the shell,
  // so the button cannot render. Two independent gates, because 3.1.1 is the
  // one rule that costs a release when it is wrong.
  it("the registry itself withholds billing destinations in-app", () => {
    for (const e of HELP_CORPUS) {
      if (!e.action) continue;
      const href = featureById(e.action.featureId)?.href ?? "";
      if (!isBillingHref(href)) continue;
      const r = resolveFeature(e.action.featureId, { inApp: true });
      expect(r.ok, `${e.id} resolved a billing href inside the app`).toBe(false);
    }
  });

  it("keeps a route to a human", () => {
    expect(helpAnswerById("contact-human")).toBeDefined();
    expect(helpAnswerById("contact-human")?.a).toContain("support@getchairback.com");
  });

  it("folds in the whole feature directory", () => {
    // Every feature is askable even though help.ts doesn't restate them.
    expect(HELP_CORPUS.length).toBeGreaterThan(HELP_ANSWERS.length);
    expect(helpAnswerById("feature-waitlist")).toBeDefined();
    expect(helpAnswerById("feature-inbox")?.action?.featureId).toBe("inbox");
  });
});

describe("findHelp — the no-dead-end contract", () => {
  it("always returns at least one suggestion, whatever the input", () => {
    const inputs = [
      "",
      "   ",
      "asdfghjkl",
      "?????",
      "1234567890",
      "the and or of",
      "can you help me with the thing",
      "🙂",
      "a".repeat(300),
    ];
    for (const q of inputs) {
      const res = findHelp(q);
      expect(res.suggestions.length, `"${q}" returned no suggestions`).toBeGreaterThan(0);
    }
  });

  it("never claims an answer it doesn't have", () => {
    const res = findHelp("asdfghjkl");
    expect(res.kind).toBe("suggestions");
    expect(res.answer).toBeNull();
  });

  it("is fast enough to feel instant", () => {
    const start = performance.now();
    for (let i = 0; i < 200; i++) findHelp("how much does it cost to use this thing");
    const perCall = (performance.now() - start) / 200;
    expect(perCall).toBeLessThan(10);
  });
});

describe("findHelp — real phrasings", () => {
  it("answers every one of its own canonical questions", () => {
    for (const e of HELP_CORPUS) {
      const res = findHelp(e.q);
      expect(res.answer?.id, `"${e.q}" did not return itself`).toBe(e.id);
    }
  });

  it("answers every starter chip confidently", () => {
    for (const q of HELP_STARTERS) {
      const res = findHelp(q);
      expect(res.kind, `starter "${q}" is not confidently answered`).toBe("answer");
    }
  });

  it("handles how a barber actually types", () => {
    expectAnswer("how much does it cost", "pricing");
    expectAnswer("whats the price", "pricing");
    expectAnswer("do you take a cut of my bookings", "commission");
    expectAnswer("do u take a percentage", "commission");
    expectAnswer("how do i set my hours", "set-hours");
    expectAnswer("change my availability", "set-hours");
    expectAnswer("do my clients need an app", "clients-need-app");
    expectAnswer("how do punch cards work", "punch-cards");
    expectAnswer("what counts as a punch", "what-counts-punch");
    expectAnswer("how many texts do i get", "how-many-texts");
    expectAnswer("how do i take payment", "get-paid");
    expectAnswer("when does the money hit my bank", "when-paid-out");
    expectAnswer("can i block off a day", "time-off");
    expectAnswer("i want to add another barber", "add-staff");
    expectAnswer("is there a free trial", "trial");
    expectAnswer("delete my account", "delete-account");
    expectAnswer("talk to a real person", "contact-human");
  });

  it("survives typos", () => {
    expectAnswer("does it work with aquity", "acuity");
    expectAnswer("cancle my subscription", "cancel-subscription");
    expectAnswer("how do i chagne my passwrd", "change-login");
    expectAnswer("puch cards", "punch-cards");
  });

  it("routes feature lookups to the feature", () => {
    // "where is X" questions land on the directory entry, which carries the link.
    for (const q of ["where is the waitlist", "where do i find the inbox"]) {
      const res = findHelp(q);
      expect(res.answer, `"${q}" was not answered`).not.toBeNull();
      expect(res.answer?.action?.featureId, `"${q}"`).toBeTruthy();
    }
  });
});

// These are questions nobody wrote an entry "for" — they were thrown at the
// matcher cold to see what a stranger actually gets. Locked in as regressions,
// because this is the behaviour that makes or breaks the bot in the wild.
describe("findHelp — questions asked cold", () => {
  it("answers the ones we cover", () => {
    expectAnswer("whats a no show fee", "no-show-fee");
    expectAnswer("my client says she didnt get her text", "client-didnt-get-text");
    expectAnswer("how do i see how much i made last month", "insights");
    expectAnswer("is there a contract", "contract");
    expectAnswer("can i use my own domain", "custom-domain");
    expectAnswer("how do i connect my domain", "custom-domain");
    expectAnswer("where do i add my domain", "custom-domain");
    expectAnswer("i bought a domain on godaddy", "custom-domain");
    expectAnswer("how do i show up on google", "show-up-on-google");
    expectAnswer("how do i add my address", "show-up-on-google");
    expectAnswer("how do people find me on google", "show-up-on-google");
    expectAnswer("how do i get more clients", "more-clients");
    expectAnswer("what happens if i go over my texts", "texts-run-out");
    expectAnswer("can clients tip", "tips");
    expectAnswer("how do i change my shop name", "shop-name");
    expectAnswer("why is my slot not showing", "slot-not-showing");
    expectAnswer("can i turn off punch cards", "turn-off-rewards");
    expectAnswer("how long does a haircut take", "add-services");
    expectAnswer("who owns the client data", "own-my-list");
    expectAnswer("can i charge more on saturday", "feature-day-pricing");
  });

  // A live shop's words, verbatim. Every way of asking it lands on the Google
  // answer - which used to say only "fill in your street, it's what Google
  // reads" - so the address answers must offer the private-address switch.
  it("tells a shop that wants its street off Google how to keep it private", () => {
    expectAnswer(
      "gotta figure out how to add my address but not have it on google",
      "show-up-on-google",
    );
    expectAnswer("can i hide my address from google", "show-up-on-google");
    expectAnswer("keep my address private", "show-up-on-google");
    // The switch's label, word for word, as PageEditor renders it.
    for (const id of ["show-up-on-google", "shop-address"]) {
      expect(helpAnswerById(id)?.a, id).toContain("Keep my street address private");
    }
  });

  // The partner program (a person's code, paid in cash) is not the legacy
  // free-month link, and "cash out" is not a Stripe bank payout.
  it("answers partner-code questions with the partner program, without stealing payout questions", () => {
    expectAnswer("where do i enter my referral code", "partner-program");
    expectAnswer("how do i cash out my referral money", "partner-program");
    expectAnswer("what are my partner earnings", "partner-program");
    expectAnswer("do i get anything for referring another barber", "referrals");
    expect(findHelp("when do i get paid").answer?.id).not.toBe("partner-program");
    expect(helpAnswerById("partner-program")?.a).toContain("$5");
  });

  // The AI handles TEXTS. Someone asking about voice has to be told no, or
  // they'll buy the plan expecting a switchboard.
  it("does not let the receptionist imply it answers the phone", () => {
    const res = findHelp("does the ai answer phone calls");
    expect(res.answer?.id).toBe("receptionist");
    expect(res.answer?.a).toMatch(/not voice calls/i);
  });

  /**
   * The second coverage pass, pinned.
   *
   * These are questions barbers were texting Eric instead of asking the bot,
   * measured rather than imagined: 70 real phrasings run through findHelp(),
   * of which 22 got a shrug and a dozen got a CONFIDENT WRONG ANSWER. Every
   * line below was one of those failures.
   *
   * They are tests and not just corpus entries because the failure mode is
   * REGRESSION: adding an answer changes what every other question matches.
   * Writing these cost two self-inflicted examples - a new refund entry stole
   * "when do i get my money" from payouts, and a new pricing entry stole
   * "how do i add a barber" from add-staff. Both are pinned here now.
   */
  it("answers what people were asking a human instead", () => {
    // Day to day
    expectAnswer("how do i add a walk in", "walk-in");
    expectAnswer("how do i mark someone as paid", "record-payment");
    expectAnswer("a client didnt show up what do i do", "mark-no-show");
    expectAnswer("how do i close early today", "close-early");
    expectAnswer("can i stop people booking last minute", "lead-time");
    expectAnswer("how do i see tomorrows appointments", "see-the-day");
    expectAnswer("how do i edit an appointment", "cancel-reschedule");
    expectAnswer("can i move an appointment to another barber", "move-appointment");

    // Clients
    expectAnswer("how do i add a client", "add-client-manually");
    expectAnswer("how do i text all my clients", "text-everyone");
    expectAnswer("can i mass text everyone", "text-everyone");
    // The free channel, which is what feeds the client's Announcements bell.
    expectAnswer("how do i send an announcement to my clients", "message-all-clients");
    expectAnswer("how do i send an app notification to all my clients", "message-all-clients");
    expectAnswer("broadcast a message", "message-all-clients");
    expectAnswer("can i email all my clients", "message-all-clients");
    expectAnswer("can i see who hasnt been in a while", "who-is-overdue");
    expectAnswer("how do i give someone a free cut", "comp-a-cut");
    expectAnswer("can i send a photo in a text", "picture-message");

    // Money
    expectAnswer("how do i charge a deposit", "take-a-deposit");
    expectAnswer("how do i give a client a refund", "refund-a-client");
    expectAnswer("why is my payout late", "payout-timing");
    expectAnswer("what if i get a chargeback", "chargeback");
    expectAnswer("is there a setup fee", "setup-cost");
    expectAnswer("do you charge per barber", "price-per-barber");
    expectAnswer("can i pause my account for a month", "pause-account");

    // Team + account
    expectAnswer("how do i remove someone from my team", "remove-team-member");
    expectAnswer("my barber cant log in", "barber-cant-sign-in");
    expectAnswer("i cant log in", "i-cant-log-in");
    expectAnswer("the app keeps logging me out", "i-cant-log-in");
    expectAnswer("how do i report a bug", "report-a-problem");
    expectAnswer("the booking page wont load", "page-not-loading");
    expectAnswer("are you gdpr compliant", "data-protection");
    expectAnswer("how long does setup take", "how-long-setup");
  });

  /**
   * Routes a new entry is most likely to steal. Each of these WAS answered
   * wrongly at some point in this pass, so they are the canary: if one of them
   * moves, whatever you just added is too greedy with its keywords.
   */
  it("keeps the routes that new entries tend to steal", () => {
    // "cut" is a barber's job; asking what WE take is about commission.
    expectAnswer("do you take a cut of my haircuts", "commission");
    // "money" alone is a payout question, not a refund question.
    expectAnswer("when do i get my money", "payout-timing");
    // Adding a barber is staffing, not billing.
    expectAnswer("how do i add a barber to my shop", "add-staff");
    // A phone number to CALL means us, not the AI that answers their clients.
    expectAnswer("is there a phone number i can call", "contact-human");
    // Deleting a CLIENT must never route to deleting the ACCOUNT.
    expectAnswer("how do i delete a client", "delete-client");
    expectAnswer("how do i remove a client", "delete-client");
  });

  /**
   * Double-booked chairs. The walk-in RECORDS over a booked chair on purpose
   * and flags it (#439), and the inbox lists them (#440). Six entries share
   * the words "walk-in", "double", "conflict" and "resolve", so each question
   * below is one that a neighbouring entry could plausibly steal.
   */
  it("routes the double-booking questions to the right entry", () => {
    // Adding a walk-in is still the how-to, not the warning.
    expectAnswer("how do i add a walk in", "walk-in");
    // The old headline question still lands on its own entry...
    expectAnswer("can i get double booked", "double-booking");
    // ...and the warning's own words land on the warning.
    expectAnswer("it says the chair is double-booked what do i do", "walk-in-double-booked");
    expectAnswer("walk-in recorded but this chair is double-booked", "walk-in-double-booked");
    expectAnswer("what is the conflicts tab", "conflicts-tab");
    expectAnswer("whats the number on the conflicts tab", "conflicts-tab");
    expectAnswer("what does mark resolved do", "resolve-conflict");
    expectAnswer("does resolving a conflict cancel the appointment", "resolve-conflict");
    expectAnswer("i tapped save twice on a walk in", "walk-in-saved-twice");
    expectAnswer("it says slot taken when i try to book someone", "slot-taken");
  });

  /**
   * 🔴 "Can I get double-booked?" used to answer "No." That became a
   * confidently wrong answer the day walk-ins started being recorded over a
   * booked chair. The entry must carry both halves of the rule and must never
   * claim ChairBack cancels anyone by itself.
   */
  it("tells the truth about walk-ins and double-booking", () => {
    const dbl = helpAnswerById("double-booking")!;
    expect(dbl.a).not.toMatch(/^No\./);
    expect(dbl.a).toMatch(/walk-in/i);
    expect(dbl.a).toMatch(/nothing gets cancelled for you/i);
    const warn = helpAnswerById("walk-in-double-booked")!;
    // It must not tell the barber the payment was taken by ChairBack.
    expect(warn.a).not.toMatch(/payment (was )?(saved|captured|processed)/i);
    expect(warn.a).toMatch(/on the books/i);
    const res = helpAnswerById("resolve-conflict")!;
    expect(res.a).toMatch(/doesn't cancel, move or refund/i);
    expect(res.a).toMatch(/doesn't message the customer/i);
  });

  /**
   * The corpus contradicted itself about money: "trial" promised a free plan
   * to drop onto, "whats-free" said bookings stop. The code is unambiguous -
   * hasActiveAccess() is subscription-or-trial, and the public payload carries
   * bookingPaused - so the trial answer had to change, and must not drift back.
   */
  it("tells the truth about what happens when the trial ends", () => {
    const trial = helpAnswerById("trial");
    expect(trial).toBeDefined();
    expect(trial!.a).not.toMatch(/free plan/i);
    expect(trial!.a).toMatch(/stops taking new bookings/i);
    // And it still says the reassuring, true part.
    expect(trial!.a).toMatch(/don't need a card/i);
  });

  // The inverse property, and the more important one: when we genuinely have no
  // answer, the bot must NOT invent confidence. Suggestions are the honest
  // outcome — a confidently wrong answer is the one thing worse than a shrug.
  it("declines to answer what it genuinely doesn't cover", () => {
    for (const q of ["do i need a business license", "how do i print my schedule"]) {
      const res = findHelp(q);
      expect(res.kind, `"${q}" was answered with false confidence`).toBe("suggestions");
      expect(res.suggestions.length).toBeGreaterThan(0);
    }
  });

  // ...but "no confident answer" still has to be USEFUL: the closest topic for
  // an unsupported integration is the entry that names the ones we do support.
  it("leads its suggestions with the closest real topic", () => {
    expect(findHelp("do you integrate with booksy").suggestions[0]?.id).toBe("other-tools");
    expect(findHelp("can i pause my subscription").suggestions[0]?.id).toBe("cancel-subscription");
  });
});

describe("findHelp — App Store 3.1.1", () => {
  const priced = ["how much does it cost", "cancel my subscription", "is there a free trial"];

  it("answers pricing questions in a browser", () => {
    for (const q of priced) {
      expect(findHelp(q).answer, `"${q}" unanswered on web`).not.toBeNull();
    }
  });

  it("never surfaces a priced or billing answer inside the app", () => {
    for (const q of priced) {
      const res = findHelp(q, { inApp: true });
      const surfaced = [res.answer, ...res.suggestions].filter(
        (e): e is NonNullable<typeof e> => e != null,
      );
      for (const e of surfaced) {
        expect(e.hidesInApp, `"${q}" surfaced ${e.id} in-app`).not.toBe(true);
        const href = e.action ? (featureById(e.action.featureId)?.href ?? "") : "";
        expect(isBillingHref(href)).not.toBe(true);
      }
    }
  });

  it("still gives the barber somewhere to go in-app", () => {
    for (const q of priced) {
      expect(findHelp(q, { inApp: true }).suggestions.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Drick asked for "send to only gold or whatever tier member" when the
 * Clients-page composer already did it - by app notification or email, on any
 * plan, with texting off. Nothing in help named it: "email my gold members"
 * answered the cancellation email and "broadcast" answered the Premium SMS
 * blast. These pin the route to the one that works for everyone.
 */
describe("findHelp — messaging many clients", () => {
  it.each([
    "email my gold members",
    "how do I email all my clients",
    "send a message to my gold members",
    "send a notification to all my clients",
    "broadcast",
  ])("%s -> the Clients-page composer", (q) => expectAnswer(q, "message-all-clients"));

  it("texting everyone still answers the text blast, and names the other way", () => {
    expectAnswer("how do I text all my clients at once", "text-everyone");
    expect(helpAnswerById("text-everyone")?.a).toMatch(/app notification or an email/);
  });

  it("a promo aimed at Gold is offered both ways", () => {
    const res = findHelp("send a promo to only my gold members");
    const ids = [res.answer?.id, ...res.suggestions.map((s) => s.id)];
    expect(ids).toContain("message-all-clients");
    expect(ids).toContain("promotions");
    expect(helpAnswerById("promotions")?.a).toMatch(/Email or notify/);
  });
});

/**
 * What shipped on 2026-09-28 (#510-#539), in the words a barber types.
 *
 * Before these entries, "how do I add my policy" and "book anyway" got a
 * shrug, "why can't email reach anyone" answered the SPAM-folder entry,
 * "book over someone" answered the client import, "customer wants to stop
 * card charges" answered refunds, and "waitlist text button" answered the
 * rewards-link resend. Both assistants read this corpus through the shared
 * engine, so a row here is a row for the help bubble, the Assistant tab and
 * the MCP connector at once.
 */
describe("findHelp — what shipped late September", () => {
  const BATTERY: [string, string][] = [
    // Booking policies + checklist (#537)
    ["how do I add my policy", "booking-policies"],
    ["add my policies", "booking-policies"],
    ["policy checklist", "booking-policies"],
    ["customers agree to my rules before booking", "booking-policies"],
    ["what does agreed to your policies mean", "booking-policies"],
    ["where do I put my shop rules", "booking-policies"],
    // Book anyway (#538)
    ["force a booking", "book-anyway"],
    ["book anyway", "book-anyway"],
    ["book over someone", "book-anyway"],
    ["what does the double-booked chip mean", "book-anyway"],
    ["double booked", "double-booking"],
    // The Special / Premium hour / After hours chip (2026-09-29: two barbers asked)
    ["why does it say special", "special-chip-meaning"],
    ["what is the special", "special-chip-meaning"],
    ["what does premium hour mean", "special-chip-meaning"],
    ["why does it say special on random clients", "special-chip-meaning"],
    ["what does the after hours tag mean", "special-chip-meaning"],
    // Add-ons when the barber books (#539/#519)
    ["add-ons when I book", "addons-when-you-book"],
    ["why does the calendar card show add-ons", "addons-when-you-book"],
    // Message by tier or service (#532/#534)
    ["send to only gold clients", "message-all-clients"],
    ["send to people who had a haircut", "message-by-service"],
    ["message clients who had a service", "message-by-service"],
    // The marketing-email yes (#515/#525/#527/#529)
    ["why can't email reach anyone", "email-reaches-nobody"],
    ["why does email say 0 people", "email-reaches-nobody"],
    ["how does a client say yes to marketing emails", "email-marketing-yes"],
    ["record a client's yes to email", "email-marketing-yes"],
    ["client unsubscribed from email", "email-unsubscribed"],
    ["resubscribe a client", "email-unsubscribed"],
    // Acuity (#524/#526)
    ["import my acuity services", "acuity-import-services"],
    ["acuity says reconnect", "acuity-reconnect"],
    ["reconnect acuity", "acuity-reconnect"],
    ["acuity disconnected", "acuity-reconnect"],
    // Past visits (#528)
    ["credit old visits", "rewards-past-visits"],
    ["past visits", "rewards-past-visits"],
    ["rewards start date", "rewards-past-visits"],
    ["turned on rewards and old visits didn't count", "rewards-past-visits"],
    // Waitlist Text button (#518)
    ["text someone on the waitlist", "waitlist-text"],
    ["waitlist text button", "waitlist-text"],
    // Saved-card service charge (#533/#535)
    ["customer wants to stop card charges", "customer-stop-card-charges"],
    ["stop charging my card", "customer-stop-card-charges"],
    ["charge the saved card", "saved-card-charge"],
    ["the customer stopped charges to this card", "saved-card-refused"],
    ["why can't I charge the card yet", "saved-card-refused"],
    ["card was refused approved only up to", "saved-card-refused"],
    // Add client + import (#510/#517/#522)
    ["add client says already exists", "add-client-manually"],
    ["two clients share a phone", "import-skipped-rows"],
    ["does importing clients opt them in", "import-skipped-rows"],
    // Wallet pass after the visit (#531)
    ["appointment pass after the visit", "apple-wallet"],
    ["remove the wallet pass", "apple-wallet"],
  ];
  it.each(BATTERY)("%j -> %s", (q, id) => expectAnswer(q, id));

  it("the card's own title reaches the import, by its how-to or its pointer", () => {
    // The generated "Where do I find Import services from Acuity?" pointer and
    // the hand-written how-to sit a hundredth of a point apart on the card's
    // exact title. Either is a right answer - both name the card and open it.
    expect(["acuity-import-services", "feature-acuity-service-import"]).toContain(
      findHelp("import services from acuity").answer?.id,
    );
  });

  /**
   * Words the new entries were measured stealing, one by one, from every
   * question and keyword the corpus carried before them. A question text
   * scores as heavily as a keyword and a substring of it earns the phrase
   * bonus, so "How do I import my services from Acuity?" took the bare words
   * "import" and "services", and "…the waitlist?" took "waitlist".
   */
  it("keeps the words the new entries were caught stealing", () => {
    expectAnswer("services", "feature-services");
    expectAnswer("import", "import-clients");
    expectAnswer("csv", "import-clients");
    expectAnswer("waitlist", "feature-waitlist");
    expectAnswer("add ons", "feature-addons");
    expectAnswer("new appointment", "feature-appointments");
    expectAnswer("already taken", "slot-taken");
    expectAnswer("find me", "find-my-shop");
    expectAnswer("menu", "add-services");
    expectAnswer("punches", "punch-cards");
    expectAnswer("marketing", "more-clients");
    expectAnswer("saved", "walk-in-saved-twice");
    expectAnswer("what is my cancellation policy", "my-policy");
    // The trial's words, inside the app where the trial answer is filtered
    // out, must not fall onto the slot-taken entry that now says "wait until".
    for (const q of ["try it first", "try before"]) {
      expect(findHelp(q, { inApp: true }).answer?.id, q).not.toBe("slot-taken");
    }
    expect(findHelp("texts left", { inApp: true }).answer?.id).not.toBe("waitlist-text");
    expect(findHelp("unsubscribe", { inApp: true }).answer?.id).toBe("opt-out");
  });

  /**
   * Answers that today's work made WRONG. Each pin names the sentence that
   * used to be there, so it cannot drift back.
   */
  it("no longer says what stopped being true", () => {
    const a = (id: string) => helpAnswerById(id)!.a;
    // Book anyway: customers still can't double-book; owners and managers can.
    expect(a("double-booking")).toMatch(/Not by a customer/);
    expect(a("double-booking")).toMatch(/Book anyway/);
    expect(a("double-booking")).not.toMatch(/one deliberate exception/);
    expect(a("slot-taken")).not.toMatch(/refused rather than squeezed in/);
    expect(a("slot-taken")).toMatch(/Book anyway/);
    expect(a("book-anyway")).toMatch(/Customers can never do this/);
    expect(a("book-anyway")).toMatch(/customer who is paying for or confirming/);
    // Rewards start at the switch-on; the pause does not backfill itself.
    expect(a("turn-off-rewards")).not.toMatch(/nobody loses credit/);
    expect(a("turn-off-rewards")).toMatch(/Past visits/);
    expect(a("punch-cards")).toMatch(/Once rewards are on/);
    // Add client never overwrites, and a number is not a yes to texts.
    expect(a("add-client-manually")).not.toMatch(/immediately eligible/);
    expect(a("add-client-manually")).toMatch(/already belongs to a client/);
    // The client-page switch is texts only; STOP is theirs to undo.
    expect(a("opt-out")).not.toMatch(/opt anyone out \(or back in\)/);
    expect(a("opt-out")).toMatch(/only they can opt back in/);
    // Email goes only to a recorded yes, and an import is never one.
    expect(a("message-all-clients")).toMatch(/only goes to clients who have said yes/);
    expect(a("email-reaches-nobody")).toMatch(/importing a client never counts as a yes/);
    expect(a("import-clients")).toMatch(/aren't texted, or sent your marketing emails/);
    // The Wallet pass: what it says after the visit, and what we cannot do.
    expect(a("apple-wallet")).not.toMatch(/greys itself out/);
    expect(a("apple-wallet")).toMatch(/COMPLETED, MISSED/);
    expect(a("apple-wallet")).toMatch(/can't delete a pass/);
    // The cancellation email's button follows the booking mode.
    expect(a("cancellation-email")).toMatch(/Book another appointment/);
  });

  it("keeps the saved-card charge where it applies, and conditional there", () => {
    // Only some shops' checkout can charge a saved card. The general payment
    // answers must not promise it; the answers about it say "where offered".
    for (const id of ["get-paid", "record-payment", "no-show-fee", "take-a-deposit"]) {
      expect(helpAnswerById(id)!.a, id).not.toMatch(/saved card/i);
    }
    expect(helpAnswerById("saved-card-charge")!.a).toMatch(/^Where your checkout offers it/);
    expect(helpAnswerById("saved-card-charge")!.a).toMatch(/72 hours/);
  });
});
