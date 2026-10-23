import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { YourStatus } from "./YourStatus";
import { resolveRewardsTheme } from "./theme";
import type { RewardsData } from "./rewards/page";

/**
 * "Your status" on the client's rewards page: every tier, what it takes, what
 * it gets, and where this client stands - straight from the shop's ladder.
 */
const theme = resolveRewardsTheme({ accentColor: null, theme: null, fontKey: null, layoutStyle: null } as Parameters<typeof resolveRewardsTheme>[0]);

const ladder = [
  { tier: "BRONZE", label: "Bronze", color: "#B8772F", takes: "1 visit", perk: null },
  { tier: "SILVER", label: "Silver", color: "#C7CBD1", takes: "2 visits in the last 30 days and $300 spent", perk: "10% off every visit" },
  { tier: "GOLD", label: "Gold", color: "#D4AF37", takes: "12 visits", perk: "Priority booking" },
];
const loyalty = (over: Partial<RewardsData["loyalty"]> = {}): RewardsData["loyalty"] => ({
  tier: "BRONZE",
  label: "Bronze",
  color: "#B8772F",
  visits: 3,
  fraction: 0.4,
  perk: null,
  nextTier: { label: "Silver", visitsAway: 1, perk: "10% off every visit", summary: "1 more visit in the last 30 days to reach Silver" },
  ladder,
  ...over,
});
const rungs = () => screen.getAllByRole("listitem").filter((li) => li.getAttribute("data-qa") === "your-status-rung");

describe("YourStatus", () => {
  it("shows every tier, lowest first, with what it takes and what it gets", () => {
    render(<YourStatus loyalty={loyalty()} theme={theme} />);
    const rows = rungs();
    expect(rows.map((r) => within(r).getByText(/^(Bronze|Silver|Gold)$/).textContent)).toEqual(["Bronze", "Silver", "Gold"]);
    expect(within(rows[1]!).getByText("Takes 2 visits in the last 30 days and $300 spent")).toBeTruthy();
    expect(within(rows[1]!).getByText("Gets you: 10% off every visit")).toBeTruthy();
    expect(within(rows[2]!).getByText("Gets you: Priority booking")).toBeTruthy();
    // No perk written for Bronze: no empty "Gets you" line.
    expect(within(rows[0]!).queryByText(/Gets you/)).toBeNull();
  });

  it("marks where they stand: the held tier, the one next, nothing on the rest", () => {
    render(<YourStatus loyalty={loyalty()} theme={theme} />);
    expect(rungs().map((r) => r.getAttribute("data-state"))).toEqual(["here", "next", "ahead"]);
    expect(within(rungs()[0]!).getByText("You're here")).toBeTruthy();
    expect(within(rungs()[1]!).getByText("Next")).toBeTruthy();
  });

  it("a middle tier: the one below reads as reached", () => {
    render(<YourStatus loyalty={loyalty({ tier: "SILVER", label: "Silver", color: "#C7CBD1", nextTier: { label: "Gold", visitsAway: 4, perk: "Priority booking" } })} theme={theme} />);
    expect(rungs().map((r) => r.getAttribute("data-state"))).toEqual(["reached", "here", "next"]);
    expect(within(rungs()[0]!).getByText("Reached ✓")).toBeTruthy();
  });

  it("no tier yet: the first tier is next", () => {
    render(<YourStatus loyalty={loyalty({ tier: null, label: null, color: null, nextTier: { label: "Bronze", visitsAway: 1, perk: null } })} theme={theme} />);
    expect(rungs().map((r) => r.getAttribute("data-state"))).toEqual(["next", "ahead", "ahead"]);
  });

  it("the top tier says so", () => {
    render(<YourStatus loyalty={loyalty({ tier: "GOLD", label: "Gold", color: "#D4AF37", nextTier: null })} theme={theme} />);
    expect(rungs().map((r) => r.getAttribute("data-state"))).toEqual(["reached", "reached", "here"]);
    expect(screen.getByText("You hold the top tier here.")).toBeTruthy();
  });

  it("two requirements: each one's standing, and 'either one' when any will do", () => {
    const nextTier = {
      label: "Silver",
      visitsAway: 1,
      perk: "10% off every visit",
      match: "any" as const,
      requirements: [
        { kind: "visits", met: true, text: "2 of 2 visits in the last 30 days" },
        { kind: "spend", met: false, text: "$120 of $300 spent" },
      ],
    };
    render(<YourStatus loyalty={loyalty({ nextTier })} theme={theme} />);
    const list = screen.getByText("To reach Silver").parentElement!;
    expect(within(list).getByText("Done:")).toBeTruthy();
    expect(within(list).getByText("$120 of $300 spent")).toBeTruthy();
    expect(within(list).getByText("Either one gets you there.")).toBeTruthy();
  });

  it("nothing at all for an API without the ladder, or with rewards off (empty ladder)", () => {
    const { container: a } = render(<YourStatus loyalty={loyalty({ ladder: undefined })} theme={theme} />);
    expect(a.innerHTML).toBe("");
    const { container: b } = render(<YourStatus loyalty={loyalty({ ladder: [] })} theme={theme} />);
    expect(b.innerHTML).toBe("");
  });
});
