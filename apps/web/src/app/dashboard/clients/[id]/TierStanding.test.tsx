import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClientTier } from "./TierStanding";

/** The glance at a client's tier: the word, the bar, what is left - and, for an owner or manager, the way to move them up. */

const setClientTierAction = vi.fn();
vi.mock("../../actions", () => ({
  setClientTierAction: (...a: unknown[]) => setClientTierAction(...a),
}));

const { TierStanding } = await import("./TierStanding");

beforeEach(() => {
  setClientTierAction.mockReset();
});

const silver: ClientTier = {
  current: "SILVER",
  label: "Silver",
  color: "#C7CBD1",
  earned: "SILVER",
  earnedLabel: "Silver",
  setByHand: false,
  floor: null,
  fraction: 0.5,
  next: {
    label: "Gold",
    summary: "1 more visit in the last 30 days to reach Gold",
    requirements: [
      { met: false, text: "1 of 2 visits in the last 30 days" },
      { met: true, text: "$350 spent" },
    ],
  },
};

/** Earned Bronze, held Silver because the shop raised them. */
const raisedToSilver: ClientTier = {
  ...silver,
  earned: "BRONZE",
  earnedLabel: "Bronze",
  setByHand: true,
  floor: "SILVER",
  fraction: 0,
  next: { label: "Gold", summary: "4 more visits to Gold", requirements: [{ met: false, text: "1 of 5 visits" }] },
};

const pill = () => document.querySelector('[data-qa="tier-pill"]') as HTMLButtonElement | null;
const options = () =>
  Array.from(document.querySelectorAll('[role="group"][aria-label="Change tier"] button')).map((b) => b.textContent);

