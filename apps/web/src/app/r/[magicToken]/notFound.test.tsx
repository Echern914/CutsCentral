import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RewardsNotFound from "./not-found";

vi.mock("@/components/NativeReadySignal", () => ({
  NativeReadySignal: () => null,
}));

/**
 * The dead-link page is the most important recovery door: once link rotation
 * ships, every rotated link in an old text lands here. It must offer the way
 * back (/my-rewards), not a dead end.
 */
describe("rewards not-found", () => {
  it("offers the phone-recovery door", () => {
    render(<RewardsNotFound />);
    const door = screen.getByRole("link", { name: "Find my rewards" });
    expect(door.getAttribute("href")).toBe("/my-rewards");
  });
});
