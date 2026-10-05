import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { PaymentStatus } from "./actions";

const save = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ ok: true })));
vi.mock("./actions", () => ({
  disconnectStripeAction: vi.fn(),
  openStripeDashboardAction: vi.fn(),
  savePaymentSettingsAction: save,
  savePayDirectAction: vi.fn(),
  startStripeConnectHandoffAction: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { PaymentsManager } = await import("./PaymentsManager");

/**
 * The settings side of card on file. Two things the UI must keep apart, because
 * the mode alone blurs them: KEEPING a card (the mode) and being allowed to
 * CHARGE it (the switch). "Card on file doesn't get charged unless the barber is
 * set and it's on them" - so the switch is separate, off by default, and the
 * save sends both.
 */

function status(over: Partial<PaymentStatus> = {}): PaymentStatus {
  return {
    connectAvailable: true,
    standardAvailable: true,
    connectAccountType: "standard",
    connectAccountLast4: "1234",
    connect: { connected: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    paymentsMode: "off",
    depositAmountCents: null,
    chargeCardOnFileFees: false,
    tipPolicy: null,
    platformFeeBps: 0,
    cancelWindowHours: 24,
    cancelFeeBps: 5000,
    payDirect: { enabled: false, zelle: null, venmo: null, cashApp: null, note: null },
    ...over,
  };
}

beforeEach(() => save.mockClear());

describe("card on file in payment settings", () => {
  it("is offered as a fourth way to pay, with the fee switch hidden until chosen", () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    const btn = screen.getByRole("button", { name: /Card on file/ });
    expect(btn).toBeEnabled();
    expect(screen.queryByRole("checkbox", { name: /Charge the card on file/ })).toBeNull();
    fireEvent.click(btn);
    const box = screen.getByRole("checkbox", { name: /Charge the card on file/ });
    // 🔴 OFF by default: choosing the mode is not a decision to charge anyone.
    expect(box).not.toBeChecked();
  });

  it("saves the mode AND the switch together", async () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    fireEvent.click(screen.getByRole("button", { name: /Card on file/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Charge the card on file/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save payment settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      paymentsMode: "card_on_file",
      chargeCardOnFileFees: true,
    });
  });

  it("reads the saved switch back", () => {
    render(
      <PaymentsManager
        initial={status({ paymentsMode: "card_on_file", chargeCardOnFileFees: true })}
        apiBase="http://api.test"
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Charge the card on file/ })).toBeChecked();
  });

  it("cannot be chosen before Stripe can take a charge - a kept card the shop could never charge protects nobody", () => {
    render(
      <PaymentsManager
        initial={status({
          connect: { connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
        })}
        apiBase="http://api.test"
      />,
    );
    const btn = screen.getByRole("button", { name: /Card on file/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Connect Stripe first.");
  });
});

describe("Deposit refunds - next to Tips, deposit mode only", () => {
  it("is only there in deposit mode, and off by default", () => {
    const { unmount } = render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    expect(screen.queryByRole("heading", { name: "Deposit refunds" })).toBeNull();
    unmount();
    render(<PaymentsManager initial={status({ paymentsMode: "deposit", depositAmountCents: 1000 })} apiBase="http://api.test" />);
    expect(screen.getByRole("heading", { name: "Deposit refunds" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Follow my cancellation policy/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Non-refundable/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("🔴 saves the choice with the deposit, and says what it does", async () => {
    render(<PaymentsManager initial={status({ paymentsMode: "deposit", depositAmountCents: 1000 })} apiBase="http://api.test" />);
    fireEvent.click(screen.getByRole("button", { name: /Non-refundable/ }));
    // The deposit hint and the cancellation card now say the deposit is kept.
    expect(screen.getByText(/so does a client's cancellation/)).toBeInTheDocument();
    expect(screen.getByText(/Your deposit is non-refundable, so when a client cancels it is kept/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save payment settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      paymentsMode: "deposit",
      depositAmountCents: 1000,
      depositNonRefundable: true,
    });
  });

  it("reads the saved choice back", () => {
    render(
      <PaymentsManager
        initial={status({ paymentsMode: "deposit", depositAmountCents: 1000, depositNonRefundable: true })}
        apiBase="http://api.test"
      />,
    );
    expect(screen.getByRole("button", { name: /Non-refundable/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("is never sent for another mode", async () => {
    render(<PaymentsManager initial={status({ paymentsMode: "ahead", depositNonRefundable: true })} apiBase="http://api.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Save payment settings" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).not.toHaveProperty("depositNonRefundable");
  });
});
