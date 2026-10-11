import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * REDEEM WHEN THE ANSWER IS LOST.
 *
 * A Redeem whose answer never came back (no signal, a gateway 502 after the
 * API had written it), tapped again, redeemed a SECOND reward off a client
 * with punches for two. The tap now carries a requestId that is kept across an
 * unknown outcome, so the retry is the same redemption and the API answers it
 * from the first. A definite answer (2xx or 4xx) settles it; the next Redeem
 * is new.
 */
const redeemAction = vi.hoisted(() => vi.fn());
vi.mock("../../actions", () => ({
  logVisitAction: vi.fn(),
  bonusPunchAction: vi.fn(),
  redeemAction,
  rotateRewardsLinkAction: vi.fn(),
  toggleOptOutAction: vi.fn(),
}));
vi.mock("../../promotions/actions", () => ({ recordPromoUseAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const { ClientActions } = await import("./ClientActions");

const sentId = (n: number) => (redeemAction.mock.calls[n]![2] as { requestId: string }).requestId;

function renderWithReward() {
  render(
    <ClientActions
      clientId="c1"
      rewardsUrl="https://x.test/r/t"
      optedOut={false}
      rewards={[{ id: "r1", name: "Free Cut", emoji: null, punchCost: 5, cardTypeId: null, affordable: true }]}
      cards={[{ id: null, name: "Punch card", active: true } as never]}
      promotions={[]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Redeem reward" }));
}
const rewardButton = () => screen.getByRole("button", { name: /Free Cut/ });

beforeEach(() => {
  redeemAction.mockReset();
  toast.mockReset();
});

describe("Redeem and a lost answer", () => {
  it("🔴 a thrown action keeps the page and the tap: the retry is the same redemption", async () => {
    renderWithReward();
    redeemAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(rewardButton());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "No answer from ChairBack - tap the reward again. It won't redeem twice.",
        "error",
      ),
    );

    redeemAction.mockResolvedValueOnce({ ok: true, status: 200, replayed: true });
    fireEvent.click(rewardButton()); // the picker stayed open
    await waitFor(() => expect(redeemAction).toHaveBeenCalledTimes(2));
    expect(sentId(0)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(sentId(1)).toBe(sentId(0));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Free Cut was already redeemed - nothing taken twice", "success"),
    );
  });

  it("🔴 a gateway 502 is unknown, not refused: the retry carries the same id", async () => {
    renderWithReward();
    redeemAction.mockResolvedValueOnce({ ok: false, status: 502 });
    fireEvent.click(rewardButton());
    await waitFor(() => expect(redeemAction).toHaveBeenCalledTimes(1));
    redeemAction.mockResolvedValueOnce({ ok: true, status: 200 });
    fireEvent.click(rewardButton());
    await waitFor(() => expect(redeemAction).toHaveBeenCalledTimes(2));
    expect(sentId(1)).toBe(sentId(0));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Free Cut redeemed", "success"));
  });

  it("a definite refusal settles the tap: the next Redeem is a new one", async () => {
    renderWithReward();
    redeemAction.mockResolvedValueOnce({ ok: false, status: 400, error: "insufficient_punches" });
    fireEvent.click(rewardButton());
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Could not redeem", "error"));

    fireEvent.click(screen.getByRole("button", { name: "Redeem reward" }));
    redeemAction.mockResolvedValueOnce({ ok: true, status: 200 });
    fireEvent.click(rewardButton());
    await waitFor(() => expect(redeemAction).toHaveBeenCalledTimes(2));
    expect(sentId(1)).not.toBe(sentId(0));
  });
});
