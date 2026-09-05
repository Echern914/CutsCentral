import { describe, expect, it } from "vitest";
import {
  BOOKING_ERROR_CODES,
  INVALID_EMAIL_MESSAGE,
  SLOT_CONFLICT_MESSAGE,
  isLikelyEmail,
} from "./bookingErrors.js";

/**
 * The shared address rule.
 *
 * 🔴 THE FAILURE THAT MATTERS HERE IS THE FALSE NEGATIVE. A customer whose real
 * address ChairBack refuses cannot book at all, and will not email to say so -
 * they simply leave. So the accepted list below is the point of this file, and
 * it is deliberately long: every one of these is a shape a real person uses and
 * a naive regex rejects.
 *
 * The function runs in BOTH apps (the booking form imports it, and the API's
 * zod schema refines with it), which is the only way a page cannot accept an
 * address the server would refuse - or, worse, refuse one the server would have
 * taken.
 */
describe("isLikelyEmail accepts the addresses real people have", () => {
  it.each([
    ["a plus tag", "dana+haircut@gmail.com"],
    ["a dotted local part", "first.last@mail.com"],
    ["a two-part TLD", "first.last@mail.co.uk"],
    ["a deep subdomain", "x@deep.sub.domain.example.com"],
    ["an apostrophe", "o'brien@example.com"],
    ["a long TLD", "dana@example.photography"],
    ["a .travel TLD", "dana@example.travel"],
    ["mixed case", "DANA.Okafor@Example.COM"],
    ["a very short address", "d@ex.io"],
    ["digits and hyphens in the domain", "dana@my-shop-2.example.com"],
    ["an underscore in the local part", "dana_okafor@example.com"],
    ["surrounding whitespace, which is trimmed", "  dana@example.com  "],
  ])("accepts %s", (_why, value) => {
    expect(isLikelyEmail(value)).toBe(true);
  });

  it.each([
    ["nothing at all", ""],
    ["only whitespace", "   "],
    ["no @", "not-an-email"],
    ["nothing after the @", "dana@"],
    ["nothing before the @", "@example.com"],
    ["two @s", "dana@@example.com"],
    ["two @s apart", "dana@a@example.com"],
    ["a space inside", "dana okafor@example.com"],
    ["a domain with no dot", "dana@localhost"],
    ["a one-letter TLD", "dana@example.c"],
    ["a numeric TLD", "dana@example.12"],
    ["a leading dot", ".dana@example.com"],
    ["a trailing dot in the local part", "dana.@example.com"],
    ["a doubled dot", "dana..okafor@example.com"],
    ["a doubled dot in the domain", "dana@example..com"],
    ["a leading hyphen on the domain", "dana@-example.com"],
    ["a trailing dot on the domain", "dana@example.com."],
    ["a newline", "dana@example.com\\nBcc: someone"],
  ])("rejects %s", (_why, value) => {
    expect(isLikelyEmail(value)).toBe(false);
  });

  it("refuses an absurdly long address rather than passing it downstream", () => {
    expect(isLikelyEmail(`${"a".repeat(300)}@example.com`)).toBe(false);
    expect(isLikelyEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
    expect(isLikelyEmail(`${"a".repeat(64)}@example.com`)).toBe(true);
  });

  it("checks the SHAPE only, and never claims the mailbox exists", () => {
    // A perfectly-formed address at a domain that does not exist is still a
    // valid address as far as a booking form may say. Claiming otherwise would
    // mean promising something we cannot check.
    expect(isLikelyEmail("someone@thisdomaindoesnotexistanywhere.com")).toBe(true);
  });
});

describe("the vocabulary itself", () => {
  it("carries every code the booking flow needs to tell apart", () => {
    for (const code of [
      "INVALID_EMAIL",
      "INVALID_PHONE",
      "VALIDATION_ERROR",
      "SLOT_UNAVAILABLE",
      "PAYMENT_METHOD_FAILED",
      "RATE_LIMITED",
      "BOOKING_FAILED",
    ]) {
      expect(BOOKING_ERROR_CODES).toContain(code);
    }
    // Codes are stable identifiers, never sentences: SCREAMING_SNAKE only.
    for (const code of BOOKING_ERROR_CODES) expect(code).toMatch(/^[A-Z_]+$/);
    expect(new Set(BOOKING_ERROR_CODES).size).toBe(BOOKING_ERROR_CODES.length);
  });

  it("pins the two sentences a customer actually reads", () => {
    expect(INVALID_EMAIL_MESSAGE).toBe("Enter a valid email address.");
    // The conflict copy names what happened AND what the page already did about
    // it - "pick another" with the dead chip still on screen is what made this
    // read as a broken product.
    expect(SLOT_CONFLICT_MESSAGE).toBe(
      "That time was just booked. We refreshed the available times—please choose another.",
    );
  });
});