describe("TierStanding", () => {
  it("names the tier, fills the bar, and says what is left - requirement by requirement", () => {
    render(<TierStanding tier={silver} storedTier="GOLD" />);
    expect(screen.getByText("Silver member")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("1 more visit in the last 30 days to reach Gold")).toBeTruthy();
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["○To go: 1 of 2 visits in the last 30 days", "✓Done: $350 spent"]);
  });

  it("a client with no tier yet sees what the first one takes", () => {
    render(
      <TierStanding
        tier={{ current: null, label: null, color: null, fraction: 0, next: { label: "Bronze", summary: "1 more visit to Bronze", requirements: [{ met: false, text: "0 of 1 visit" }] } }}
        storedTier={null}
      />,
    );
    expect(screen.getByText("No tier yet")).toBeTruthy();
    expect(screen.getByText("1 more visit to Bronze")).toBeTruthy();
    // One requirement is already the summary; no list repeats it.
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("the top tier has no bar", () => {
    render(<TierStanding tier={{ current: "GOLD", label: "Gold", color: "#D4AF37", fraction: 1, next: null }} storedTier="GOLD" />);
    expect(screen.getByText("Gold member")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("an API from before tier rules still shows the stored badge", () => {
    render(<TierStanding tier={undefined} storedTier="BRONZE" />);
    expect(screen.getByText("Bronze member")).toBeTruthy();
  });
});

describe("moving a client up by hand", () => {
  it("🔴 the pill is a button that offers ONLY the tiers above the one they hold", () => {
    render(<TierStanding tier={silver} storedTier="SILVER" clientId="c1" canChange />);
    expect(options()).toEqual([]); // closed until pressed
    fireEvent.click(pill()!);
    expect(pill()!.getAttribute("aria-expanded")).toBe("true");
    expect(options()).toEqual(["Move up to Gold"]);
  });

  it("no tier yet: every tier is on offer", () => {
    render(
      <TierStanding
        tier={{ current: null, label: null, color: null, earned: null, earnedLabel: null, setByHand: false, floor: null, fraction: 0, next: null }}
        storedTier={null}
        clientId="c1"
        canChange
      />,
    );
    fireEvent.click(pill()!);
    expect(options()).toEqual(["Move up to Bronze", "Move up to Silver", "Move up to Gold"]);
  });

  it("🔴 'Back to automatic' - and the set-by-you line - appear only when the tier was set by hand", () => {
    const { unmount } = render(<TierStanding tier={silver} storedTier="SILVER" clientId="c1" canChange />);
    fireEvent.click(pill()!);
    expect(options().some((t) => t?.startsWith("Back to automatic"))).toBe(false);
    expect(document.querySelector('[data-qa="tier-set-by-hand"]')).toBeNull();
    unmount();

    render(<TierStanding tier={raisedToSilver} storedTier="SILVER" clientId="c1" canChange />);
    expect(document.querySelector('[data-qa="tier-set-by-hand"]')!.textContent).toBe("Set by you - earned Bronze");
    fireEvent.click(pill()!);
    expect(options()).toEqual(["Move up to Gold", "Back to automatic (earned: Bronze)"]);
  });

  it("raised from nothing: says no tier was earned", () => {
    render(
      <TierStanding
        tier={{ ...raisedToSilver, earned: null, earnedLabel: null }}
        storedTier="SILVER"
        clientId="c1"
        canChange
      />,
    );
    expect(document.querySelector('[data-qa="tier-set-by-hand"]')!.textContent).toBe("Set by you - no tier earned yet");
    fireEvent.click(pill()!);
    expect(options()).toContain("Back to automatic (earned: no tier)");
  });

  it("at the top by their own visits there is nothing to offer, so the pill is not a button", () => {
    render(
      <TierStanding
        tier={{ current: "GOLD", label: "Gold", color: "#D4AF37", earned: "GOLD", earnedLabel: "Gold", setByHand: false, floor: null, fraction: 1, next: null }}
        storedTier="GOLD"
        clientId="c1"
        canChange
      />,
    );
    expect(pill()).toBeNull();
    expect(screen.getByText("Gold member")).toBeTruthy();
  });

  it("a seat that cannot change tiers sees the pill, not a button", () => {
    render(<TierStanding tier={silver} storedTier="SILVER" clientId="c1" canChange={false} />);
    expect(pill()).toBeNull();
    expect(screen.getByText("Silver member")).toBeTruthy();
  });

  it("choosing a tier sends it, redraws from the answer, and says so inline", async () => {
    setClientTierAction.mockResolvedValue({ ok: true, status: 200, tier: { ...raisedToSilver, current: "GOLD", label: "Gold", color: "#D4AF37", floor: "GOLD", next: null } });
    render(<TierStanding tier={raisedToSilver} storedTier="SILVER" clientId="c1" canChange />);
    fireEvent.click(pill()!);
    fireEvent.click(screen.getByText("Move up to Gold"));
    await waitFor(() => expect(setClientTierAction).toHaveBeenCalledWith("c1", "GOLD"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Moved up to Gold."));
    expect(screen.getByText("Gold member")).toBeTruthy();
    expect(options()).toEqual([]); // closed once it landed
  });

  it("'Back to automatic' sends null", async () => {
    setClientTierAction.mockResolvedValue({
      ok: true,
      status: 200,
      tier: { ...raisedToSilver, current: "BRONZE", label: "Bronze", color: "#B8772F", setByHand: false, floor: null },
    });
    render(<TierStanding tier={raisedToSilver} storedTier="SILVER" clientId="c1" canChange />);
    fireEvent.click(pill()!);
    fireEvent.click(screen.getByText("Back to automatic (earned: Bronze)"));
    await waitFor(() => expect(setClientTierAction).toHaveBeenCalledWith("c1", null));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Back to automatic: Bronze, as earned."));
    expect(document.querySelector('[data-qa="tier-set-by-hand"]')).toBeNull();
  });

  it("a refusal is explained inline and changes nothing on the page", async () => {
    setClientTierAction.mockResolvedValue({ ok: false, status: 403, error: "forbidden_role" });
    render(<TierStanding tier={silver} storedTier="SILVER" clientId="c1" canChange />);
    fireEvent.click(pill()!);
    fireEvent.click(screen.getByText("Move up to Gold"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Only the owner or a manager can change a client's tier."),
    );
    expect(screen.getByText("Silver member")).toBeTruthy();
    // Still open, so they can see what they pressed.
    expect(options()).toEqual(["Move up to Gold"]);
  });
});
