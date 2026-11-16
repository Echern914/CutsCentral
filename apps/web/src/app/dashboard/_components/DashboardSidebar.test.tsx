import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

/**
 * The dashboard on a computer: the left sidebar (Studio redesign).
 *
 * What matters is that it can never disagree with the tab bar about who may
 * go where (every row resolves through the registry for this seat), that ONE
 * row is marked current even where two rows share a page, and that sign out
 * and help stay reachable now that the top bar no longer carries them.
 */

const nav = vi.hoisted(() => ({ pathname: "/dashboard", search: "", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push }),
}));
vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));
vi.mock("../actions", () => ({ switchShopAction: vi.fn() }));

const { DashboardSidebar, pickActive } = await import("./DashboardSidebar");
const { DashboardTabBar } = await import("./DashboardNav");

type Props = Parameters<typeof DashboardSidebar>[0];
const base: Props = {
  role: "OWNER",
  rewardsEnabled: true,
  shopName: "Fade District",
  shops: [{ id: "s1", name: "Fade District" }],
  teams: [],
  activeShopId: "s1",
  userName: "Dre Carter",
  avatarUrl: null,
  demo: false,
  signOutAction: async () => {},
};

beforeEach(() => {
  nav.pathname = "/dashboard";
  nav.search = "";
  nav.push.mockReset();
});

const current = () =>
  screen
    .getAllByRole("link")
    .filter((a) => a.getAttribute("aria-current") === "page")
    .map((a) => a.textContent);

describe("pickActive", () => {
  const hrefs = [
    "/dashboard",
    "/dashboard/booking",
    "/dashboard/clients",
    "/dashboard/booking?tab=Services",
  ];

  it("🔴 two rows on one page: the row whose query matches wins", () => {
    // Calendar is /dashboard/booking and Services is a tab of the same page.
    // Marking both, or Calendar while Services is open, says nothing useful.
    const on = (path: string, q: string) => pickActive(hrefs, path, new URLSearchParams(q));
    expect(on("/dashboard/booking", "tab=Services")).toBe("/dashboard/booking?tab=Services");
    expect(on("/dashboard/booking", "")).toBe("/dashboard/booking");
    expect(on("/dashboard/booking", "tab=Hours")).toBe("/dashboard/booking");
  });

  it("Home is exact, a section owns its sub-pages, and a look-alike path is nobody's", () => {
    const on = (path: string) => pickActive(hrefs, path, new URLSearchParams());
    expect(on("/dashboard")).toBe("/dashboard");
    expect(on("/dashboard/clients/abc")).toBe("/dashboard/clients");
    expect(on("/dashboard/bookingx")).toBeNull();
    expect(on("/dashboard/team")).toBeNull();
  });
});

describe("the sidebar", () => {
  it("an owner gets the tabs, the shop's main pages and All features", () => {
    render(<DashboardSidebar {...base} />);
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Home",
      "Calendar",
      "Clients",
      "Insights",
    ]);
    const shop = screen.getByRole("navigation", { name: "Shop" });
    expect(within(shop).getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Your page",
      "Services",
      "Rewards",
      "Team",
    ]);
    expect(screen.getByRole("button", { name: "All features" })).toBeTruthy();
  });

  it("🔴 an employee gets no Shop section, not a list of doors that refuse", () => {
    render(<DashboardSidebar {...base} role="BARBER" barberOnly />);
    expect(screen.queryByRole("navigation", { name: "Shop" })).toBeNull();
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link").map((a) => a.textContent)).toEqual(["Home", "Assistant"]);
  });

  it("a rewards-off shop gets no Rewards row", () => {
    render(<DashboardSidebar {...base} rewardsEnabled={false} />);
    expect(screen.queryByRole("link", { name: "Rewards" })).toBeNull();
  });

  it("marks exactly one row current", () => {
    nav.pathname = "/dashboard/booking";
    nav.search = "tab=Services";
    render(<DashboardSidebar {...base} />);
    expect(current()).toEqual(["Services"]);
  });

  it("🔴 sign out is here on a computer, and absent for a demo session", () => {
    const { unmount } = render(<DashboardSidebar {...base} />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    unmount();
    // The layout hands a demo session no action: signing out of the shared
    // demo account would end every other visitor's session.
    render(<DashboardSidebar {...base} demo signOutAction={undefined} />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Account/ })).toBeNull();
  });

  it("Help falls back to the Assistant page when no panel is listening", () => {
    render(<DashboardSidebar {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(nav.push).toHaveBeenCalledWith("/dashboard/assistant");
  });

  it("🔴 on a phone, sign out is the last thing in More (it left the top bar)", () => {
    const { unmount } = render(<DashboardTabBar role="OWNER" signOutAction={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    unmount();
    render(<DashboardTabBar role="OWNER" />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("a one-shop owner sees the shop's name, not a switcher", () => {
    render(<DashboardSidebar {...base} />);
    expect(screen.getByRole("link", { name: "Fade District" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
