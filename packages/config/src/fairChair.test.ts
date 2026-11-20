import { describe, expect, it } from "vitest";
import { fairChairOrder } from "./fairChair.js";

const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe("fairChairOrder - whose turn an 'any available' booking is", () => {
  it("🔴 the person with fewer bookings that day goes first, whatever order they arrive in", () => {
    const c = counts({ ana: 2, ben: 0 });
    expect(fairChairOrder(["ana", "ben"], c, "2026-03-02")[0]).toBe("ben");
    expect(fairChairOrder(["ben", "ana"], c, "2026-03-02")[0]).toBe("ben");
  });

  it("the order flips once the leader has taken more bookings", () => {
    expect(fairChairOrder(["ana", "ben"], counts({ ana: 1, ben: 0 }), "2026-03-02")[0]).toBe("ben");
    expect(fairChairOrder(["ana", "ben"], counts({ ana: 1, ben: 2 }), "2026-03-02")[0]).toBe("ana");
  });

  it("someone with no bookings counted is zero, not last", () => {
    expect(fairChairOrder(["ana", "ben", "cy"], counts({ ana: 3, ben: 1 }), "2026-03-02")).toEqual([
      "cy",
      "ben",
      "ana",
    ]);
  });

  it("a tie does not depend on the order the ids arrive in", () => {
    const none = counts({});
    const a = fairChairOrder(["ana", "ben", "cy"], none, "2026-03-02");
    const b = fairChairOrder(["cy", "ana", "ben"], none, "2026-03-02");
    expect(a).toEqual(b);
  });

  it("🔴 a tie is not always won by the same person: the leader changes across days", () => {
    const none = counts({});
    const leaders = new Set<string>();
    for (let day = 1; day <= 28; day += 1) {
      const key = `2026-03-${String(day).padStart(2, "0")}`;
      leaders.add(fairChairOrder(["ana", "ben", "cy"], none, key)[0]!);
    }
    expect(leaders.size).toBe(3);
  });

  it("the same day always gives the same order (a cached body and a fresh one agree)", () => {
    const none = counts({});
    expect(fairChairOrder(["ana", "ben"], none, "2026-03-02")).toEqual(
      fairChairOrder(["ana", "ben"], none, "2026-03-02"),
    );
  });

  it("🔴 one person is returned untouched: a one-chair shop is unchanged", () => {
    expect(fairChairOrder(["solo"], counts({ solo: 9 }), "2026-03-02")).toEqual(["solo"]);
    expect(fairChairOrder([], counts({}), "2026-03-02")).toEqual([]);
  });

  it("returns a new list and never reorders the caller's", () => {
    const input = ["ana", "ben"];
    const out = fairChairOrder(input, counts({ ana: 5 }), "2026-03-02");
    expect(input).toEqual(["ana", "ben"]);
    expect(out).not.toBe(input);
  });
});
