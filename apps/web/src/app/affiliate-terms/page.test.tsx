import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AFFILIATE_TERMS_VERSION } from "@chairback/config/affiliateProgram";

/**
 * The affiliate terms, v2: account credit by default (an amount on the first
 * paid invoice, a smaller one for each later month), a month off as the
 * alternative, credit only, reversals, and the right to change or end the
 * program going forward with earned rewards honoured. The Affiliates tab
 * links here from inside the iOS app, so the amounts are web-only.
 */

const native = vi.hoisted(() => ({ on: false }));
vi.mock("@/components/HideInNativeApp", () => ({
  HideInNativeApp: ({ children }: { children: React.ReactNode }) =>
    native.on ? null : <span data-native-hide>{children}</span>,
}));
vi.mock("@/components/ShowInNativeApp", () => ({
  ShowInNativeApp: ({ children }: { children: React.ReactNode }) => (native.on ? <>{children}</> : null),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: AffiliateTermsPage } = await import("./page");

afterEach(() => {
  cleanup();
  native.on = false;
});

describe("affiliate terms v2", () => {
  it("states the credit rules on the web, with the amounts", () => {
    const { container } = render(<AffiliateTermsPage />);
    const text = container.textContent ?? "";
    expect(AFFILIATE_TERMS_VERSION).toBe("v2");
    expect(text).toContain(`version ${AFFILIATE_TERMS_VERSION}`);
    expect(text).toMatch(/first successful, non-zero\s+invoice .* sign-up credit of \$10\./);
    expect(text).toMatch(/Creating an account, a free trial,\s+or a zero-amount invoice earns nothing/);
    expect(text).toMatch(/monthly credit of \$5, for as long as it keeps paying/);
    expect(text).toMatch(/Each credit becomes available 14 days after the payment/);
    expect(text).toMatch(/Account credit does not expire/);
    expect(text).toMatch(/never paid out as cash, have\s+no cash value, are not transferable/);
    expect(text).toMatch(/refunded, disputed \(a chargeback\), or\s+credited back before the reward is applied, that reward is reversed/);
    expect(text).toMatch(/may change the program, its rewards or these terms, or end the program,\s+going forward/);
    expect(text).toMatch(/Rewards you\s+earned before a change, or before the program ends, are honoured/);
    expect(text).toMatch(/A switch applies only to rewards earned after\s+it/);
  });

  it("🔴 inside the native app it names no dollar figure", () => {
    native.on = true;
    const { container } = render(<AffiliateTermsPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$/);
    expect(text).toMatch(/sign-up credit of the amount shown on our website/);
  });
});
