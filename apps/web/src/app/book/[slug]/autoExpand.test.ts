import { describe, expect, it } from "vitest";
import { groupsToAutoExpand, SPARSE_DAY_CHIP_LIMIT } from "./autoExpand";

/**
 * The rule that stops a quiet day looking empty.
 *
 * Drick published after-hours targeted slots and reported they were "not
 * appearing as bookable availability". They were: the API served them on the
 * right shop-local day and the chip rendered correctly - inside a service
 * group that is collapsed by default. On the day checked, his whole shop had
 * FOUR bookable slots and three of them were after-hours specials, so the
 * booking page showed two closed accordions and no times at all.
 *
 * The numbers in the first test are that exact day.
 */

const svc = (n: number) => ({ slots: Array.from({ length: n }, (_, i) => i) });

describe("the day that caused the report", () => {
  it("opens both groups on Drick's Saturday (4 slots in the whole shop)", () => {
    // HAIRCUT: Mens Haircut 2 (both targeted), Kids 1, Shape-Up 1.
    // RETWIST/BRAIDS: RETWIST + CUT 1 - the after-hours special, and the only
    // thing in that group.
    const bundles = [
      { id: "haircut", services: [svc(2), svc(1), svc(1)] },
      { id: "retwist", services: [svc(1)] },
    ];
    expect(groupsToAutoExpand(bundles, [])).toEqual(["haircut", "retwist"]);
  });
});

describe("the only card on the page", () => {
  it("opens a lone group even when it is full of times", () => {
    // /day omits groups with no openings, so one returned group means the
    // customer's only possible next tap is that card. Hiding it is pure
    // friction whatever it contains.
    const bundles = [{ id: "only", services: [svc(40)] }];
    expect(groupsToAutoExpand(bundles, [])).toEqual(["only"]);
  });

  it("does NOT treat it as lone when loose services sit below it", () => {
    // There is something else to scan, so the collapsed default still earns
    // its keep - unless the day is sparse, which the next block covers.
    const bundles = [{ id: "one", services: [svc(40)] }];
    expect(groupsToAutoExpand(bundles, [svc(30)])).toEqual([]);
  });
});

describe("a quiet day", () => {
  it("opens every group at the sparse limit", () => {
    const bundles = [
      { id: "a", services: [svc(3)] },
      { id: "b", services: [svc(3)] },
    ];
    expect(chips(bundles)).toBe(SPARSE_DAY_CHIP_LIMIT);
    expect(groupsToAutoExpand(bundles, [])).toEqual(["a", "b"]);
  });

  it("counts loose services toward the limit", () => {
    // Two groups of 3 plus 2 loose chips is 8 - a real menu, leave it closed.
    const bundles = [
      { id: "a", services: [svc(3)] },
      { id: "b", services: [svc(3)] },
    ];
    expect(groupsToAutoExpand(bundles, [svc(2)])).toEqual([]);
  });

  it("leaves a BUSY day collapsed - that is what the design is for", () => {
    const bundles = [
      { id: "a", services: [svc(20), svc(18)] },
      { id: "b", services: [svc(14)] },
    ];
    expect(groupsToAutoExpand(bundles, [])).toEqual([]);
  });
});

describe("nothing to open", () => {
  it("returns nothing when the day has no groups at all", () => {
    expect(groupsToAutoExpand([], [])).toEqual([]);
    expect(groupsToAutoExpand([], [svc(5)])).toEqual([]);
  });

  it("handles a group whose services carry no chips", () => {
    // Shouldn't happen (/day filters it) but must not crash or misreport.
    expect(groupsToAutoExpand([{ id: "empty", services: [] }], [])).toEqual([
      "empty",
    ]);
  });
});

function chips(bundles: { services: { slots: unknown[] }[] }[]): number {
  return bundles.reduce(
    (n, b) => n + b.services.reduce((m, s) => m + s.slots.length, 0),
    0,
  );
}
