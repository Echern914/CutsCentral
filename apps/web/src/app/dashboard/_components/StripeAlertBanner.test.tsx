import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StripeAlertBanner, stripeAlertCopy } from "./StripeAlertBanner";

/**
 * The dashboard's Stripe banner. 🔴 A barber charged a no-show fee on an
 * account Stripe was closing and nothing in ChairBack had said so
 * (2026-11-19); the warning lived only in the platform's own Stripe dashboard.
 */
afterEach(cleanup);

describe("StripeAlertBanner", () => {
  it("renders nothing without an alert", () => {
    const { container } = render(<StripeAlertBanner alert={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("🔴 a closed account says so, and the one button goes to Payments", () => {
    render(<StripeAlertBanner alert={{ kind: "closed" }} />);
    expect(screen.getByText("Stripe closed your payments account")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Payments" });
    expect(link.getAttribute("href")).toBe("/dashboard/payments");
  });

  it("held payouts say the money is in the Stripe balance, not lost", () => {
    render(<StripeAlertBanner alert={{ kind: "payouts_paused" }} />);
    expect(screen.getByText("Stripe is holding your payouts")).toBeTruthy();
    expect(screen.getByText(/stays in your Stripe balance/)).toBeTruthy();
  });

  it("details due carries Stripe's deadline, and threatens nothing", () => {
    render(<StripeAlertBanner alert={{ kind: "details_due", dueBy: "2026-11-25T15:00:00.000Z" }} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Stripe needs details from you by");
    expect(banner.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-25T15:00:00.000Z");
    expect(banner.textContent).not.toMatch(/pause/i);
  });

  it("every alert has a title and a body, and promises no texts", () => {
    for (const alert of [
      { kind: "closed" },
      { kind: "payments_paused" },
      { kind: "payouts_paused" },
      { kind: "details_due", dueBy: "2026-11-25T15:00:00.000Z" },
    ] as const) {
      const c = stripeAlertCopy(alert);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
      expect(`${c.title} ${c.body}`).not.toMatch(/\btext\b|\bSMS\b/i);
    }
  });
});
