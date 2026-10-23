import { describe, expect, it } from "vitest";
import { ladderStates } from "./tierRules.js";

/** The "Your status" card's marks on every rung of the tier ladder. */
const ladder = [{ tier: "BRONZE" }, { tier: "SILVER" }, { tier: "GOLD" }];
const states = (held: string | null) => ladderStates(ladder, held).map((r) => r.state);

describe("ladderStates", () => {
  it("no tier yet: the first rung is next, the rest ahead", () => {
    expect(states(null)).toEqual(["next", "ahead", "ahead"]);
  });
  it("holding the first tier: here, then next, then ahead", () => {
    expect(states("BRONZE")).toEqual(["here", "next", "ahead"]);
  });
  it("holding the middle tier: reached, here, next", () => {
    expect(states("SILVER")).toEqual(["reached", "here", "next"]);
  });
  it("at the top: everything below reached, nothing next", () => {
    expect(states("GOLD")).toEqual(["reached", "reached", "here"]);
  });
  it("a held tier the ladder doesn't list marks nothing as here or reached", () => {
    expect(states("PLATINUM")).toEqual(["ahead", "ahead", "ahead"]);
  });
  it("keeps every field of the rung", () => {
    expect(ladderStates([{ tier: "GOLD", label: "Gold", perk: "Free beard trim" }], "GOLD")[0]).toEqual({ tier: "GOLD", label: "Gold", perk: "Free beard trim", state: "here" });
  });
});
