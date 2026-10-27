import { describe, expect, it } from "vitest";
import { AFFILIATE_POLICY, bpsToPercent } from "@chairback/config";
import { buildAffiliateEmail } from "./affiliateEmails.js";

/**
 * The approval email states the commission program from the policy object -
 * never the retired "a month off" promise, never "never cash", never a dollar.
 */
describe("affiliate approval email", () => {
  const email = buildAffiliateEmail("affiliate_approved", {
    shopName: "Test Studio",
    code: "abcDEF123456",
    holdDays: AFFILIATE_POLICY.qualification.holdDaysAfterSecond,
  });

  it("states the commission rates, window and hold from AFFILIATE_POLICY.commission", () => {
    const c = AFFILIATE_POLICY.commission;
    expect(email.text).toContain(`${bpsToPercent(c.cashBps)}% of what it pays`);
    expect(email.text).toContain(`${bpsToPercent(c.creditBps)}% as ChairBack credit`);
    expect(email.text).toContain(`held ${c.holdDays} days`);
    expect(email.text).toMatch(/Credit is the default/);
  });

  it("no longer promises a month off, never says 'never cash', and names no dollar amount", () => {
    for (const body of [email.text, email.html]) {
      expect(body).not.toMatch(/month off/i);
      expect(body).not.toMatch(/never cash/i);
      expect(body).not.toMatch(/\$\s?\d/);
    }
  });
});
