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
});
