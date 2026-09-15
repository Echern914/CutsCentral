import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GettingStarted } from "./GettingStarted";

/**
 * The Rewards page is no longer hidden while rewards are off - it holds the
 * switch that turns them back on. That must not turn into a "Set up your
 * rewards" step for a shop that chose to be booking-only.
 */
describe("GettingStarted", () => {
  it("offers the rewards step only when rewards are on", () => {
    const { rerender } = render(
      <GettingStarted connected={false} hasClients={false} rewardsEnabled />,
    );
    expect(screen.getByText("Set up your rewards")).toBeTruthy();

    rerender(<GettingStarted connected={false} hasClients={false} rewardsEnabled={false} />);
    expect(screen.queryByText("Set up your rewards")).toBeNull();
    // The rest of first-run guidance is unaffected.
    expect(screen.getByText("Add a client or import history")).toBeTruthy();
  });
});
