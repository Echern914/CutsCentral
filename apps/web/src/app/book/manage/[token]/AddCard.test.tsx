import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * ADD A CARD on a booking that already stands (a card shop that books without
 * a card, and the client skipped it at booking). Never a condition of the
 * booking, and it says so; a card saved here is checked with Stripe by the
 * server before anything is told it was filed.
 */

vi.mock("../../[slug]/PaymentStep", () => ({
  PaymentStep: (p: { onPaid: () => void; onSkip?: () => void }) => (
    <div>
      <button type="button" onClick={p.onPaid}>
        stub save card
      </button>
      {p.onSkip && (
        <button type="button" onClick={p.onSkip}>
          stub not now
        </button>
      )}
    </div>
  ),
}));
const cardSavedAction = vi.fn();
vi.mock("../../[slug]/actions", () => ({
  cardSavedAction: (...a: unknown[]) => cardSavedAction(...a),
}));

const { AddCard } = await import("./AddCard");

const onSaved = vi.fn();
const mount = (serviceChargeConsent = false) =>
  render(
    <AddCard
      token="tok_1"
      offer={{ clientSecret: "seti_1_secret", serviceChargeConsent }}
      shopName="Sample Studio"
      onSaved={onSaved}
    />,
  );

beforeEach(() => {
  cleanup();
  cardSavedAction.mockReset();
  onSaved.mockReset();
});

describe("adding a card to a booking that stands", () => {
  it("🔴 says they're booked either way, and opens the form only when asked", () => {
    mount();
    expect(screen.getByText(/You’re booked either way\./)).toBeTruthy();
    expect(screen.getByText(/you pay at your visit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "stub save card" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a card" }));
    expect(screen.getByRole("button", { name: "stub save card" })).toBeTruthy();
    // Changing their mind closes it.
    fireEvent.click(screen.getByRole("button", { name: "stub not now" }));
    expect(screen.queryByRole("button", { name: "stub save card" })).toBeNull();
  });

  it("repeats what they agreed to, when they agreed to the service charge", () => {
    mount(true);
    expect(screen.getByText(/as you agreed, it can be charged for your service/)).toBeTruthy();
  });

  it("a saved card is checked by the server, then said and the page refreshed", async () => {
    cardSavedAction.mockResolvedValue({ ok: true, status: "BOOKED" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a card" }));
    fireEvent.click(screen.getByRole("button", { name: "stub save card" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Card saved\./);
    expect(cardSavedAction).toHaveBeenCalledWith("tok_1");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
