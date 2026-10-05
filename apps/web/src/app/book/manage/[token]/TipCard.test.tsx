import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TipView } from "./page";

/**
 * LEAVE A TIP on the client's appointment page.
 *
 *  - nothing is picked for them, and nothing moves until they pay in the
 *    card form;
 *  - the amount sent is exactly what they chose, in cents;
 *  - a typed amount outside $1 to $200 is refused with a reason, before any
 *    call;
 *  - "thank you" appears only once the SERVER says the tip is paid;
 *  - every failure before the card form truthfully says nothing was charged.
 */

vi.mock("../../[slug]/PaymentStep", () => ({
  PaymentStep: (p: { onPaid: () => void; amountLabel: string | null }) => (
    <button type="button" onClick={p.onPaid}>
      {`pay ${p.amountLabel}`}
    </button>
  ),
}));
const startTipAction = vi.fn();
const tipStatusAction = vi.fn();
vi.mock("./actions", () => ({
  startTipAction: (...a: unknown[]) => startTipAction(...a),
  tipStatusAction: (...a: unknown[]) => tipStatusAction(...a),
}));

const { TipCard } = await import("./TipCard");

const open = (over: Partial<Extract<TipView, { state: "open" }>> = {}): TipView => ({
  state: "open",
  presets: [
    { percent: 15, cents: 600 },
    { percent: 20, cents: 800 },
    { percent: 25, cents: 1000 },
  ],
  minCents: 100,
  maxCents: 20000,
  closesAt: "2026-10-12T17:00:00.000Z",
  ...over,
});

const mount = (tip: TipView = open()) =>
  render(<TipCard token="tok_1" tip={tip} shopName="Sample Shop" focus={false} />);

beforeEach(() => {
  cleanup();
  startTipAction.mockReset();
  tipStatusAction.mockReset();
});

describe("leaving a tip", () => {
  it("🔴 shows the presets with their amounts, picks nothing, and moves nothing until they pay", async () => {
    startTipAction.mockResolvedValue({ ok: true, clientSecret: "pi_1_secret", amountCents: 800 });
    tipStatusAction.mockResolvedValue({ ok: true, tip: { state: "paid", amountCents: 800 } });
    mount();
    expect(screen.getByRole("heading", { name: "Leave a tip for Sample Shop" })).toBeTruthy();
    for (const label of ["15% · $6.00", "20% · $8.00", "25% · $10.00"]) {
      const chip = screen.getByRole("button", { name: label });
      expect(chip.getAttribute("aria-pressed")).toBe("false");
    }
    // Nothing chosen: nothing to continue with.
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "20% · $8.00" }));
    expect(screen.getByRole("button", { name: "20% · $8.00" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Continue · $8.00" }));
    expect(startTipAction).toHaveBeenCalledWith("tok_1", 800);

    // The card form, for exactly that amount. Nothing paid yet.
    const pay = await screen.findByRole("button", { name: "pay $8.00" });
    expect(tipStatusAction).not.toHaveBeenCalled();
    fireEvent.click(pay);
    // The card form said yes; the server has not yet. No thank-you until it does.
    expect((await screen.findByRole("status")).textContent).toBe("Received. Confirming your tip…");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Thank you! Your $8.00 tip went to Sample Shop.",
      ),
    );
    expect(tipStatusAction).toHaveBeenCalledWith("tok_1");
  });

  it("their own amount, to the cent", async () => {
    startTipAction.mockResolvedValue({ ok: true, clientSecret: "pi_2_secret", amountCents: 1250 });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Other amount" }));
    fireEvent.change(screen.getByLabelText("Tip amount ($1 to $200)"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue · $12.50" }));
    expect(startTipAction).toHaveBeenCalledWith("tok_1", 1250);
    expect(await screen.findByRole("button", { name: "pay $12.50" })).toBeTruthy();
  });

  it("an amount outside $1 to $200 is refused with a reason, and nothing is asked of the server", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Other amount" }));
    for (const typed of ["0.50", "250", "abc", ""]) {
      fireEvent.change(screen.getByLabelText("Tip amount ($1 to $200)"), { target: { value: typed } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByRole("alert").textContent, typed).toBe("Enter an amount from $1 to $200.");
    }
    expect(startTipAction).not.toHaveBeenCalled();
  });

  it("an unpriced visit opens straight on their own amount", () => {
    mount(open({ presets: [] }));
    expect(screen.getByLabelText("Tip amount ($1 to $200)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /%/ })).toBeNull();
  });

  it("they can change the amount after the card form opened", async () => {
    startTipAction.mockResolvedValue({ ok: true, clientSecret: "pi_3_secret", amountCents: 600 });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "15% · $6.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue · $6.00" }));
    await screen.findByRole("button", { name: "pay $6.00" });
    fireEvent.click(screen.getByRole("button", { name: "Change amount" }));
    expect(screen.getByRole("button", { name: "25% · $10.00" })).toBeTruthy();
  });

  it("🔴 a failure before the card form says nothing was charged - because nothing can have been", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "20% · $8.00" }));
    for (const [answer, said] of [
      [{ ok: false, error: "tip_closed" }, "Tipping has closed for this visit."],
      [{ ok: false, error: "tip_in_progress" }, "Your tip is still being confirmed. Try again in a moment."],
      [{ ok: false, error: "payments_unavailable" }, "Couldn't get your payment ready. Nothing was charged - try again."],
      [{ ok: false, error: "unconfirmed" }, "Couldn't get your payment ready. Nothing was charged - try again."],
    ] as const) {
      startTipAction.mockResolvedValueOnce(answer);
      fireEvent.click(screen.getByRole("button", { name: "Continue · $8.00" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(said));
    }
    // No signal at all: the action itself throws.
    startTipAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Continue · $8.00" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Couldn't get your payment ready. Nothing was charged - try again.",
      ),
    );
  });

  it("already tipped elsewhere (another tab): shows the tip that was paid", async () => {
    startTipAction.mockResolvedValue({ ok: false, error: "already_tipped" });
    tipStatusAction.mockResolvedValue({ ok: true, tip: { state: "paid", amountCents: 1000 } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "20% · $8.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue · $8.00" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Thank you! Your $10.00 tip went to Sample Shop.",
    );
  });

  it("paid, refunded and processing each say what is true", () => {
    mount({ state: "paid", amountCents: 800 });
    expect(screen.getByText("Thank you! Your $8.00 tip went to Sample Shop.")).toBeTruthy();
    cleanup();
    mount({ state: "refunded", amountCents: 800 });
    expect(screen.getByText("Your $8.00 tip was refunded to you.")).toBeTruthy();
    cleanup();
    mount({ state: "processing", amountCents: 800 });
    expect(screen.getByText(/Your \$8\.00 tip is processing/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("if confirming takes too long, it says it went through and to check back - never 'failed'", async () => {
    vi.useFakeTimers();
    try {
      startTipAction.mockResolvedValue({ ok: true, clientSecret: "pi_4_secret", amountCents: 800 });
      tipStatusAction.mockResolvedValue({ ok: true, tip: open() });
      mount();
      fireEvent.click(screen.getByRole("button", { name: "20% · $8.00" }));
      fireEvent.click(screen.getByRole("button", { name: "Continue · $8.00" }));
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      fireEvent.click(screen.getByRole("button", { name: "pay $8.00" }));
      for (let i = 0; i < 25; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500);
        });
      }
      expect(screen.getByRole("status").textContent).toMatch(/That went through/);
      expect(screen.queryByText(/failed/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
