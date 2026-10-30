import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { PaymentStatus } from "./actions";

/**
 * Card on file: the no-show / late-cancel fee as a % of the service OR a flat
 * amount (Drick: "$25 for a no-show"). The flat amount is saved exactly as
 * typed or refused with the reason, the box keeps what was typed, and
 * "saved" is said only once the server has said so.
 */

const save = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  disconnectStripeAction: vi.fn(),
  openStripeDashboardAction: vi.fn(),
  savePaymentSettingsAction: save,
  savePayDirectAction: vi.fn(async () => ({ ok: true })),
  setOnlineTipsAction: vi.fn(async () => ({ ok: true })),
  startStripeConnectHandoffAction: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

const { PaymentsManager } = await import("./PaymentsManager");

function status(over: Partial<PaymentStatus> = {}): PaymentStatus {
  return {
    connectAvailable: true,
    standardAvailable: true,
    connectAccountType: "standard",
    connectAccountLast4: "1234",
    connect: { connected: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    paymentsMode: "card_on_file",
    depositAmountCents: null,
    chargeCardOnFileFees: true,
    cardFeeFlatCents: null,
    tipPolicy: null,
    platformFeeBps: 0,
    cancelWindowHours: 24,
    cancelFeeBps: 5000,
    payDirect: { enabled: false, zelle: null, venmo: null, cashApp: null, note: null },
    ...over,
  };
}

const saveButton = () => screen.getByRole("button", { name: "Save payment settings" });

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue({ ok: true });
  toast.mockReset();
});

describe("card on file: a flat no-show fee", () => {
  it("a flat amount is sent in cents, and 'saved' only after the server confirms", async () => {
    let resolve!: (v: { ok: boolean }) => void;
    save.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    fireEvent.click(screen.getByLabelText("Flat amount"));
    fireEvent.change(screen.getByLabelText("Flat fee in dollars"), { target: { value: "25" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      paymentsMode: "card_on_file",
      chargeCardOnFileFees: true,
      cardFeeFlatCents: 2500,
    });
    expect(toast).not.toHaveBeenCalledWith("Payment settings saved", "success");
    resolve({ ok: true });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Payment settings saved", "success"));
  });

  it("🔴 out of range is refused with the reason, and the box keeps what was typed", () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    fireEvent.click(screen.getByLabelText("Flat amount"));
    const box = screen.getByLabelText("Flat fee in dollars") as HTMLInputElement;
    for (const value of ["1500", "0", ""]) {
      fireEvent.change(box, { target: { value } });
      fireEvent.click(saveButton());
      expect(save).not.toHaveBeenCalled();
      expect(toast).toHaveBeenLastCalledWith("The flat fee must be $1 to $1,000.", "error");
      expect(box.value).toBe(value);
    }
  });

  it("a server refusal is not reported as saved, and the typed amount stays", async () => {
    save.mockResolvedValue({ ok: false, error: "invalid_input" });
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    fireEvent.click(screen.getByLabelText("Flat amount"));
    fireEvent.change(screen.getByLabelText("Flat fee in dollars"), { target: { value: "30" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save", "error"));
    expect(toast).not.toHaveBeenCalledWith("Payment settings saved", "success");
    expect((screen.getByLabelText("Flat fee in dollars") as HTMLInputElement).value).toBe("30");
  });

  it("% of the service sends null, which puts the shop back on the percentage", async () => {
    render(<PaymentsManager initial={status({ cardFeeFlatCents: 2500 })} apiBase="http://api.test" />);
    // A saved flat fee reloads as chosen, with its amount.
    expect((screen.getByLabelText("Flat amount") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Flat fee in dollars") as HTMLInputElement).value).toBe("25");
    fireEvent.click(screen.getByLabelText("% of the service"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ cardFeeFlatCents: null, cancelFeeBps: 5000 });
  });

  it("is offered only in card on file mode - prepaid money is kept by the %", async () => {
    render(<PaymentsManager initial={status({ paymentsMode: "deposit", depositAmountCents: 2000 })} apiBase="http://api.test" />);
    expect(screen.queryByLabelText("Flat amount")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).not.toHaveProperty("cardFeeFlatCents");
  });
});

describe("🔴 card on file: ask me before charging a late cancellation (Drick, 2026-10-30)", () => {
  const approval = () => screen.queryByLabelText("Ask me before charging a late cancellation") as HTMLInputElement | null;

  it("is offered only while fees are on, and says nothing is charged until approved", () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    expect(approval()).toBeTruthy();
    expect(screen.getByTestId("fee-needs-approval").textContent).toContain(
      "nothing is charged until you approve it",
    );
    fireEvent.click(screen.getByLabelText("Charge the card on file for no-shows and late cancellations"));
    expect(approval()).toBeNull();
  });

  it("ticking it saves cardFeeNeedsApproval: true", async () => {
    render(<PaymentsManager initial={status()} apiBase="http://api.test" />);
    expect(approval()!.checked).toBe(false);
    fireEvent.click(approval()!);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ chargeCardOnFileFees: true, cardFeeNeedsApproval: true });
  });

  it("a saved yes reloads ticked, and unticking saves false", async () => {
    render(<PaymentsManager initial={status({ cardFeeNeedsApproval: true })} apiBase="http://api.test" />);
    expect(approval()!.checked).toBe(true);
    fireEvent.click(approval()!);
    fireEvent.click(saveButton());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ cardFeeNeedsApproval: false });
  });
});
