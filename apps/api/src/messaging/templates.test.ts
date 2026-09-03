import { describe, expect, it } from "vitest";
import { serviceNounFor } from "@chairback/config";
import {
  buildAppointmentConfirmationBody,
  buildAppointmentConfirmationEmail,
  buildAppointmentReminderBody,
  buildAppointmentReminderEmail,
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

  it("a shop's CUSTOM serviceNoun overrides the industry word (SMS + push)", () => {
    expect(defaultSmsTemplate("barber", true, "twist")).toContain("last twist");
    const body = buildNudgeBody({
      firstName: "Sam",
      shopName: "Locs & Co",
      bookingUrl: "https://book.test",
      magicToken: "tok",
      industry: "barber",
      serviceNoun: "twist",
    });
    expect(body).toContain("last twist at Locs & Co");
    expect(body).not.toContain("cut");
    expect(
      buildNudgePush({ firstName: "Sam", shopName: "Locs & Co", industry: "barber", serviceNoun: "twist" })
        .title,
    ).toContain("next twist");
  });

  it("a blank custom serviceNoun falls back to the industry word", () => {
    expect(defaultSmsTemplate("barber", true, "  ")).toContain("last cut");
    expect(defaultSmsTemplate("barber", true, null)).toContain("last cut");
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

  // Since /r/<token> became the shop-page landing, each link must match its
  // message: a text about punches opens the punch card (/rewards); a rebooking
  // nudge lands on the shop page (bare /r/), which owns the Book button.
  it("loyalty texts link to the punch card; nudges link to the landing", () => {
    expect(buildPunchEarnedBody(base)).toContain("/r/tok123/rewards");
    expect(
      buildRewardRedeemedBody({
        firstName: "Sam",
        shopName: "Fades",
        magicToken: "tok123",
        rewardName: "Free Cut",
        balance: 1,
      }),
    ).toContain("/r/tok123/rewards");
    const nudge = buildNudgeBody({
      firstName: "Sam",
      shopName: "Fades",
      bookingUrl: null,
      magicToken: "tok123",
    });
    expect(nudge).toContain("/r/tok123");
    expect(nudge).not.toContain("/r/tok123/rewards");
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

/**
 * "Where is it?" - the most-asked question about an appointment, and the one
 * the confirmation and reminder never answered. Every builder takes the shop's
 * ADDRESS COLUMNS and formats them through @chairback/config, so the address in
 * the email is the address the receptionist quotes and the calendar entry
 * carries. A shop with none published says nothing rather than guessing.
 */
describe("appointment messages carry the shop address", () => {
  const SHOP = {
    addressStreet: "123 Main St",
    addressCity: "Wilmington",
    addressRegion: "DE",
    addressPostal: "19801",
  };
  const base = {
    firstName: "Michael",
    shopName: "Chern Cuts",
    serviceName: "Haircut",
    startsAt: new Date("2026-09-08T18:00:00Z"),
    timezone: "America/New_York",
    staffName: "Dre",
    manageToken: "A".repeat(43),
  };

  it("the confirmation email says where, as a directions link", () => {
    const email = buildAppointmentConfirmationEmail({ ...base, address: SHOP });
    expect(email.text).toContain("Where: 123 Main St, Wilmington, DE 19801");
    expect(email.html).toContain("Where");
    expect(email.html).toContain("123 Main St");
    expect(email.html).toContain("Get directions");
    expect(email.html).toContain("https://www.google.com/maps/search/?api=1&amp;query=");
  });

  it("so does the reminder email", () => {
    const email = buildAppointmentReminderEmail({ ...base, address: SHOP });
    expect(email.text).toContain("Where: 123 Main St, Wilmington, DE 19801");
    expect(email.html).toContain("Get directions");
  });

  it("the texts carry it too", () => {
    expect(buildAppointmentConfirmationBody({ ...base, address: SHOP })).toContain(
      "123 Main St, Wilmington, DE 19801.",
    );
    expect(buildAppointmentReminderBody({ ...base, address: SHOP })).toContain(
      "123 Main St, Wilmington, DE 19801.",
    );
  });

  it("the reminder text stays inside its existing two segments - the address rides for free", () => {
    // Already two segments before the address (the manage link alone is ~62
    // chars). Concatenated SMS carries 153 GSM-7 chars per segment; a THIRD
    // segment would raise the reminder bill by half for every shop, so the
    // budget is pinned here with a deliberately long name, service and shop.
    const body = buildAppointmentReminderBody({
      ...base,
      firstName: "Christopher",
      serviceName: "Skin Fade + Beard Trim",
      shopName: "The Gentlemen's Grooming Lounge",
      address: { ...SHOP, addressStreet: "1234 Washington Boulevard" },
    });
    expect(body.length).toBeLessThanOrEqual(306);
  });

  it("a shop with no published address says nothing about one", () => {
    const partial = { addressCity: "Wilmington", addressRegion: "DE" }; // no street
    const email = buildAppointmentConfirmationEmail({ ...base, address: partial });
    expect(email.text).not.toContain("Where:");
    expect(email.html).not.toContain(">Where<");
    expect(email.html).not.toContain("Get directions");
    expect(buildAppointmentReminderBody({ ...base, address: partial })).not.toContain("Wilmington");
    expect(buildAppointmentReminderBody({ ...base })).not.toContain("Where");
  });

  it("escapes what the barber typed before it reaches HTML", () => {
    const email = buildAppointmentConfirmationEmail({
      ...base,
      address: { addressStreet: "12 A&B St <Unit 3>", addressCity: "Queens" },
    });
    expect(email.html).toContain("12 A&amp;B St &lt;Unit 3&gt;");
    expect(email.html).not.toContain("<Unit 3>");
  });
});
