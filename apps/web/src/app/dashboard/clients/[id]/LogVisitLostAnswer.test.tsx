import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * LOG VISIT WHEN THE PHONE LOSES THE ANSWER.
 *
 * On a production build, a Log visit whose server-action response never
 * reached the browser logged the visit and then threw the page to "Couldn't
 * load this client". The tap's id went with it, so after Try again the next
 * tap was new and punched the same visit twice. A thrown action is now "no
 * answer": the page stays, says tap again, and the next tap carries the SAME
 * requestId, so the API answers it from the visit it already logged.
 */
const logVisitAction = vi.hoisted(() => vi.fn());
vi.mock("../../actions", () => ({
  logVisitAction,
  bonusPunchAction: vi.fn(),
  redeemAction: vi.fn(),
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

const sentId = (n: number) => (logVisitAction.mock.calls[n]![3] as { requestId: string }).requestId;

beforeEach(() => {
  logVisitAction.mockReset();
  toast.mockReset();
});

describe("Log visit and a lost answer", () => {
  it("🔴 the page stays, says tap again, and the retry is the same tap", async () => {
    render(
      <ClientActions
        clientId="c1"
        rewardsUrl="https://x.test/r/t"
        optedOut={false}
        rewards={[]}
        cards={[{ id: null, name: "Punch card", active: true } as never]}
        promotions={[]}
      />,
    );
    // A server action whose response never arrives rejects in the browser.
    logVisitAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("No answer from ChairBack - tap Log visit again. It won't log twice.", "error"),
    );
    expect(screen.getByRole("button", { name: "Log visit" })).toBeTruthy();

    logVisitAction.mockResolvedValueOnce({ ok: true, status: 200, replayed: true });
    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    await waitFor(() => expect(logVisitAction).toHaveBeenCalledTimes(2));
    expect(sentId(1)).toBe(sentId(0));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Already logged - nothing added", "success"));
  });

  it("🔴 a gateway 502 after the visit was logged: the retry is the same tap, and nothing is added twice", async () => {
    render(
      <ClientActions
        clientId="c1"
        rewardsUrl="https://x.test/r/t"
        optedOut={false}
        rewards={[]}
        cards={[{ id: null, name: "Punch card", active: true } as never]}
        promotions={[]}
      />,
    );
    logVisitAction.mockResolvedValueOnce({ ok: false, status: 502 });
    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("No answer from ChairBack - tap Log visit again. It won't log twice.", "error"),
    );
    logVisitAction.mockResolvedValueOnce({ ok: true, status: 200, replayed: true });
    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    await waitFor(() => expect(logVisitAction).toHaveBeenCalledTimes(2));
    expect(sentId(1)).toBe(sentId(0));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Already logged - nothing added", "success"));

    // Settled: the next Log visit is a new visit.
    logVisitAction.mockResolvedValueOnce({ ok: true, status: 201 });
    fireEvent.click(screen.getByRole("button", { name: "Log visit" }));
    await waitFor(() => expect(logVisitAction).toHaveBeenCalledTimes(3));
    expect(sentId(2)).not.toBe(sentId(1));
  });
});
