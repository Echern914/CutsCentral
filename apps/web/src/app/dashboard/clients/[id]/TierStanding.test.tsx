import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TierStanding, type ClientTier } from "./TierStanding";

/** The barber's glance at a client's tier: the word, the bar, and what is left. */

const silver: ClientTier = {
  current: "SILVER",
  label: "Silver",
  color: "#C7CBD1",
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
