import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import { DEFAULT_TIER_THRESHOLDS } from "@chairback/config/constants";
import { rulesFromThresholds, type TierRules } from "@chairback/config/tierRules";

const save = vi.hoisted(() =>
  vi.fn(async (_perks: unknown, _rules?: unknown) => ({ saved: true, moved: 3 }) as { saved?: boolean; moved?: number; error?: string }),
);
const previewAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ saveTierPerksAction: save, previewTierRulesAction: previewAction }));
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

beforeEach(() => {
  save.mockClear();
  previewAction.mockReset();
});

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
      "Silver needs something to earn it - visits, money spent, or an average ticket.",
    );
  });
});

/**
 * AVERAGE TICKET - the third measure - and the PREVIEW before saving: how many
 * clients hold each tier now against how many would under the draft.
 */
describe("TierPerks - average ticket", () => {
  const avgBox = (n: number) => screen.getAllByText("Average ticket")[n]!;

  it("builds 'Gold: an average ticket of $70 in the last 3 months' and saves exactly that", async () => {
    render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    // Gold: average only.
    fireEvent.click(avgBox(2));
    fireEvent.change(screen.getByLabelText("Average ticket in dollars for Gold"), { target: { value: "70" } });
    fireEvent.change(screen.getByLabelText("How far back Gold averages tickets"), { target: { value: "90" } });
    fireEvent.click(screen.getAllByText("Visits")[2]!);
    expect(screen.getByText("Gold: an average ticket of $70 in the last 3 months")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save tiers" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![1] as TierRules;
    expect(sent.GOLD).toEqual({
      visits: null,
      spend: null,
      avgTicket: { minCents: 7_000, windowDays: 90 },
      match: "all",
    });
    // 🔴 A tier without the measure carries no avgTicket key at all.
    expect("avgTicket" in sent.SILVER).toBe(false);
  });

  it("opens on a stored average, and three measures say 'Needs all three' / 'Any one'", () => {
    const rules: TierRules = {
      ...DEFAULTS,
      GOLD: {
        visits: { min: 12, windowDays: 0 },
        spend: { minCents: 30_000, windowDays: 0 },
        avgTicket: { minCents: 6_000, windowDays: 365 },
        match: "all",
      },
    };
    render(<TierPerks initial={{}} initialRules={rules} />);
    expect(screen.getByText("Gold: 12 visits and $300 spent and an average ticket of $60 in the last year")).toBeTruthy();
    expect((screen.getByLabelText("Average ticket in dollars for Gold") as HTMLInputElement).value).toBe("60");
    fireEvent.click(screen.getByRole("radio", { name: "Any one" }));
    expect(screen.getByText("Gold: 12 visits or $300 spent or an average ticket of $60 in the last year")).toBeTruthy();
    // Back to two measures: the two-way wording comes back.
    fireEvent.click(avgBox(2));
    expect(screen.getByRole("radio", { name: "Either one" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Any one" })).toBeNull();
  });

  it("refuses an average outside the range, naming the tier", () => {
    render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    fireEvent.click(avgBox(1));
    fireEvent.change(screen.getByLabelText("Average ticket in dollars for Silver"), { target: { value: "0.5" } });
    expect(screen.getByRole("alert").textContent).toBe("Silver's average ticket has to be between $1 and $10,000.");
    expect((screen.getByRole("button", { name: "Save tiers" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("🔴 previews the draft before saving - counts now vs after - and saves nothing", async () => {
    previewAction.mockResolvedValue({
      ok: true,
      data: {
        clients: 6,
        current: { NONE: 5, BRONZE: 0, SILVER: 0, GOLD: 1 },
        proposed: { NONE: 1, BRONZE: 2, SILVER: 1, GOLD: 2 },
        wouldMove: 4,
      },
    });
    render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    // Nothing to preview until the rules change.
    expect(screen.queryByRole("button", { name: "Preview before saving" })).toBeNull();

    fireEvent.click(avgBox(2));
    fireEvent.change(screen.getByLabelText("Average ticket in dollars for Gold"), { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview before saving" }));

    const table = await screen.findByRole("table", { name: "Tier preview" });
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("th,td")].map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ["Gold", "1", "2"],
      ["Silver", "0", "1"],
      ["Bronze", "0", "2"],
      ["No tier", "5", "1"],
    ]);
    expect(screen.getByText("4 clients would change tier. Nothing is saved until you press Save tiers.")).toBeTruthy();
    // It asked about exactly the rules on screen, and saved nothing.
    expect(previewAction).toHaveBeenCalledTimes(1);
    expect((previewAction.mock.calls[0]![0] as TierRules).GOLD.avgTicket).toEqual({ minCents: 7_000, windowDays: 0 });
    expect(save).not.toHaveBeenCalled();

    // Edit anything and the preview goes: it no longer describes these rules.
    fireEvent.change(screen.getByLabelText("Average ticket in dollars for Gold"), { target: { value: "75" } });
    expect(screen.queryByRole("table", { name: "Tier preview" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview before saving" })).toBeTruthy();
  });

  it("says so when the preview fails, and still saves nothing", async () => {
    previewAction.mockResolvedValue({ ok: false, error: "Could not preview these tiers. Try again." });
    render(<TierPerks initial={{}} initialRules={DEFAULTS} />);
    fireEvent.click(avgBox(2));
    fireEvent.click(screen.getByRole("button", { name: "Preview before saving" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not preview these tiers. Try again.");
    expect(save).not.toHaveBeenCalled();
  });
});
