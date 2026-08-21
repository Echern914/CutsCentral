import { describe, expect, it } from "vitest";
import {
  destinationsFor,
  validateUpgradeRule,
  type UpgradeEdge,
} from "./serviceUpgradeRules.js";

/**
 * Which upgrades a rule is even allowed to describe.
 *
 * The availability engine decides whether an upgrade can be OFFERED; this
 * decides whether the rule makes sense at all. Two shapes are nonsense and both
 * are easy to configure by accident.
 */

const edge = (sourceServiceId: string, destinationServiceId: string): UpgradeEdge => ({
  sourceServiceId,
  destinationServiceId,
});

describe("a rule has to have sources", () => {
  it("rejects an empty source list", () => {
    const err = validateUpgradeRule(
      { sourceServiceIds: [], destinationServiceId: "vip" },
      [],
    );
    expect(err?.code).toBe("no_sources");
  });
});

describe("self-upgrade", () => {
  it("rejects a service upgrading to itself", () => {
    const err = validateUpgradeRule(
      { sourceServiceIds: ["cut"], destinationServiceId: "cut" },
      [],
    );
    expect(err?.code).toBe("self_upgrade");
  });

  it("rejects it even when other, valid sources are present", () => {
    // "Cut or Fade -> Cut" is still a prompt telling a Cut customer to book a
    // Cut. One bad source poisons the rule.
    const err = validateUpgradeRule(
      { sourceServiceIds: ["fade", "cut"], destinationServiceId: "cut" },
      [],
    );
    expect(err?.code).toBe("self_upgrade");
  });
});

describe("cycles", () => {
  it("rejects the direct reverse", () => {
    // cut -> vip already exists; vip -> cut would tell each customer the other
    // service is the better deal.
    const err = validateUpgradeRule(
      { sourceServiceIds: ["vip"], destinationServiceId: "cut" },
      [edge("cut", "vip")],
    );
    expect(err?.code).toBe("cycle");
  });

  it("rejects a LONGER chain, not just the reverse", () => {
    // a -> b -> c already; adding c -> a closes the loop. A check that only
    // looked at the direct reverse would wave this through.
    const err = validateUpgradeRule(
      { sourceServiceIds: ["c"], destinationServiceId: "a" },
      [edge("a", "b"), edge("b", "c")],
    );
    expect(err?.code).toBe("cycle");
  });

  it("allows a chain that does NOT close", () => {
    // a -> b -> c is a perfectly sensible ladder: cut, then cut+beard, then VIP.
    expect(
      validateUpgradeRule(
        { sourceServiceIds: ["b"], destinationServiceId: "c" },
        [edge("a", "b")],
      ),
    ).toBeNull();
  });

  it("allows two sources pointing at one destination", () => {
    // "Kids cut OR Mens cut -> VIP" is the common case and is not a cycle.
    expect(
      validateUpgradeRule(
        { sourceServiceIds: ["kids", "mens"], destinationServiceId: "vip" },
        [],
      ),
    ).toBeNull();
  });

  it("allows one source pointing at two destinations", () => {
    // cut -> vip already; cut -> deluxe is a second option, not a loop.
    expect(
      validateUpgradeRule(
        { sourceServiceIds: ["cut"], destinationServiceId: "deluxe" },
        [edge("cut", "vip")],
      ),
    ).toBeNull();
  });

  it("lets a rule be EDITED without tripping over its own old edges", () => {
    // The caller passes the shop's OTHER edges. If it wrongly included the
    // rule's own, re-saving cut -> vip unchanged would report a cycle.
    expect(
      validateUpgradeRule(
        { sourceServiceIds: ["cut"], destinationServiceId: "vip" },
        [], // this rule's own edge excluded
      ),
    ).toBeNull();
  });
});

describe("looking up what a service upgrades to", () => {
  const edges = [edge("cut", "vip"), edge("kids", "vip"), edge("cut", "deluxe")];

  it("returns every configured destination", () => {
    expect(destinationsFor("cut", edges)!.sort()).toEqual(["deluxe", "vip"]);
  });

  it("returns an EMPTY array for a service with rules elsewhere", () => {
    // The shop has rules, just none for this service: offer nothing.
    expect(destinationsFor("beard", edges)).toEqual([]);
  });

  it("returns NULL when the shop has configured nothing", () => {
    // 🔑 Distinct from []. null means "this shop has never set upsells up, keep
    // the automatic suggestions it has always had". Collapsing the two would
    // silently switch every existing shop's upsells off the day this ships.
    expect(destinationsFor("cut", [])).toBeNull();
  });

  it("dedupes a destination reachable from two rules", () => {
    expect(destinationsFor("cut", [edge("cut", "vip"), edge("cut", "vip")])).toEqual([
      "vip",
    ]);
  });
});
