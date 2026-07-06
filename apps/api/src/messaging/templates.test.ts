import { describe, expect, it } from "vitest";
import { serviceNounFor } from "@chairback/config";
import {
  buildNudgeBody,
  buildNudgePush,
  buildPunchEarnedBody,
  buildPunchEarnedPush,
  buildRewardRedeemedBody,
  defaultSmsTemplate,
} from "./templates.js";

/**
 * Vertical-aware rebooking copy. The default nudge (SMS + push) must use the
 * shop's service noun so a nail/spa client isn't texted about a "cut" — the #1
 * multi-vertical bug. A shop's CUSTOM template is always honored verbatim.
 */
describe("serviceNounFor", () => {
  it("maps each vertical to its noun, neutral fallback otherwise", () => {
    expect(serviceNounFor("barber")).toBe("cut");
    expect(serviceNounFor("nails")).toBe("appointment");
    expect(serviceNounFor("spa")).toBe("appointment");
    expect(serviceNounFor("tattoo")).toBe("session");
    expect(serviceNounFor("other")).toBe("visit");
    expect(serviceNounFor(null)).toBe("visit");
    expect(serviceNounFor("nonsense")).toBe("visit");
  });
});

describe("default nudge copy is vertical-aware", () => {
  it("barber default says 'cut'", () => {
    expect(defaultSmsTemplate("barber")).toContain("last cut");
  });

  it("nail studio default says 'appointment', NOT 'cut'", () => {
    const t = defaultSmsTemplate("nails");
    expect(t).toContain("last appointment");
    expect(t).not.toContain("cut");
  });

  it("buildNudgeBody uses the industry noun for the DEFAULT template", () => {
    const body = buildNudgeBody({
      firstName: "Sam",
      shopName: "Polished",
      bookingUrl: "https://book.test",
      magicToken: "tok",
      industry: "nails",
    });
    expect(body).toContain("last appointment at Polished");
    expect(body).not.toContain("cut");
    expect(body).toContain("Reply STOP to opt out.");
  });

  it("a CUSTOM template is honored verbatim regardless of industry", () => {
    const body = buildNudgeBody({
      firstName: "Sam",
      shopName: "Polished",
      bookingUrl: "https://book.test",
      magicToken: "tok",
      industry: "nails",
      template: "Yo {firstName}, your fade is calling. {bookingUrl}",
    });
    expect(body).toContain("your fade is calling");
  });

  it("with NO booking link, a CUSTOM {bookingUrl} falls back to the rewards page", () => {
    const body = buildNudgeBody({
      firstName: "Sam",
      shopName: "Polished",
      bookingUrl: null, // shop has no external booking link
      magicToken: "tok123",
      template: "Book here: {bookingUrl}",
    });
    // The "Book" link points at the client's rewards page, not a dead/empty URL.
    expect(body).toContain("/r/tok123");
    expect(body).not.toContain("Book here:  "); // no empty substitution
  });

  it("with NO booking link, the DEFAULT template uses ONE rewards CTA (not the URL twice)", () => {
    const body = buildNudgeBody({
      firstName: "Sam",
      shopName: "Polished",
      bookingUrl: null,
      magicToken: "tok123",
      // no custom template -> the no-link default
    });
    // The rewards URL appears exactly once (no duplicate "Book … • Your rewards …").
    const occurrences = body.split("/r/tok123").length - 1;
    expect(occurrences).toBe(1);
    expect(body).not.toContain("Book your next one");
    expect(body).toContain("Reply STOP to opt out.");
  });

  it("push title uses the industry noun", () => {
    expect(buildNudgePush({ firstName: "Sam", shopName: "Polished", industry: "nails" }).title).toContain(
      "next appointment",
    );
    expect(buildNudgePush({ firstName: "Sam", shopName: "Fades", industry: "barber" }).title).toContain(
      "next cut",
    );
  });
});

// Card-aware loyalty copy. The default card (cardName null/absent) must render
// EXACTLY the pre-cards copy - zero regression for every existing shop. A named
// card adds "on your X card" so a VIP punch never reads like a default one.
describe("loyalty copy is card-aware", () => {
  const base = {
    firstName: "Sam",
    shopName: "Fades",
    magicToken: "tok123",
    earned: 2,
    balance: 4,
  };

  it("default card copy is unchanged (no card phrase)", () => {
    const body = buildPunchEarnedBody(base);
    expect(body).toContain("you just earned 2 punches at Fades!");
    expect(body).not.toContain("card");
    const withNull = buildPunchEarnedBody({ ...base, cardName: null });
    expect(withNull).toBe(body);
  });

  it("a named card is called out in SMS and push", () => {
    const body = buildPunchEarnedBody({ ...base, cardName: "VIP" });
    expect(body).toContain("you just earned 2 punches on your VIP card at Fades!");
    const push = buildPunchEarnedPush({ ...base, cardName: "VIP" });
    expect(push.body).toContain("You're at 4 punches on your VIP card.");
  });

  it("redeem copy names the card only when one is set", () => {
    const plain = buildRewardRedeemedBody({
      firstName: "Sam",
      shopName: "Fades",
      magicToken: "tok123",
      rewardName: "Free Cut",
      balance: 1,
    });
    expect(plain).toContain("You have 1 punch left.");
    const carded = buildRewardRedeemedBody({
      firstName: "Sam",
      shopName: "Fades",
      magicToken: "tok123",
      rewardName: "Free Retwist",
      balance: 1,
      cardName: "Retwist",
    });
    expect(carded).toContain("You have 1 punch left on your Retwist card.");
  });
});
