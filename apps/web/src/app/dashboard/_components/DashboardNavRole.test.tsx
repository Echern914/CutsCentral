import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DashboardTabBar } from "./DashboardNav";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

/**
 * 🔴 THE NAV MUST NOT DEMOTE THE SEAT IT WAS GIVEN.
 *
 * MoreSheet.test.tsx proves the sheet honours a role. It could not catch the
 * bug that shipped, because the bug was in the CALLER: the nav computed
 * `barberOnly ? "BARBER" : "MANAGER"` and handed that down, so an OWNER was
 * asked as a MANAGER and every owner-only destination silently disappeared
 * from More (and from search, which is fed the same way).
 *
 * This renders the real nav with a real seat and asks the question a user
 * asks: tap More - is my own-account feature in there?
 */

function openMore(props: Parameters<typeof DashboardTabBar>[0]) {
  render(<DashboardTabBar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "More" }));
}

describe("DashboardTabBar -> More", () => {
  it("🔴 an OWNER finds the owner-only destinations", () => {
    openMore({ role: "OWNER", rewardsEnabled: true, affiliateProgramEnabled: true });
    expect(screen.queryByText("Affiliates")).not.toBeNull();
    expect(screen.queryByText("Plan & billing")).not.toBeNull();
    expect(screen.queryByText("Refer a barber")).not.toBeNull();
  });

  it("a MANAGER does not, and a BARBER gets neither those nor manager surfaces", () => {
    const { unmount } = render(
      <DashboardTabBar role="MANAGER" rewardsEnabled affiliateProgramEnabled />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByText("Affiliates")).toBeNull();
    expect(screen.queryByText("Plan & billing")).toBeNull();
    expect(screen.queryByText("Online booking")).not.toBeNull();
    unmount();

    openMore({ role: "BARBER", rewardsEnabled: true, affiliateProgramEnabled: true });
    expect(screen.queryByText("Affiliates")).toBeNull();
    expect(screen.queryByText("Insights")).toBeNull();
  });

  it("🔴 an unknown seat is treated as the OWNER, never quietly reduced", () => {
    // A transient /me failure must not strip a paying owner's own product.
    openMore({ rewardsEnabled: true, affiliateProgramEnabled: true });
    expect(screen.queryByText("Plan & billing")).not.toBeNull();
    expect(screen.queryByText("Affiliates")).not.toBeNull();
  });

  it("barberOnly still shapes the bar when no seat is given", () => {
    openMore({ barberOnly: true, rewardsEnabled: true, affiliateProgramEnabled: true });
    expect(screen.queryByText("Plan & billing")).toBeNull();
  });
});
