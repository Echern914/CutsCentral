import { describe, expect, it } from "vitest";
import { serviceNounFor } from "@chairback/config";
import { buildNudgeBody, buildNudgePush, defaultSmsTemplate } from "./templates.js";

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

  it("push title uses the industry noun", () => {
    expect(buildNudgePush({ firstName: "Sam", shopName: "Polished", industry: "nails" }).title).toContain(
      "next appointment",
    );
    expect(buildNudgePush({ firstName: "Sam", shopName: "Fades", industry: "barber" }).title).toContain(
      "next cut",
    );
  });
});
