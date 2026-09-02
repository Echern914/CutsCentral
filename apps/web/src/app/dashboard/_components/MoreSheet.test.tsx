import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FEATURE_INDEX } from "@chairback/config/features";
import { MoreSheet } from "./MoreSheet";

vi.mock("@/lib/useIsNativeApp", () => ({ useIsNativeApp: () => false }));

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
