import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FeatureSearch } from "./FeatureSearch";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/dashboard",
}));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

/**
 * The Ctrl-K palette, as a person uses it: open it, type, read the first row.
 *
 * featureSearch.test.ts (config) proves the MATCHER ranks the right entry
 * first for the words people type. This proves the palette shows that
 * answer, says where it lives, leads with what this person opened last, and
 * - the one that matters most - never leaves them at a dead end.
 */

function openPalette(role: "OWNER" | "MANAGER" = "OWNER") {
  render(<FeatureSearch role={role} rewardsEnabled affiliateProgramEnabled />);
  fireEvent.click(screen.getByRole("button", { name: "Search features (Ctrl+K)" }));
  return screen.getByRole("combobox", { name: "Search features" });
}

const firstOption = () => screen.getAllByRole("option")[0]!;

beforeEach(() => {
  push.mockReset();
  localStorage.clear();
});

describe("FeatureSearch", () => {
  it("finds a feature by the word people type and says which shelf it is on", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "tip" } });
    const row = firstOption();
    expect(within(row).getByText("Tips")).toBeTruthy();
    expect(within(row).getByText("Get paid")).toBeTruthy();
  });

  it("🔴 'affiliate' leads with Affiliates, not the entry that merely listed the word", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "affiliate" } });
    expect(within(firstOption()).getByText("Affiliates")).toBeTruthy();
  });

  it("the verb wrapper does not veto the noun: 'change tier' finds the tiers", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "change tier" } });
    expect(within(firstOption()).getByText("Loyalty status tiers")).toBeTruthy();
  });

  it("🔴 a query nothing matches is handed to the assistant, not dead-ended", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "zzzzqqq" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    const ask = screen.getByRole("button", { name: /Ask the assistant about/ });
    fireEvent.click(ask);
    expect(push).toHaveBeenCalledWith("/dashboard/assistant?q=zzzzqqq");
  });

  it("'help' reaches Contact support - unlisted in More, but typeable here", () => {
    const input = openPalette();
    fireEvent.change(input, { target: { value: "support" } });
    expect(within(firstOption()).getByText("Contact support")).toBeTruthy();
  });

  it("leads with what this person opened last, and remembers a new pick", () => {
    localStorage.setItem("cb.recentFeatures", JSON.stringify(["insights", "affiliates"]));
    const input = openPalette();
    const [first, second] = screen.getAllByRole("option");
    expect(within(first!).getByText("Insights & trends")).toBeTruthy();
    expect(within(first!).getByText("Recent")).toBeTruthy();
    expect(within(second!).getByText("Affiliates")).toBeTruthy();

    fireEvent.change(input, { target: { value: "tip" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/dashboard/payments#tips");
    expect(JSON.parse(localStorage.getItem("cb.recentFeatures")!)).toEqual([
      "tips",
      "insights",
      "affiliates",
    ]);
  });

  it("a recent this seat can no longer open simply drops out", () => {
    // billing is owner-only; the manager who inherits this browser must not
    // be handed a link that 403s.
    localStorage.setItem("cb.recentFeatures", JSON.stringify(["billing", "insights"]));
    openPalette("MANAGER");
    const first = firstOption();
    expect(within(first).getByText("Insights & trends")).toBeTruthy();
    expect(screen.queryByText("Plan & billing")).toBeNull();
  });

  it("survives storage being denied", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      const input = openPalette();
      fireEvent.change(input, { target: { value: "tip" } });
      expect(within(firstOption()).getByText("Tips")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
