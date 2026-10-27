import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  AFFILIATE_POLICY,
  AFFILIATE_TERMS_VERSION,
  bpsToPercent,
  formatUsdCents,
} from "@chairback/config/affiliateProgram";
import AffiliateTermsPage from "./page";
import AffiliateTermsV1Page from "./v1/page";

/**
 * The commission terms (v2). Every number on the page is read from
 * AFFILIATE_POLICY.commission, the retired "Credits are never cash" line is
 * gone, earlier month-off credits are honoured with a link to the v1 text,
 * and inside the iOS app no rate or dollar renders (App Store 3.1.1).
 */

afterEach(() => {
  delete (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

const C = AFFILIATE_POLICY.commission;

describe("affiliate terms (current version)", () => {
  it("states the commission rates, window, hold and payout minimum from the policy", () => {
    const { container } = render(<AffiliateTermsPage />);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain(`version ${AFFILIATE_TERMS_VERSION}`);
    expect(screen.getByTestId("terms-rates").textContent?.replace(/\s+/g, " ")).toContain(
      `${bpsToPercent(C.cashBps)}% of what the business actually paid for its base plan if you take it as cash, or ${bpsToPercent(C.creditBps)}%`,
    );
    expect(text).toContain(`first ${C.months} months`);
    expect(text).toContain(`held for ${C.holdDays} days`);
    expect(screen.getByTestId("terms-minimum").textContent).toContain(
      formatUsdCents(C.minimumCashPayoutCents),
    );
    for (const heading of ["What you earn", "Payouts", "Reversals", "Earlier month-off credits"]) {
      expect(screen.getByRole("heading", { name: new RegExp(heading) })).toBeTruthy();
    }
  });

  it("🔴 'Credits are never cash' and the month-off reward are gone from the current terms", () => {
    const { container } = render(<AffiliateTermsPage />);
    expect(container.textContent).not.toMatch(/never cash/i);
    expect(container.textContent).not.toMatch(/Earning a month off/i);
    expect(screen.getByRole("link", { name: "version v1" }).getAttribute("href")).toBe(
      "/affiliate-terms/v1",
    );
  });

  it("keeps attribution, disclosure, suspension and changes", () => {
    render(<AffiliateTermsPage />);
    for (const heading of ["Your link, and who counts as yours", "Telling people you are an affiliate", "Suspension", "Changes"]) {
      expect(screen.getByRole("heading", { name: new RegExp(heading) })).toBeTruthy();
    }
  });

  it("🔴 inside the iOS app: no percentage and no dollar, and it says where to read them", async () => {
    (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: () => {} };
    const { container } = render(<AffiliateTermsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("terms-rates").textContent).toMatch(/getchairback\.com\/affiliate-terms/),
    );
    expect(container.textContent).not.toMatch(/\d\s?%/);
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });
});

describe("affiliate terms v1 (kept as written)", () => {
  it("is marked as an earlier version and points at the current terms", () => {
    render(<AffiliateTermsV1Page />);
    expect(screen.getByText(/This is an earlier version of these terms/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "/affiliate-terms" }).getAttribute("href")).toBe("/affiliate-terms");
  });
});
