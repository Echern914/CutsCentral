import { describe, expect, it } from "vitest";
import { asServicesSection, menuSections } from "./servicesMenu";

/**
 * The Services menu on the dashboard reads the way the booking page does:
 * by group, then everything in no group. These are the rules that keep the
 * two in step.
 */

const svc = (id: string) => ({ id, name: id.toUpperCase() });
const group = (id: string, serviceIds: string[], sortOrder: number, active = true) => ({
  id,
  name: `Group ${id}`,
  active,
  sortOrder,
  serviceIds,
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("menuSections", () => {
  it("no groups: no sections, and the list is left exactly as it was", () => {
    const services = [svc("a"), svc("b"), svc("c")];
    const menu = menuSections(services, []);
    expect(menu.sections).toEqual([]);
    expect(ids(menu.ungrouped)).toEqual(["a", "b", "c"]);
  });

  it("groups come in their own order, not the order they were handed in", () => {
    const menu = menuSections([svc("a"), svc("b")], [group("late", ["b"], 2), group("early", ["a"], 1)]);
    expect(ids(menu.sections)).toEqual(["early", "late"]);
  });

  it("a group lists its services in the order the group saved, not the shop order", () => {
    const menu = menuSections([svc("a"), svc("b"), svc("c")], [group("g", ["c", "a"], 0)]);
    expect(ids(menu.sections[0]!.services)).toEqual(["c", "a"]);
    expect(ids(menu.ungrouped)).toEqual(["b"]);
  });

  it("what is in no group follows, in the shop order", () => {
    const menu = menuSections([svc("a"), svc("b"), svc("c"), svc("d")], [group("g", ["b"], 0)]);
    expect(ids(menu.ungrouped)).toEqual(["a", "c", "d"]);
  });

  it("a group that is turned off is not a section: its services read as ungrouped", () => {
    const menu = menuSections([svc("a"), svc("b")], [group("off", ["a"], 0, false)]);
    expect(menu.sections).toEqual([]);
    expect(ids(menu.ungrouped)).toEqual(["a", "b"]);
  });

  it("a group left with no services on the menu draws nothing (no empty heading)", () => {
    // Its only member was removed: the id is still listed, the service is not.
    const menu = menuSections([svc("a")], [group("empty", ["gone"], 0), group("g", ["a"], 1)]);
    expect(ids(menu.sections)).toEqual(["g"]);
  });

  it("every service is drawn once, even if two groups both name it", () => {
    const menu = menuSections([svc("a"), svc("b")], [group("first", ["a"], 0), group("second", ["a", "b"], 1)]);
    expect(ids(menu.sections[0]!.services)).toEqual(["a"]);
    expect(ids(menu.sections[1]!.services)).toEqual(["b"]);
    expect(menu.ungrouped).toEqual([]);
    const drawn = [...menu.sections.flatMap((s) => s.services), ...menu.ungrouped];
    expect(ids(drawn).sort()).toEqual(["a", "b"]);
  });
});

describe("asServicesSection", () => {
  it("takes the three sections", () => {
    expect(asServicesSection("menu")).toBe("menu");
    expect(asServicesSection("dates")).toBe("dates");
    expect(asServicesSection("extras")).toBe("extras");
  });

  it("anything else is no section at all, so the tab opens on Menu", () => {
    expect(asServicesSection(null)).toBeNull();
    expect(asServicesSection(undefined)).toBeNull();
    expect(asServicesSection("")).toBeNull();
    expect(asServicesSection("Extras")).toBeNull();
    expect(asServicesSection("add-ons")).toBeNull();
  });
});
