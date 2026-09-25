import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PartnerEarnings, type PartnerMe } from "./PartnerEarnings";
import { requestCashoutAction } from "./actions";

vi.mock("./actions", () => ({ requestCashoutAction: vi.fn() }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

/**
 * A partner's earnings card: the unlock progress in words, cashout buttons that
 * only work when the server says the money is there, and no success shown
 * until the server said yes.
 */

function me(over: Partial<PartnerMe["standing"]> = {}, active = true): PartnerMe {
  return {
    name: "Eric C",
    code: "ERIC C",
    active,
    standing: {
      signups: 4,
      qualified: 3,
      unlock: {
        unlocked: false,
        unlockedAt: null,
        window: { opensAt: "2026-08-01T15:00:00.000Z", closesAt: "2026-10-30T15:00:00.000Z", count: 3, open: true },
      },
      earnedCents: 1500,
      lockedCents: 1500,
      availableCents: 0,
      requestedCents: 0,
      paidOutCents: 0,
      ...over,
    },
    cashouts: [],
  };
}

const unlocked = { unlocked: true, unlockedAt: "2026-09-01T00:00:00.000Z", window: null };

beforeEach(() => {
  vi.mocked(requestCashoutAction).mockReset();
  refresh.mockReset();
  toast.mockReset();
});

describe("unlock progress", () => {
  it("says how many of 5, within 90 days, and when the window closes", () => {
    render(<PartnerEarnings me={me()} />);
    const line = screen.getByTestId("unlock-progress");
    expect(line.textContent).toMatch(/3 of 5 within 90 days, window closes Oct 30\./);
    expect(line.textContent).toMatch(/\$15 is waiting for it/);
    expect(screen.getByRole("button", { name: "Cash out $25" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cash out $50" })).toBeDisabled();
  });

  it("a lapsed window says the next referral starts a new one", () => {
    const standing = me().standing;
    render(
      <PartnerEarnings
        me={me({ unlock: { ...standing.unlock, window: { ...standing.unlock.window!, open: false } } })}
      />,
    );
    expect(screen.getByTestId("unlock-progress").textContent).toMatch(
      /closed with 3 of 5\. Your next paying referral starts a new 90-day window/,
    );
  });
});

describe("cashout", () => {
  it("offers only what the available balance covers", () => {
    render(<PartnerEarnings me={me({ unlock: unlocked, lockedCents: 0, availableCents: 3000 })} />);
    expect(screen.getByRole("button", { name: "Cash out $25" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cash out $50" })).toBeDisabled();
  });

  it("a paused partner can't ask", () => {
    render(<PartnerEarnings me={me({ unlock: unlocked, availableCents: 5000 }, false)} />);
    expect(screen.getByRole("button", { name: "Cash out $25" })).toBeDisabled();
  });

  it("🔴 shows success only after the server said yes, then re-reads the page", async () => {
    vi.mocked(requestCashoutAction).mockResolvedValue({ ok: true });
    render(<PartnerEarnings me={me({ unlock: unlocked, availableCents: 5000 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cash out $50" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(requestCashoutAction).toHaveBeenCalledWith(5000);
    expect(toast).toHaveBeenCalledWith("Cashout of $50 requested", "success");
  });

  it("a refusal is explained and nothing claims success", async () => {
    vi.mocked(requestCashoutAction).mockResolvedValue({ ok: false, error: "insufficient_balance" });
    render(<PartnerEarnings me={me({ unlock: unlocked, availableCents: 5000 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cash out $25" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("more than your available balance");
    expect(toast).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
