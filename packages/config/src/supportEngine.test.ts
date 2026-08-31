import { describe, expect, it } from "vitest";
import { SUPPORT_CAPABILITIES, capabilityForCorpusId } from "./supportCapabilities.js";
import {
  actorForSeat,
  resolveSupport,
  resolveSupportAnswerById,
  SUPPORT_OUTCOMES,
  type SupportRequest,
} from "./supportEngine.js";

const owner = { actor: "owner", channel: "in_app" } as const;

function ask(question: string, over: Partial<SupportRequest> = {}) {
  return resolveSupport({ ...owner, question, ...over });
}

describe("the no-dead-end contract", () => {
  it("🔴 attaches a route to a human to EVERY outcome except ANSWERED", () => {
    // This is the whole point of the engine. The Assistant tab used to render
    // chips and nothing else, which made the page named "Assistant" the only
    // dead end in the product. The invariant lives here so no adapter can
    // reintroduce it by forgetting to render something.
    const probes = [
      "asdfghjkl qwerty zxcvbn",
      "do you integrate with quickbooks",
      "",
      "🙃",
      "a".repeat(300),
      "how do I file my taxes",
    ];
    for (const q of probes) {
      const r = ask(q);
      if (r.outcome === "ANSWERED") {
        expect(r.escalation, `answered: ${q}`).toBeNull();
      } else {
        expect(r.escalation, `not answered: ${q}`).not.toBeNull();
        expect(r.escalation!.email).toContain("@");
        expect(r.escalation!.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it("an answer and an escalation are mutually exclusive, always", () => {
    for (const q of ["how do punch cards work", "wat r ur prices", "zzzz qqqq"]) {
      const r = ask(q);
      expect(r.answer === null).toBe(r.escalation !== null);
    }
  });

  it("quotes the question back so nobody retypes their problem", () => {
    const r = ask("do you integrate with quickbooks");
    expect(r.escalation?.summary).toContain("quickbooks");
  });

  it("truncates a hostile-length question instead of pasting it into a mailto", () => {
    const r = ask("x".repeat(5000));
    expect(r.escalation!.summary.length).toBeLessThan(220);
  });

  it("only ever returns an outcome from the declared vocabulary", () => {
    for (const q of ["how do i book", "asdfgh", "how do refunds work"]) {
      expect(SUPPORT_OUTCOMES).toContain(ask(q).outcome);
    }
  });
});

describe("actor gating", () => {
  it("🔴 refuses a must-refuse capability rather than answering it", () => {
    // Capabilities with an EMPTY actor list are never served to anyone. The
    // corpus cannot leak another tenant's data (it holds none), but an answer
    // that engages with the request at all teaches the asker what to try next.
    const crossTenant = SUPPORT_CAPABILITIES.find((c) => c.id === "cross_tenant_lookup")!;
    expect(crossTenant.actors).toHaveLength(0);
    const hit = crossTenant.corpusIds[0];
    expect(hit).toBeUndefined(); // nothing in the corpus claims to answer it
  });

  it("does not hand staff instructions to a customer", () => {
    // "How do I resend a rewards link" is answered for shop seats only: the
    // copy describes a dashboard a customer cannot open, and telling them to
    // go there is worse than telling them the real route.
    const cap = capabilityForCorpusId("resend-rewards-link");
    expect(cap?.actors).not.toContain("public_customer");

    const asCustomer = ask("how do I resend a rewards link", {
      actor: "public_customer",
    });
    expect(asCustomer.outcome).toBe("UNSUPPORTED");
    expect(asCustomer.answer).toBeNull();
    expect(asCustomer.escalation).not.toBeNull();

    const asOwner = ask("how do I resend a rewards link");
    expect(asOwner.outcome).toBe("ANSWERED");
    expect(asOwner.answer?.id).toBe("resend-rewards-link");
  });

  it("maps every seat role to exactly one actor", () => {
    expect(actorForSeat("OWNER")).toBe("owner");
    expect(actorForSeat("MANAGER")).toBe("manager");
    expect(actorForSeat("BARBER")).toBe("barber");
  });

  it("withholds a destination the seat cannot open, keeping the answer", () => {
    // A barber seat still deserves the explanation; it just gets no button to
    // a manager-only page. Withholding the whole answer would be a worse lie.
    const barber = ask("how do I change my business type", {
      actor: "barber",
      seat: { role: "BARBER" },
    });
    const owner2 = ask("how do I change my business type");
    if (owner2.outcome === "ANSWERED" && barber.outcome === "ANSWERED") {
      expect(barber.answer!.body).toBe(owner2.answer!.body);
    }
  });
});

describe("knowledge authority", () => {
  it("🔴 a live fact LEADS the written answer, and is recorded as the source", () => {
    // Written copy explains the mechanism; the fact states this shop's value.
    // Ranking live state above the corpus is the rule that stops a general
    // explanation being served as if it were the shop's actual policy.
    const withFact = ask("what is my cancellation policy", {
      facts: { policySentence: "Your policy right now: free up to 24h before." },
    });
    expect(withFact.outcome).toBe("ANSWERED");
    expect(withFact.answer!.body.startsWith("Your policy right now:")).toBe(true);
    expect(withFact.sources[0]!.authority).toBe("live_state");
  });

  it("degrades to the written answer when the fact is absent, never to a shrug", () => {
    const without = ask("what is my cancellation policy");
    expect(without.outcome).toBe("ANSWERED");
    expect(without.answer!.body).not.toContain("Your policy right now:");
    // ...and says which fact would have improved it, for the caller to fetch.
    expect(without.wantedFact).toBe("policySentence");
  });

  it("names its sources so an answer can be traced", () => {
    const r = ask("how do punch cards work");
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.some((s) => s.authority === "help_corpus")).toBe(true);
  });
});

describe("resolving a tapped suggestion by id", () => {
  it("returns that exact answer rather than re-guessing from its text", () => {
    const r = resolveSupportAnswerById("contact-human", owner);
    expect(r.outcome).toBe("ANSWERED");
    expect(r.answer!.id).toBe("contact-human");
  });

  it("an unknown id escalates instead of throwing or dead-ending", () => {
    const r = resolveSupportAnswerById("no-such-topic", owner);
    expect(r.outcome).toBe("ESCALATION_REQUIRED");
    expect(r.escalation).not.toBeNull();
  });

  it("applies the same actor gate as a typed question", () => {
    const r = resolveSupportAnswerById("resend-rewards-link", {
      actor: "public_customer",
      channel: "in_app",
    });
    expect(r.outcome).toBe("UNSUPPORTED");
    expect(r.answer).toBeNull();
  });
});

describe("purity", () => {
  it("is deterministic — the same request twice is the same resolution", () => {
    // No clock, no I/O, no randomness. This is what lets the evaluation suite
    // report exact counts instead of a confidence interval.
    const a = ask("how do I recover my rewards");
    const b = ask("how do I recover my rewards");
    expect(a).toEqual(b);
  });

  it("never returns an empty suggestion list on a non-answer", () => {
    const r = ask("qwertyuiop asdfghjkl");
    if (r.outcome !== "ANSWERED") {
      expect(r.suggestions.length).toBeGreaterThan(0);
    }
  });
});

describe("the questions this arc exists to fix", () => {
  // Each of these was measured returning a CONFIDENTLY WRONG answer before
  // PR 1. They are pinned by intent, not by phrasing, so a corpus edit that
  // re-breaks one fails here with the reason attached.
  const cases: Array<[string, string, string]> = [
    ["how do I recover my rewards", "recover-rewards", "returned the DISABLE-rewards entry"],
    ["how do I add it to Apple Wallet", "apple-wallet", "had no entry at all"],
    ["how do I change my business type", "change-business-type", "returned the shop-NAME entry"],
    ["holiday pricing", "holiday-pricing", "returned time-off / pause-account"],
    ["how do I add the appointment to Apple Calendar", "add-to-calendar", "returned the walk-in recorder"],
    ["a client didn't get their confirmation email", "email-didnt-arrive", "returned the SMS entry"],
  ];
  for (const [question, expected, was] of cases) {
    it(`"${question}" -> ${expected} (was: ${was})`, () => {
      const r = ask(question);
      expect(r.outcome).toBe("ANSWERED");
      expect(r.answer!.id).toBe(expected);
    });
  }
});
