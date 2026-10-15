import { describe, expect, it } from "vitest";
import type { BookedOutBrief } from "./bookedOut.js";
import { bookedOutText } from "./bookedOut.js";
import { resolveFeature } from "./features.js";
import { findHelp } from "./helpMatch.js";
import { resolveSupport } from "./supportEngine.js";

/**
 * "How do I get booked out more?" - Drick's question (2026-10-15), answered
 * from the shop's own numbers when the Assistant supplies them, and with the
 * written advice everywhere else.
 */
const BRIEF: BookedOutBrief = {
  scope: "shop",
  headline: "The next 2 weeks are 38% booked, with about 62 hours still open.",
  items: [
    {
      id: "upcoming_fill",
      title: "Fill your next two weeks",
      finding: "Your next 2 weeks are 38% booked, with about 62 hours still open.",
      fix: "Send your clients a message about the open times.",
      action: { label: "Message clients", featureId: "message-clients" },
    },
    {
      id: "overdue_regulars",
      title: "Bring back regulars who are due",
      finding: "12 regular clients are past their usual gap between visits with nothing booked.",
      fix: "A short message with your booking link.",
      action: { label: "Find overdue clients", featureId: "rebook-nudges" },
    },
    {
      // A destination a provider seat may not open.
      id: "test_billing",
      title: "Something only the owner can do",
      finding: "A number.",
      fix: "A fix.",
      action: { label: "Open billing", featureId: "billing" },
    },
  ],
  strengths: ["Only 2% of bookings were no-shows."],
  basis: "Based on your shop's appointments over the last 8 weeks and the next 2.",
};

describe("matching Drick's question", () => {
  it("🔴 every way of asking reaches the booked-out answer", () => {
    for (const q of [
      "what should i do to get booked out more",
      "How do I get booked out more?",
      "how do i get booked out",
      "how can i get more bookings",
      "how do i get more clients",
      "how do i get busier",
      "why am i not getting booked",
      "how do i grow my business",
      "what am i lacking",
      "how do i fill my schedule",
      "how do i get more appointments",
    ]) {
      expect(findHelp(q).answer?.id, q).toBe("more-clients");
    }
  });

  it("does not take the waitlist's question", () => {
    expect(findHelp("I'm fully booked what now").answer?.id).toBe("waitlist");
  });
});

describe("with the shop's own numbers", () => {
  const ask = (role: "OWNER" | "BARBER") =>
    resolveSupport({
      question: "what should i do to get booked out more",
      actor: role === "OWNER" ? "owner" : "barber",
      channel: "in_app",
      seat: { role },
      facts: { bookedOut: BRIEF },
    });

  it("🔴 the brief IS the answer: headline first, one item per rule, live source recorded", () => {
    const r = ask("OWNER");
    expect(r.outcome).toBe("ANSWERED");
    expect(r.answer!.body.split("\n\n")[0]).toBe(BRIEF.headline);
    expect(r.answer!.items!.map((i) => i.id)).toEqual(["upcoming_fill", "overdue_regulars", "test_billing"]);
    expect(r.answer!.items![0]!.finding).toBe(BRIEF.items[0]!.finding);
    expect(r.answer!.strengths).toEqual(BRIEF.strengths);
    expect(r.answer!.basis).toBe(BRIEF.basis);
    expect(r.sources[0]).toEqual({ authority: "live_state", id: "bookedOut" });
    expect(r.wantedFact).toBeUndefined();
  });

  it("🔴 each button is resolved for THIS seat; one a provider can't open comes back empty", () => {
    for (const role of ["OWNER", "BARBER"] as const) {
      const r = ask(role);
      for (const item of r.answer!.items!) {
        const featureId = BRIEF.items.find((b) => b.id === item.id)!.action!.featureId;
        const resolved = resolveFeature(featureId, { role });
        expect(item.action?.href ?? null, `${role} ${featureId}`).toBe(resolved.ok ? resolved.href : null);
      }
    }
    // The point of the case above: billing is NOT open to a provider seat.
    expect(resolveFeature("billing", { role: "BARBER" }).ok).toBe(false);
    expect(ask("BARBER").answer!.items!.find((i) => i.id === "test_billing")!.action).toBeNull();
  });

  it("an empty brief says nothing stands out rather than listing nothing", () => {
    const r = resolveSupport({
      question: "how do i get booked out",
      actor: "owner",
      channel: "in_app",
      seat: { role: "OWNER" },
      facts: { bookedOut: { ...BRIEF, items: [] } },
    });
    expect(r.answer!.body).toContain("Nothing in your numbers stands out right now.");
    expect(r.answer!.items).toEqual([]);
  });
});

describe("without the numbers", () => {
  it("🔴 the written advice, and the engine says which fact would have helped", () => {
    const r = resolveSupport({ question: "how do i get booked out more", actor: "owner", channel: "in_app" });
    expect(r.outcome).toBe("ANSWERED");
    expect(r.answer!.body).toMatch(/^Three things, in the order that actually works/);
    expect(r.answer!.items).toBeUndefined();
    expect(r.wantedFact).toBe("bookedOut");
  });
});

describe("bookedOutText", () => {
  it("renders the brief as plain paragraphs for a text-only channel", () => {
    const text = bookedOutText(BRIEF);
    expect(text.split("\n\n")[0]).toBe(BRIEF.headline);
    expect(text).toContain("1. Fill your next two weeks. Your next 2 weeks are 38% booked");
    expect(text).toContain("Going well: Only 2% of bookings were no-shows.");
  });
});
