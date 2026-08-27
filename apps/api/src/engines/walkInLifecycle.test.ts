import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  canTransition,
  EVENT_FOR_TRANSITION,
  legalPairs,
  POSITION_GAP,
  TERMINAL_STATUSES,
  transitionPatch,
  WALK_IN_STATUSES,
  type WalkInStatus,
  type WalkInTransitionActor,
} from "./walkInLifecycle.js";

/**
 * The walk-in lifecycle matrix, pinned EXHAUSTIVELY. The expected table below
 * is deliberately a second, independent spelling of the one in the module -
 * a drive-by edit to either shows up as a diff against the other, which is
 * the whole point of an exhaustive pin.
 */

const ACTORS: WalkInTransitionActor[] = [
  "manager",
  "barber_own_chair",
  "customer",
  "system",
];

/** from -> to -> actors. Everything absent is illegal. */
const EXPECTED: Partial<
  Record<WalkInStatus, Partial<Record<WalkInStatus, WalkInTransitionActor[]>>>
> = {
  WAITING: {
    ASSIGNED: ["manager", "barber_own_chair"],
    IN_SERVICE: ["manager", "barber_own_chair"],
    LEFT: ["customer", "manager", "barber_own_chair"],
    CANCELED: ["manager"],
    EXPIRED: ["system"],
  },
  ASSIGNED: {
    READY: ["manager", "barber_own_chair"],
    IN_SERVICE: ["manager", "barber_own_chair"],
    WAITING: ["manager", "barber_own_chair"],
    NO_SHOW: ["manager", "barber_own_chair"],
    LEFT: ["customer", "manager", "barber_own_chair"],
    CANCELED: ["manager"],
    EXPIRED: ["system"],
  },
  READY: {
    IN_SERVICE: ["manager", "barber_own_chair"],
    WAITING: ["manager", "barber_own_chair"],
    NO_SHOW: ["manager", "barber_own_chair"],
    LEFT: ["customer", "manager", "barber_own_chair"],
    CANCELED: ["manager"],
    EXPIRED: ["system"],
  },
  IN_SERVICE: {
    COMPLETED: ["system"],
    CANCELED: ["manager"],
    EXPIRED: ["system"],
  },
};

describe("the exhaustive 9x9x4 sweep", () => {
  it("canTransition agrees with the pinned table on every combination", () => {
    for (const from of WALK_IN_STATUSES) {
      for (const to of WALK_IN_STATUSES) {
        for (const actor of ACTORS) {
          const expected = EXPECTED[from]?.[to]?.includes(actor) ?? false;
          expect(
            canTransition(from, to, actor),
            `${from} -> ${to} as ${actor}`,
          ).toBe(expected);
        }
      }
    }
  });

  it("terminals are sealed: no transition leaves any terminal status", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of WALK_IN_STATUSES) {
        for (const actor of ACTORS) {
          expect(canTransition(from, to, actor)).toBe(false);
        }
      }
    }
  });

  it("a customer can do exactly one thing: leave the line", () => {
    for (const { from, to, actors } of legalPairs()) {
      if (actors.includes("customer")) {
        expect(to).toBe("LEFT");
        expect(from === "IN_SERVICE").toBe(false); // in the chair = staff's call
      }
    }
  });

  it("the system can only expire and complete", () => {
    for (const { to, actors } of legalPairs()) {
      if (actors.includes("system")) {
        expect(["EXPIRED", "COMPLETED"]).toContain(to);
      }
    }
  });

  it("the two deliberate omissions stay omitted", () => {
    // Summoning an unclaimed customer has no chair - assign first.
    for (const actor of ACTORS) {
      expect(canTransition("WAITING", "READY", actor)).toBe(false);
    }
    // Nobody was summoned, so nobody failed to show.
    for (const actor of ACTORS) {
      expect(canTransition("WAITING", "NO_SHOW", actor)).toBe(false);
    }
  });
});

describe("transitionPatch stamps", () => {
  const now = new Date("2026-08-27T15:00:00.000Z");

  const STAMP: Record<string, string> = {
    ASSIGNED: "assignedAt",
    READY: "readyAt",
    IN_SERVICE: "startedAt",
    COMPLETED: "completedAt",
    LEFT: "leftAt",
    NO_SHOW: "noShowAt",
    CANCELED: "canceledAt",
    EXPIRED: "expiredAt",
  };

  it("every destination stamps exactly its own column", () => {
    for (const { from, to } of legalPairs()) {
      const patch = transitionPatch(from, to, now);
      expect(patch.where.status).toBe(from);
      expect(patch.data.status).toBe(to);
      if (to === "WAITING") continue; // the return move, below
      expect(patch.data[STAMP[to]!]).toBe(now);
      // ... and no OTHER stamp sneaks in.
      for (const [dest, col] of Object.entries(STAMP)) {
        if (dest !== to) expect(patch.data[col]).toBeUndefined();
      }
    }
  });

  it("the return move clears exactly the assignment trio and nothing else", () => {
    for (const from of ["ASSIGNED", "READY"] as const) {
      const patch = transitionPatch(from, "WAITING", now);
      expect(patch.data).toEqual({
        status: "WAITING",
        assignedStaffId: null,
        assignedAt: null,
        readyAt: null,
      });
      // position and joinedAt are untouched - the customer keeps their place.
      expect("position" in patch.data).toBe(false);
      expect("joinedAt" in patch.data).toBe(false);
    }
  });
});

describe("shape invariants", () => {
  it("statuses partition into active + terminal with no overlap", () => {
    expect([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].sort()).toEqual(
      [...WALK_IN_STATUSES].sort(),
    );
  });

  it("every transition with an audit event names a real event type", () => {
    // ASSIGNED is deliberately absent (claim vs assign is context-dependent).
    expect(EVENT_FOR_TRANSITION.ASSIGNED).toBeUndefined();
    for (const to of ["READY", "WAITING", "LEFT", "NO_SHOW", "CANCELED"]) {
      expect(EVENT_FOR_TRANSITION[to as WalkInStatus]).toMatch(/^entry\./);
    }
  });

  it("positions are spaced enough to halve ten times", () => {
    expect(POSITION_GAP).toBeGreaterThanOrEqual(1024);
  });

  /**
   * 🔴 The code's ACTIVE_STATUSES and the database's partial unique index
   * (one live spot per phone) must agree FOREVER - a status added to one but
   * not the other silently either frees phones early or blocks rejoins. The
   * migration is committed text, so assert the exact literal appears in it
   * (the scheduler.leaseSeed.test.ts trick).
   */
  it("ACTIVE_STATUSES appears verbatim in the walk_in_mode migration's index predicate", () => {
    const sql = readFileSync(
      path.resolve(
        process.cwd(),
        "../../packages/db/prisma/migrations/20260827090000_walk_in_mode/migration.sql",
      ),
      "utf8",
    );
    const literal = ACTIVE_STATUSES.map((s) => `'${s}'`).join(",");
    expect(sql.replace(/\s+/g, "")).toContain(
      `"status"IN(${literal})AND"phone"ISNOTNULL`,
    );
  });
});
