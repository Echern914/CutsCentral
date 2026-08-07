import { describe, expect, it } from "vitest";
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

  it("every action href is an in-app path", () => {
    for (const e of HELP_CORPUS) {
      if (!e.action) continue;
      expect(e.action.href.startsWith("/"), `${e.id} -> ${e.action.href}`).toBe(true);
      expect(e.action.label.trim().length, `${e.id} action label`).toBeGreaterThan(0);
    }
  });

  // App Store 3.1.1: an answer that links the subscription page is a purchase
  // back door, exactly like the FeatureSearch entries we already filter.
  it("anything steering to billing is marked hidesInApp", () => {
    for (const e of HELP_CORPUS) {
      if (e.action?.href.startsWith("/dashboard/billing") || e.action?.href === "/pricing") {
        expect(e.hidesInApp, `${e.id} links billing but is not hidesInApp`).toBe(true);
      }
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
    expect(helpAnswerById("feature-inbox")?.action?.href).toBe("/dashboard/inbox");
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
      expect(res.answer?.action?.href, `"${q}"`).toBeTruthy();
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

  // The AI handles TEXTS. Someone asking about voice has to be told no, or
  // they'll buy the plan expecting a switchboard.
  it("does not let the receptionist imply it answers the phone", () => {
    const res = findHelp("does the ai answer phone calls");
    expect(res.answer?.id).toBe("receptionist");
    expect(res.answer?.a).toMatch(/not voice calls/i);
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
        expect(e.action?.href.startsWith("/dashboard/billing")).not.toBe(true);
      }
    }
  });

  it("still gives the barber somewhere to go in-app", () => {
    for (const q of priced) {
      expect(findHelp(q, { inApp: true }).suggestions.length).toBeGreaterThan(0);
    }
  });
});
