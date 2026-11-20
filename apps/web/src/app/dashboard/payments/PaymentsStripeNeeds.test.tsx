import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { PaymentStatus, StripeHealth } from "./actions";

/**
 * WHAT STRIPE STILL WANTS, on the Payments page. 🔴 Before this the page
 * showed two checkmarks while "photo ID overdue, account will be closed"
 * lived only in the platform's own Stripe dashboard (2026-11-19).
 */

const finish = vi.hoisted(() => vi.fn(async () => ({ ok: true, url: "https://connect.stripe.test/setup" })));
const dashboard = vi.hoisted(() => vi.fn(async () => ({ ok: true, url: "https://dashboard.stripe.test/" })));
vi.mock("./actions", () => ({
  disconnectStripeAction: vi.fn(),
  finishStripeSetupAction: finish,
  openStripeDashboardAction: dashboard,
  savePaymentSettingsAction: vi.fn(),
  savePayDirectAction: vi.fn(),
  setOnlineTipsAction: vi.fn(),
  startStripeConnectHandoffAction: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { PaymentsManager } = await import("./PaymentsManager");

const HEALTHY: StripeHealth = {
  needs: [],
  overdue: false,
  dueBy: null,
  closed: false,
  underReview: false,
  disabledReason: null,
};

function status(
  health: Partial<StripeHealth> | undefined,
  over: Partial<PaymentStatus["connect"]> = {},
  type: "express" | "standard" = "express",
): PaymentStatus {
  return {
    connectAvailable: true,
    standardAvailable: true,
    connectAccountType: type,
    connectAccountLast4: "1234",
    connect: {
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      ...(health === undefined ? {} : { health: { ...HEALTHY, ...health } }),
      ...over,
    },
    paymentsMode: "off",
    depositAmountCents: null,
    chargeCardOnFileFees: false,
    tipPolicy: null,
    platformFeeBps: 0,
    cancelWindowHours: 24,
    cancelFeeBps: 5000,
    payDirect: { enabled: false, zelle: null, venmo: null, cashApp: null, note: null },
  } as PaymentStatus;
}

function show(initial: PaymentStatus) {
  cleanup();
  render(<PaymentsManager initial={initial} apiBase="http://api.test" />);
}

const originalLocation = window.location;
beforeEach(() => {
  finish.mockClear();
  dashboard.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, href: "http://web.test/dashboard/payments", search: "", pathname: "/dashboard/payments" },
  });
});

describe("what Stripe needs", () => {
  it("a healthy account shows no list", () => {
    show(status({}));
    expect(document.querySelector("[data-qa='stripe-needs']")).toBeNull();
  });

  it("🔴 lists each item in plain words, says payouts are held, and Finish opens Stripe's own form", async () => {
    show(
      status(
        { needs: ["A photo of your ID", "Your bank account for payouts"], dueBy: "2026-11-25T15:00:00.000Z" },
        { payoutsEnabled: false },
      ),
    );
    const box = document.querySelector("[data-qa='stripe-needs']")!;
    expect(box.textContent).toContain("Stripe needs:");
    expect(screen.getByText("A photo of your ID")).toBeTruthy();
    expect(screen.getByText("Your bank account for payouts")).toBeTruthy();
    expect(box.textContent).toContain("Due by");
    expect(box.textContent).toContain("your payouts are on hold");

    fireEvent.click(screen.getByRole("button", { name: "Finish in Stripe" }));
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(dashboard).not.toHaveBeenCalled();
    await waitFor(() => expect(window.location.href).toBe("https://connect.stripe.test/setup"));
  });

  it("a linked Standard account's Finish opens the barber's own Stripe dashboard", async () => {
    show(status({ needs: ["Your date of birth"] }, {}, "standard"));
    fireEvent.click(screen.getByRole("button", { name: "Finish in Stripe" }));
    await waitFor(() => expect(dashboard).toHaveBeenCalledTimes(1));
    expect(finish).not.toHaveBeenCalled();
  });

  it("🔴 overdue while cards and payouts run: says so, and never threatens a pause", () => {
    show(status({ needs: ["A photo of your ID"], overdue: true }));
    const box = document.querySelector("[data-qa='stripe-needs']")!;
    expect(box.getAttribute("data-state")).toBe("overdue");
    expect(box.textContent).toContain("past its deadline");
    expect(box.textContent).toContain("still running");
    expect(box.textContent).not.toMatch(/may pause/i);
  });

  it("🔴 a closed account offers no Finish button: nothing sent reopens it", () => {
    show(status({ closed: true, needs: ["A photo of your ID"] }, { chargesEnabled: false, payoutsEnabled: false }));
    const box = document.querySelector("[data-qa='stripe-needs']")!;
    expect(box.getAttribute("data-state")).toBe("closed");
    expect(screen.getByText("Stripe closed this account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish in Stripe" })).toBeNull();
  });

  it("🔴 a PAUSED account that took money is never called 'never finished, holds no money'", () => {
    show(status({ needs: ["A photo of your ID"], overdue: true }, { chargesEnabled: false, payoutsEnabled: false }));
    expect(screen.queryByText(/It holds no money/)).toBeNull();
    expect(screen.getByRole("button", { name: "Finish in Stripe" })).toBeTruthy();
    expect(document.querySelector("[data-qa='stripe-needs']")!.textContent).toContain("clients can't pay by card");
  });

  it("an Express setup whose details were never sent is still the stuck state", () => {
    show(status({ needs: ["Your legal name"] }, { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false }));
    expect(screen.getByText(/It holds no money/)).toBeTruthy();
  });

  it("something under review says there is nothing to do", () => {
    show(status({ underReview: true }));
    expect(screen.getByText(/Stripe is checking what you sent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish in Stripe" })).toBeNull();
  });

  it("an older API with no health keeps the old sentence", () => {
    show(status(undefined, { chargesEnabled: false }, "standard"));
    expect(screen.getByText(/Stripe still needs a few details/)).toBeTruthy();
  });
});
