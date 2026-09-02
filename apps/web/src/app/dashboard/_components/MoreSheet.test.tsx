import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FEATURE_INDEX } from "@chairback/config/features";
import { MoreSheet } from "./MoreSheet";

vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard/insights" }));

beforeEach(() => localStorage.clear());

/**
 * 🔴 AN OWNER MUST BE ABLE TO FIND THEIR OWN-ACCOUNT FEATURES.
 *
 * The sheet is built from the registry, which withholds destinations a seat
 * cannot reach - so what it shows is a per-role computation, and getting the
 * role wrong fails SILENTLY: the page still works if you type its URL, the
 * entry simply is not there.
 *
 * That is exactly what shipped. The nav passed `barberOnly ? "BARBER" :
 * "MANAGER"`, demoting every owner to manager, and all five owner-only
 * destinations vanished from More and from search - for the owner. Nothing
 * caught it because every test passed a role explicitly.
 */

const OWNER_ONLY = FEATURE_INDEX.filter((f) => f.minRole === "OWNER" && f.listed !== false);

function sheet(role: "OWNER" | "MANAGER" | "BARBER") {
  return render(
    <MoreSheet
      open
      onClose={() => {}}
      role={role}
      rewardsEnabled
      affiliateProgramEnabled
    />,
  );
}

describe("the More sheet, per seat", () => {
  it("the registry really does carry owner-only destinations (guards the fixture)", () => {
    expect(OWNER_ONLY.length).toBeGreaterThanOrEqual(4);
    expect(OWNER_ONLY.map((f) => f.id)).toContain("affiliates");
    expect(OWNER_ONLY.map((f) => f.id)).toContain("billing");
  });

  it("🔴 an OWNER sees every owner-only feature by name", () => {
    sheet("OWNER");
    for (const f of OWNER_ONLY) {
      expect(screen.queryByText(f.name), `owner cannot find "${f.name}"`).not.toBeNull();
    }
  });

  it("a MANAGER sees none of them, and still gets the rest of the sheet", () => {
    sheet("MANAGER");
    for (const f of OWNER_ONLY) {
      expect(screen.queryByText(f.name), `manager should not see "${f.name}"`).toBeNull();
    }
    // Not an empty sheet: manager-level features are still listed.
    expect(screen.queryByText("Online booking")).not.toBeNull();
  });

  it("a BARBER sees neither those nor the manager-only surfaces", () => {
    sheet("BARBER");
    for (const f of OWNER_ONLY) {
      expect(screen.queryByText(f.name)).toBeNull();
    }
    expect(screen.queryByText("Insights")).toBeNull();
  });

  it("the affiliate flag still gates the entry independently of the seat", () => {
    render(
      <MoreSheet
        open
        onClose={() => {}}
        role="OWNER"
        rewardsEnabled
        affiliateProgramEnabled={false}
      />,
    );
    expect(screen.queryByText("Affiliates")).toBeNull();
    // ...while a different owner-only entry, which no flag gates, is present.
    expect(screen.queryByText("Plan & billing")).not.toBeNull();
  });
});

/**
 * The sheet's own search box. On a phone the Ctrl-K palette is a small
 * magnifier in the header; More is where a thumb goes when something seems
 * missing, and a directory of 45 rows is where "I don't see it" happens.
 */
describe("the More sheet's search box", () => {
  const box = () => screen.getByRole("searchbox", { name: "Search everything" });

  it("typing narrows the sheet to the matching rows and says where each lives", () => {
    sheet("OWNER");
    expect(screen.queryByText("Get booked")).not.toBeNull();
    fireEvent.change(box(), { target: { value: "tip" } });
    // The directory gives way to results...
    expect(screen.queryByText("Get booked")).toBeNull();
    const results = screen.getByRole("region", { name: "Search results" });
    const first = within(results).getAllByRole("link")[0]!;
    expect(within(first).getByText("Tips")).toBeTruthy();
    expect(within(first).getByText("Get paid")).toBeTruthy();
    expect(first.getAttribute("href")).toBe("/dashboard/payments#tips");
  });

  it("🔴 the same matcher as the palette: 'affiliate' leads with Affiliates", () => {
    sheet("OWNER");
    fireEvent.change(box(), { target: { value: "affiliate" } });
    const results = screen.getByRole("region", { name: "Search results" });
    expect(within(within(results).getAllByRole("link")[0]!).getByText("Affiliates")).toBeTruthy();
  });

  it("🔴 a miss hands the words to the assistant instead of showing nothing", () => {
    sheet("OWNER");
    fireEvent.change(box(), { target: { value: "zzzzqqq" } });
    const ask = screen.getByRole("link", { name: /Ask the assistant about/ });
    expect(ask.getAttribute("href")).toBe("/dashboard/assistant?q=zzzzqqq");
  });

  it("'support' finds Contact support, which the directory itself does not list", () => {
    sheet("BARBER");
    fireEvent.change(box(), { target: { value: "support" } });
    const results = screen.getByRole("region", { name: "Search results" });
    expect(within(results).getByText("Contact support")).toBeTruthy();
  });

  it("clearing the box brings the directory back", () => {
    sheet("OWNER");
    fireEvent.change(box(), { target: { value: "tip" } });
    fireEvent.change(box(), { target: { value: "" } });
    expect(screen.queryByText("Get booked")).not.toBeNull();
  });
});

describe("the More sheet knows where you are and where you were", () => {
  it("marks the page the sheet opened over", () => {
    sheet("OWNER");
    const here = screen.getByRole("link", { current: "page" });
    expect(within(here).getByText("Insights & trends")).toBeTruthy();
    expect(within(here).getByText("You're here")).toBeTruthy();
    // Only ONE row is "here": the six ?tab= entries share a route and would
    // all light up otherwise.
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(1);
  });

  it("leads with recent picks and remembers a tap", () => {
    localStorage.setItem("cb.recentFeatures", JSON.stringify(["affiliates", "clients"]));
    sheet("OWNER");
    expect(screen.queryByText("Recent")).not.toBeNull();
    const recent = screen.getByText("Recent").closest("section")!;
    const links = within(recent).getAllByRole("link");
    expect(within(links[0]!).getByText("Affiliates")).toBeTruthy();
    expect(within(links[1]!).getByText("Client book")).toBeTruthy();

    fireEvent.click(links[1]!);
    expect(JSON.parse(localStorage.getItem("cb.recentFeatures")!)).toEqual([
      "clients",
      "affiliates",
    ]);
  });

  it("a recent this seat cannot open is not shown", () => {
    localStorage.setItem("cb.recentFeatures", JSON.stringify(["billing"]));
    sheet("MANAGER");
    expect(screen.queryByText("Recent")).toBeNull();
  });
});
