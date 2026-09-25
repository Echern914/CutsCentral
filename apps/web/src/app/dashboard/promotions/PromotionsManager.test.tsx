import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PromotionsManager } from "./PromotionsManager";
import { blastPromoAction } from "./actions";
import type { Promo } from "./page";

vi.mock("./actions", () => ({
  blastPromoAction: vi.fn(async () => ({
    summary: { considered: 4, eligible: 4, sent: 4, failed: 0, skippedCap: 0, dryRun: true },
  })),
  createPromoAction: vi.fn(),
  deletePromoAction: vi.fn(),
  updatePromoAction: vi.fn(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));
vi.mock("@/components/VocabProvider", () => ({
  cap: (s: string) => s,
  useVocab: () => new Proxy({}, { get: (_t, key) => String(key) }),
}));

const promo: Promo = {
  id: "p1",
  kind: "PERCENT_OFF",
  title: "Spring Special",
  description: null,
  code: null,
  percentOff: 20,
  amountOff: null,
  extraPunches: null,
  startsAt: "2026-09-01T00:00:00Z",
  endsAt: null,
  active: true,
  status: "live",
  timesUsed: 0,
  textsSent: 0,
  rebookings: 0,
};

function openBlast() {
  fireEvent.click(screen.getByRole("button", { name: "Text clients" }));
}

/**
 * Drick: "For promotions should have option to send to only gold or whatever
 * tier member". The promo text-out can be aimed at loyalty tiers - and "only
 * these tiers" with none picked is never sent as "everyone".
 */
describe("promo blast audience", () => {
  beforeEach(() => vi.mocked(blastPromoAction).mockClear());

  it("previews only the tiers picked, and names them", async () => {
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    openBlast();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tiers" } });

    // Nothing picked yet: no preview to ask for.
    const previewBtn = screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);
    expect(screen.getByText("Pick at least one tier.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Gold" }));
    expect(previewBtn.disabled).toBe(false);
    fireEvent.click(previewBtn);

    await waitFor(() =>
      expect(blastPromoAction).toHaveBeenCalledWith("p1", "tiers", true, ["GOLD"]),
    );
    expect(await screen.findByText(/eligible Gold members/)).toBeTruthy();
  });

  it("offers no tier audience while rewards are off", () => {
    render(<PromotionsManager promotions={[promo]} rewardsEnabled={false} />);
    openBlast();
    const values = Array.from(screen.getByRole("combobox").querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual(["all", "atRisk"]);
  });

  it("everyone stays the default and sends no tiers", async () => {
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    openBlast();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("all");
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(blastPromoAction).toHaveBeenCalledWith("p1", "all", true, []));
  });
});
