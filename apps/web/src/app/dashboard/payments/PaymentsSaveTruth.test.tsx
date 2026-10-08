import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { PaymentStatus } from "./actions";

/**
 * Payment settings save what was typed, or say why not:
 *
 *  - 🔴 a $1,500 deposit was quietly saved as $1,000 under "Payment settings
 *    saved", with the box still showing 1500;
 *  - 🔴 after Disconnect Stripe, every save - even a cancellation-policy edit -
 *    was refused with "Finish connecting Stripe before turning payments on";
 *  - a pasted Venmo / Cash App link got a bare "Couldn't save".
 */

const save = vi.hoisted(() => vi.fn());
const savePayDirect = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  disconnectStripeAction: vi.fn(),
  openStripeDashboardAction: vi.fn(),
  savePaymentSettingsAction: save,
  savePayDirectAction: savePayDirect,
  setOnlineTipsAction: vi.fn(async () => ({ ok: true })),
  startStripeConnectHandoffAction: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { PaymentsManager, payHandle } = await import("./PaymentsManager");

function status(over: Partial<PaymentStatus> = {}): PaymentStatus {
  return {
    connectAvailable: true,
    standardAvailable: true,
    connectAccountType: "standard",
    connectAccountLast4: "1234",
    connect: { connected: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    paymentsMode: "deposit",
    depositAmountCents: 2000,
    chargeCardOnFileFees: false,
    tipPolicy: null,
    platformFeeBps: 0,
    cancelWindowHours: 24,
    cancelFeeBps: 5000,
    payDirect: { enabled: true, zelle: null, venmo: null, cashApp: null, note: null },
    ...over,
  };
}

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue({ ok: true });
  savePayDirect.mockReset();
  savePayDirect.mockResolvedValue({ ok: true });
  toast.mockReset();
});

describe("payment settings", () => {
  it("🔴 a deposit over $1,000 is refused, never saved as $1,000", () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    fireEvent.change(screen.getByLabelText("Deposit amount in dollars"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment settings" }));
    expect(save).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("The deposit must be $1 to $1,000.", "error");
  });

  it("a deposit in range is sent exactly", async () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    fireEvent.change(screen.getByLabelText("Deposit amount in dollars"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save payment settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ paymentsMode: "deposit", depositAmountCents: 1250 });
  });

  it("🔴 with Stripe disconnected, a save leaves the mode out so the rest still saves", async () => {
    render(
      <PaymentsManager
        initial={status({ connect: { connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false } })}
        apiBase="http://api.test"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save payment settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).not.toHaveProperty("paymentsMode");
  });
});

describe("pay-direct handles", () => {
  it("a pasted profile link keeps only the handle", () => {
    expect(payHandle("https://venmo.com/u/Dee-Cuts", /^@/)).toBe("Dee-Cuts");
    expect(payHandle("cash.app/$deecuts", /^\$/)).toBe("deecuts");
    expect(payHandle("@deecuts", /^@/)).toBe("deecuts");
  });

  it("🔴 a handle with a space names the box, and nothing is sent", () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    fireEvent.change(screen.getByPlaceholderText("@your-handle"), { target: { value: "dee cuts" } });
    fireEvent.click(screen.getByRole("button", { name: /Save pay-direct/i }));
    expect(savePayDirect).not.toHaveBeenCalled();
    expect(toast.mock.calls[0]![0]).toMatch(/^Venmo:/);
  });
});
