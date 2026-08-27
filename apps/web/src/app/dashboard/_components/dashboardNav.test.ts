import { describe, expect, it } from "vitest";
import type { SeatRole } from "@chairback/config/features";
import { tabsFor } from "./DashboardNav";

/**
 * 🔴 EVERY SEAT GETS A USABLE BAR, AT EVERY ROLE.
 *
 * The bar is built from the feature registry, which WITHHOLDS destinations a
 * seat cannot reach - so a tab list is not a fixed thing, it is a per-role
 * computation, and the failure modes are silent:
 *
 *   - a DEAD tab: rendered, but its destination 403s;
 *   - a MISSING bar: every candidate withheld, leaving one lonely tab or none.
 *
 * Insights is manager-gated, so a BARBER is exactly the seat that would hit the
 * second one. The Assistant fallback exists for that, and this pins it rather
 * than trusting the reasoning.
 */
const ROLES: SeatRole[] = ["OWNER", "MANAGER", "BARBER"];

describe("the tab bar, for every role", () => {
  it("nobody gets an empty or one-item bar", () => {
    for (const role of ROLES) {
      const tabs = tabsFor(role);
      // "More" is appended by the renderers on top of these, so 2 here is a
      // 3-item bar - the floor at which a bar is worth drawing at all.
      expect(tabs.length, `${role} bar is too thin`).toBeGreaterThanOrEqual(2);
    }
  });

  it("🔴 no tab is dead - every one resolved to a real destination", () => {
    // tabsFor drops anything the registry withholds, so a surviving tab always
    // carries an href. This is the assertion that the drop actually happens.
    for (const role of ROLES) {
      for (const tab of tabsFor(role)) {
        expect(tab.href, `${role}/${tab.label} has no destination`).toBeTruthy();
        expect(tab.href.startsWith("/"), `${role}/${tab.label} href`).toBe(true);
      }
    }
  });

  it("no duplicate tabs, and no duplicate destinations", () => {
    // The Assistant fallback appends; a bug there could add it twice, or add it
    // beside an Insights tab that already resolved.
    for (const role of ROLES) {
      const tabs = tabsFor(role);
      const ids = tabs.map((t) => t.featureId);
      const hrefs = tabs.map((t) => t.href);
      expect(new Set(ids).size, `${role} duplicate featureId`).toBe(ids.length);
      expect(new Set(hrefs).size, `${role} duplicate href`).toBe(hrefs.length);
    }
  });

  it("a manager and an owner get Insights in the fourth slot", () => {
    for (const role of ["OWNER", "MANAGER"] as const) {
      const tabs = tabsFor(role);
      expect(tabs.map((t) => t.featureId)).toEqual([
        "online-booking",
        "clients",
        "home",
        "insights",
      ]);
      // And NOT the Assistant fallback - that branch must not fire for them.
      expect(tabs.some((t) => t.featureId === "assistant")).toBe(false);
    }
  });

  it("🔴 a barber gets Assistant where Insights would be, never a gap", () => {
    const tabs = tabsFor("BARBER");
    // Insights is manager-gated: withheld, so not drawn.
    expect(tabs.some((t) => t.featureId === "insights")).toBe(false);
    // ...and the slot is taken rather than left empty. Without this a barber's
    // bar collapses to Home alone.
    expect(tabs.some((t) => t.featureId === "assistant")).toBe(true);
    expect(tabs.length).toBeGreaterThanOrEqual(2);
  });

  it("🔴 a barber's bar is TWO tabs, and that is not new", () => {
    // Worth writing down exactly, because it is easy to assume the seats differ
    // by a single slot. They do not: Calendar, Clients AND Insights are all
    // manager-gated, so a barber's bar has only ever been Home + Assistant
    // (+ More). Moving Insights into the fourth slot did not change that -
    // the fallback is what preserves it.
    expect(tabsFor("BARBER").map((t) => t.featureId)).toEqual(["home", "assistant"]);

    const manager = tabsFor("MANAGER").map((t) => t.featureId);
    const barber = tabsFor("BARBER").map((t) => t.featureId);
    expect(manager.filter((id) => !barber.includes(id))).toEqual([
      "online-booking",
      "clients",
      "insights",
    ]);
    expect(barber.filter((id) => !manager.includes(id))).toEqual(["assistant"]);
  });

  it("Home is reachable from every seat", () => {
    // The one destination that must never be withheld - it is the fallback
    // landing for everything else.
    for (const role of ROLES) {
      expect(tabsFor(role).some((t) => t.featureId === "home"), role).toBe(true);
    }
  });

  it("the bar never exceeds four, so More is always the fifth", () => {
    // A 320px phone at a 44px touch target is the floor the nav is built to.
    // The Assistant fallback appends, so this is the assertion that it can only
    // ever replace a withheld tab rather than add a sixth.
    for (const role of ROLES) {
      expect(tabsFor(role).length, `${role} bar too wide`).toBeLessThanOrEqual(4);
    }
  });
});
