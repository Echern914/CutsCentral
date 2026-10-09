import { describe, expect, it } from "vitest";
import { CODE_RESEND_SECONDS, secondsLeft, sendKey, startCooldown } from "./codeCooldown";

describe("code cooldowns", () => {
  const t0 = 1_000_000;

  it("🔴 a text's wait never holds back email - the fallback works at once", () => {
    const afterText = startCooldown({}, sendKey("sms", "(555) 555-0123"), t0);
    expect(secondsLeft(afterText, sendKey("sms", "(555) 555-0123"), t0 + 12_000)).toBe(48);
    expect(secondsLeft(afterText, sendKey("email", "sam@example.com"), t0 + 12_000)).toBe(0);
  });

  it("a corrected number may send at once; the same number, however typed, still waits", () => {
    const c = startCooldown({}, sendKey("sms", "(555) 555-0123"), t0);
    expect(secondsLeft(c, sendKey("sms", "555-555-0199"), t0 + 1000)).toBe(0);
    expect(secondsLeft(c, sendKey("sms", "+1 555 555 0123"), t0 + 1000)).toBe(59);
    expect(secondsLeft(c, sendKey("email", " Sam@Example.com "), t0)).toBe(0);
  });

  it("counts from a deadline, so time in the background is time waited", () => {
    const c = startCooldown({}, "email:sam@example.com", t0);
    expect(secondsLeft(c, "email:sam@example.com", t0)).toBe(CODE_RESEND_SECONDS);
    expect(secondsLeft(c, "email:sam@example.com", t0 + 59_001)).toBe(1);
    expect(secondsLeft(c, "email:sam@example.com", t0 + 5 * 60_000)).toBe(0);
  });
});
