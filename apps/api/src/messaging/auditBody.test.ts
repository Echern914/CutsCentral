import { describe, expect, it } from "vitest";
import { redactForAudit } from "./auditBody.js";

/** One rule: no URL survives into a stored body. */
describe("redactForAudit", () => {
  it("strips a rewards link but keeps the words", () => {
    const body =
      "Marcus, you earned a punch at Fade Lab! Your rewards: https://getchairback.com/r/tok_abc123/rewards";
    expect(redactForAudit(body)).toBe(
      "Marcus, you earned a punch at Fade Lab! Your rewards: [link]",
    );
  });

  it("strips a manage link mid-sentence", () => {
    expect(
      redactForAudit(
        "See you at 2pm. Manage: https://getchairback.com/book/manage/mtok9 Reply STOP to opt out.",
      ),
    ).toBe("See you at 2pm. Manage: [link] Reply STOP to opt out.");
  });

  it("strips every URL shape - http, https, bare www", () => {
    expect(redactForAudit("a http://x.co/p b https://y.co/q c www.z.co/r d")).toBe(
      "a [link] b [link] c [link] d",
    );
  });

  it("leaves a plain message untouched", () => {
    const body = "Chair's free - come on by whenever you're ready.";
    expect(redactForAudit(body)).toBe(body);
  });

  it("passes null through (body-less ledger rows stay body-less)", () => {
    expect(redactForAudit(null)).toBeNull();
  });

  /**
   * 🔴 THE CONTRACT: no ChairBack credential URL of ANY shape survives. Each
   * case below is a real URL this codebase builds into an outbound body -
   * plus the app's own custom scheme, which is registered and WILL appear in
   * a template eventually. The matcher is scheme-agnostic so that day needs
   * no code change.
   */
  it("strikes every ChairBack credential URL shape, including custom schemes", () => {
    const cases = [
      "https://getchairback.com/r/tok_abc123",               // rewards (nudge/loyalty)
      "https://getchairback.com/r/tok_abc123/rewards",       // punch card
      "https://getchairback.com/book/manage/mtok_9",         // cancel/reschedule
      "https://getchairback.com/waitlist/offer/wtok_7",      // waitlist claim
      "https://getchairback.com/line#t=ltok_4",              // walk-in tracking (FRAGMENT)
      "https://getchairback.com/my-rewards",                 // recovery door
      "chairback://r/tok_abc123/rewards",                    // the app's own scheme
      "http://localhost:3000/r/tok_abc123",                  // dev/base-url variants
      "www.getchairback.com/r/tok_abc123",
    ];
    for (const url of cases) {
      const stored = redactForAudit(`Hey Marcus - ${url} Reply STOP to opt out.`);
      expect(stored).toBe("Hey Marcus - [link] Reply STOP to opt out.");
      // Belt and braces: no fragment of the credential survives anywhere.
      expect(stored).not.toContain("tok_");
      expect(stored).not.toContain("://");
    }
  });

  it("does not mistake ordinary message text for a URL", () => {
    for (const body of [
      "See you at 2:30 - chair 3.",
      "Ratio is 3:1 and the price is $40.",
      "Reply STOP to opt out.",
    ]) {
      expect(redactForAudit(body)).toBe(body);
    }
  });
});
