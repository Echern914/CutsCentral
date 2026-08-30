import { describe, expect, it } from "vitest";
import { buildFrom, parseFrom, wrapEmailHtml } from "./email.js";

/**
 * The deliverability half of the email seam.
 *
 * None of this guarantees inbox placement - nobody can promise that. What it
 * pins are the defects ChairBack actually controls, each of which is a known
 * negative signal: an unrecognised sender, a bare HTML fragment with no
 * charset, and an authenticated domain accidentally rewritten.
 */

describe("parseFrom", () => {
  it("splits a display-name form", () => {
    expect(parseFrom("ChairBack <hello@getchairback.com>")).toEqual({
      name: "ChairBack",
      address: "hello@getchairback.com",
    });
  });

  it("handles a bare address", () => {
    expect(parseFrom("hello@getchairback.com")).toEqual({
      name: null,
      address: "hello@getchairback.com",
    });
  });

  it("strips surrounding quotes from the name", () => {
    expect(parseFrom('"ChairBack Bookings" <hello@getchairback.com>').name).toBe(
      "ChairBack Bookings",
    );
  });
});

describe("buildFrom", () => {
  const BASE = "ChairBack <hello@getchairback.com>";

  it("leads with the shop, because that is who the customer knows", () => {
    expect(buildFrom(BASE, "Drick's Barbershop")).toBe(
      '"Drick\'s Barbershop via ChairBack" <hello@getchairback.com>',
    );
  });

  it("🔴 NEVER changes the address - that is what SPF/DKIM/DMARC authenticate", () => {
    for (const shop of ["Drick's", "A", "Fade Lab", "x".repeat(200)]) {
      expect(buildFrom(BASE, shop)).toContain("<hello@getchairback.com>");
    }
    expect(buildFrom("hello@getchairback.com", "Fade Lab")).toContain(
      "<hello@getchairback.com>",
    );
  });

  it("falls back to the configured From when there is no shop name", () => {
    expect(buildFrom(BASE, undefined)).toBe(BASE);
    expect(buildFrom(BASE, "   ")).toBe(BASE);
  });

  it("cannot be used to inject a header", () => {
    const nasty = 'Evil"\r\nBcc: victim@example.com\r\nX-Bad: <a@b.c>';
    const from = buildFrom(BASE, nasty);
    // The property that matters is STRUCTURAL, not lexical: a header can only
    // be forged with a line break, and a second recipient only with a second
    // address. "Bcc:" surviving as display text inside the quoted name is
    // inert - it reads oddly, it cannot act.
    expect(from).not.toContain("\r");
    expect(from).not.toContain("\n");
    expect(from.match(/</g) ?? []).toHaveLength(1);
    expect(from.match(/>/g) ?? []).toHaveLength(1);
    expect(from).toContain("<hello@getchairback.com>");
    // The name stays ONE quoted token: an opening quote, a closing quote, and
    // nothing unescaped between them that could end it early.
    expect(from.match(/"/g) ?? []).toHaveLength(2);
    expect(from.startsWith('"')).toBe(true);
  });

  it("bounds a very long shop name so the header stays sane", () => {
    const from = buildFrom(BASE, "Q".repeat(300));
    expect(from.length).toBeLessThan(140);
  });
});

describe("wrapEmailHtml", () => {
  const frag = '<div style="color:#fff">Booked</div>';

  it("turns a bare fragment into a real document", () => {
    const html = wrapEmailHtml(frag, "Booking confirmed: Fade at Drick's");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<title>");
    expect(html).toContain("viewport");
    expect(html).toContain(frag);
  });

  it("adds a preheader so Gmail does not scrape the first visible line", () => {
    const html = wrapEmailHtml(frag, "Canceled: Fade at Drick's");
    // Hidden, but present before the body content.
    expect(html).toContain("Canceled: Fade at Drick");
    expect(html.indexOf("Canceled: Fade at Drick")).toBeLessThan(html.indexOf(frag));
    expect(html).toContain("max-height:0");
  });

  it("leaves an already-complete document alone", () => {
    const doc = "<html><body>hi</body></html>";
    expect(wrapEmailHtml(doc, "s")).toBe(doc);
  });

  it("constrains width for mobile clients", () => {
    expect(wrapEmailHtml(frag, "s")).toContain("max-width:560px");
  });

  it("does not let the subject break out of the title or preheader", () => {
    const html = wrapEmailHtml(frag, 'Fade </title><script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</title><");
  });
});
