import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AFFILIATE_TERMS_VERSION } from "@chairback/config/affiliateProgram";

/**
 * The affiliate terms, v3: one reward for everyone - get paid an amount on
 * the first paid invoice and a smaller one for each later month, paid for
 * now as account credit - with months off already earned honoured, the
 * right to change or end the program going forward, and v2 kept readable at
 * its own address. The amounts show in the app too.
 */

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: AffiliateTermsPage } = await import("./page");
const { default: AffiliateTermsV2Page } = await import("./v2/page");

afterEach(cleanup);

describe("affiliate terms v3", () => {
  it("says they get paid, with the amounts, and how", () => {
    const { container } = render(<AffiliateTermsPage />);
    const text = container.textContent ?? "";
    expect(AFFILIATE_TERMS_VERSION).toBe("v3");
    expect(text).toContain(`version ${AFFILIATE_TERMS_VERSION}`);
    expect(text).toMatch(/you get paid through\s+the ChairBack affiliate program/);
    expect(text).toMatch(/first successful, non-zero\s+invoice .* sign-up payment of \$10\./);
    expect(text).toMatch(/Creating an account, a free trial,\s+or a zero-amount invoice earns nothing/);
    expect(text).toMatch(/monthly payment of \$5, for as long as it keeps paying/);
    expect(text).toMatch(/Each payment becomes yours 14 days after the invoice/);
    expect(text).toMatch(/paid as ChairBack account credit/);
    expect(text).toMatch(/It does not expire/);
    expect(text).toMatch(/refunded, disputed \(a chargeback\), or\s+credited back before that payment is applied, it is reversed/);
    expect(text).toMatch(/may change the program, what it pays or these terms, or end the program,\s+going forward/);
    expect(text).toMatch(/Anything you earned before a\s+change, or before the program ends, is honoured/);
    // Months off already earned are honoured; nobody can choose one any more.
    expect(text).toMatch(/A month off you had\s+already earned when this version took effect is honoured/);
    expect(text).not.toMatch(/switch|reward style/i);
    expect(container.querySelector('a[href="/affiliate-terms/v2"]')).toBeTruthy();
  });
});

describe("affiliate terms v2, kept as accepted", () => {
  it("still reads as v2, with the month-off choice it offered, and points at the current terms", () => {
    const { container } = render(<AffiliateTermsV2Page />);
    const text = container.textContent ?? "";
    expect(text).toContain("version v2");
    expect(text).toMatch(/This is an earlier version \(v2\)/);
    expect(container.querySelector('a[href="/affiliate-terms"]')).toBeTruthy();
    expect(text).toMatch(/sign-up credit of \$10\./);
    expect(text).toMatch(/A switch applies only to rewards earned after\s+it/);
    expect(text).toMatch(/One business earns one month off, once/);
  });
});
