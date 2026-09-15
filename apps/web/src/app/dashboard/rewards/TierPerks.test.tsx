import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import { DEFAULT_TIER_THRESHOLDS } from "@chairback/config/constants";
import { rulesFromThresholds, type TierRules } from "@chairback/config/tierRules";

const save = vi.hoisted(() =>
  vi.fn(async (_perks: unknown, _rules?: unknown) => ({ saved: true, moved: 3 }) as { saved?: boolean; moved?: number; error?: string }),
);
vi.mock("./actions", () => ({ saveTierPerksAction: save }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { TierPerks } = await import("./TierPerks");

/**
 * The owner's tier editor: visits and/or money per tier, each over its own
 * window. It runs the API's own validator, and sends rules only when the rules
 * changed - saving a perk must never re-stamp every client's badge.
 */

const DEFAULTS = rulesFromThresholds(DEFAULT_TIER_THRESHOLDS);

beforeEach(() => save.mockClear());

describe("TierPerks", () => {
  it("opens on the shop's rules, each tier in a sentence", () => {
    render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    expect(screen.getByText("Bronze: 1 visit")).toBeTruthy();
    expect(screen.getByText("Silver: 6 visits")).toBeTruthy();
    expect(screen.getByText("Gold: 12 visits")).toBeTruthy();
  });

  it("builds 'Gold: 2 visits in the last 30 days and $200 spent' and saves exactly those rules", async () => {
    const { rerender } = render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    fireEvent.change(screen.getByLabelText("Visits needed for Gold"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("How far back Gold counts visits"), { target: { value: "30" } });
    const goldMoney = screen.getAllByText("Money spent")[2]!;
    fireEvent.click(goldMoney);
    fireEvent.change(screen.getByLabelText("Dollars spent for Gold"), { target: { value: "200" } });

    expect(screen.getByText("Gold: 2 visits in the last 30 days and $200 spent")).toBeTruthy();
    // Both requirements on: the owner picks both or either.
    fireEvent.click(screen.getByRole("radio", { name: "Either one" }));
    expect(screen.getByText("Gold: 2 visits in the last 30 days or $200 spent")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Needs both" }));

    fireEvent.click(screen.getByRole("button", { name: "Save tiers" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![1] as TierRules;
    expect(sent.GOLD).toEqual({
      visits: { min: 2, windowDays: 30 },
      spend: { minCents: 20_000, windowDays: 0 },
      match: "all",
    });
    expect(sent.SILVER).toEqual(DEFAULTS.SILVER);
    // router.refresh() brings the saved rules back as props; the note shows once
    // the page and the server agree.
    rerender(<TierPerks initial={{}} initialRules={sent} />);
    expect(await screen.findByText("Saved ✓ - 3 clients moved tier.")).toBeTruthy();
  });

  it("🔴 saving only a perk sends no rules, so no badge is re-stamped", async () => {
    render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. First pick of cancellations"), {
      target: { value: "Free beard trim" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tiers" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![1]).toBeUndefined();
  });

  it("refuses what the API would refuse, naming the tier", () => {
    render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    // Gold at fewer visits than Silver, over the same stretch of time.
    fireEvent.change(screen.getByLabelText("Visits needed for Gold"), { target: { value: "3" } });
    expect(screen.getByRole("alert").textContent).toBe(
      "Gold can't ask for less than the tier below it over the same stretch of time.",
    );
    expect((screen.getByRole("button", { name: "Save tiers" }) as HTMLButtonElement).disabled).toBe(true);

    // A tier with nothing to earn it.
    fireEvent.change(screen.getByLabelText("Visits needed for Gold"), { target: { value: "12" } });
    fireEvent.click(screen.getAllByText("Visits")[1]!);
    expect(screen.getByRole("alert").textContent).toBe(
      "Silver needs something to earn it - visits, money spent, or both.",
    );
  });
});
