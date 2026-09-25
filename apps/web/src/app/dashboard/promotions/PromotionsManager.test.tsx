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
const toast = vi.hoisted(() => vi.fn());
const native = vi.hoisted(() => ({ inApp: false }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => native.inApp }));
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

const dryRunOk = {
  summary: { considered: 4, eligible: 4, sent: 4, failed: 0, skippedCap: 0, dryRun: true },
};

/** Preview succeeds, then the real send answers with `sendResult`. */
async function previewThenSend(sendResult: Awaited<ReturnType<typeof blastPromoAction>>) {
  vi.mocked(blastPromoAction).mockResolvedValueOnce(dryRunOk).mockResolvedValueOnce(sendResult);
  openBlast();
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  return String(toast.mock.calls[0]![0]);
}

/**
 * The API's 402 says "Upgrade your plan..." - and this page runs inside the
 * iOS app, where upgrade steering is a Guideline 3.1.1 rejection.
 */
describe("promo blast refusals", () => {
  beforeEach(() => {
    vi.mocked(blastPromoAction).mockClear();
    toast.mockClear();
    native.inApp = false;
  });

  const premium = {
    summary: null,
    error: "premium_required",
    message: "Texting clients is part of Premium. Upgrade your plan to send rebooking nudges and promo blasts.",
  };

  it("a Premium refusal never says upgrade inside the app", async () => {
    native.inApp = true;
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    const text = await previewThenSend(premium);
    expect(text).toMatch(/Premium/);
    expect(text).not.toMatch(/upgrade/i);
    // ...and it names the way that does work on his plan.
    expect(text).toMatch(/Email or notify/);
  });

  it("on the web the same refusal points at Billing", async () => {
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    expect(await previewThenSend(premium)).toMatch(/Billing page/);
  });

  it("an unknown refusal shows our words, not whatever the API said", async () => {
    native.inApp = true;
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    const text = await previewThenSend({ summary: null, error: "surprise", message: "Upgrade now!" });
    expect(text).toBe("Send failed");
  });

  it("texting off explains itself instead of a bare 'Could not preview'", async () => {
    vi.mocked(blastPromoAction).mockResolvedValueOnce({
      summary: null,
      error: "texting_off",
      reason: "Texting is turned off right now, so nothing was sent.",
    });
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    openBlast();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const text = String(toast.mock.calls[0]![0]);
    expect(text).toMatch(/Texting is turned off right now/);
    expect(text).toMatch(/Email or notify/);
  });
});

/**
 * A preview is the only confirmation an SMS blast gets, so the number shown
 * must be the number of the audience Send will text.
 */
describe("promo blast preview belongs to its question", () => {
  beforeEach(() => {
    vi.mocked(blastPromoAction).mockClear();
    toast.mockClear();
  });

  it("drops a preview that lands after the tiers changed", async () => {
    let answerGold!: (v: Awaited<ReturnType<typeof blastPromoAction>>) => void;
    vi.mocked(blastPromoAction).mockImplementationOnce(
      () => new Promise((resolve) => (answerGold = resolve)),
    );
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    openBlast();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tiers" } });
    fireEvent.click(screen.getByRole("button", { name: "Gold" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(blastPromoAction).toHaveBeenCalledWith("p1", "tiers", true, ["GOLD"]));

    // Silver is added while Gold's count is still on its way.
    fireEvent.click(screen.getByRole("button", { name: "Silver" }));
    answerGold({ summary: { considered: 3, eligible: 3, sent: 3, failed: 0, skippedCap: 0, dryRun: true } });

    await waitFor(() => expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy());
    expect(screen.queryByText(/Would text/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("sends exactly the audience that was counted", async () => {
    render(<PromotionsManager promotions={[promo]} rewardsEnabled />);
    openBlast();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tiers" } });
    fireEvent.click(screen.getByRole("button", { name: "Silver" }));
    fireEvent.click(screen.getByRole("button", { name: "Gold" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(/eligible Gold and Silver members/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(blastPromoAction).toHaveBeenLastCalledWith("p1", "tiers", false, ["SILVER", "GOLD"]),
    );
  });
});

/**
 * Texting is Premium and can be switched off platform-wide. The same promo,
 * to the same tiers, by app notification or email works on every plan - and
 * the row says so instead of leaving the barber at a refusal.
 */
describe("promo to the composer", () => {
  it("links the promo, and the tiers picked, to Email or notify", () => {
    render(<PromotionsManager promotions={[promo]} rewardsEnabled premiumLocked />);
    const link = () => screen.getByRole("link", { name: "Email or notify" }).getAttribute("href");
    expect(link()).toBe("/dashboard/clients?promo=p1");
    openBlast();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tiers" } });
    fireEvent.click(screen.getByRole("button", { name: "Gold" }));
    expect(link()).toBe("/dashboard/clients?promo=p1&tiers=GOLD");
  });

  it("says the promo itself is still public when only the text is aimed", () => {
    render(<PromotionsManager promotions={[{ ...promo, kind: "EXTRA_PUNCHES", extraPunches: 2 }]} rewardsEnabled />);
    openBlast();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tiers" } });
    expect(screen.getByText(/Only the text goes to these tiers/)).toBeTruthy();
    expect(screen.getByText(/extra punches count on everyone's visits/)).toBeTruthy();
  });
});
