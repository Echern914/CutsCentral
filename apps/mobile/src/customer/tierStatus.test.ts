import { describe, expect, it } from "vitest";
import { bestTier, displayName, heroLine, tierProgressLine } from "./tierStatus";
import type { RewardProgram } from "./types";

const program = (name: string, tier: Partial<RewardProgram["tier"]>): RewardProgram => ({
  shop: { key: name, name, logoUrl: null, timezone: "America/Los_Angeles" } as RewardProgram["shop"],
  tier: { label: null, visits: 0, perk: null, next: null, ...tier },
  cards: [],
  activity: [],
  otherProfileHasPunches: false,
});

describe("the profile's status", () => {
  it("wears the highest tier held anywhere, keeping the first shop on a tie", () => {
    const programs = [
      program("Fade Factory", { key: "SILVER", label: "Silver", color: "#C7CBD1" }),
      program("Sharp Cuts", { key: "GOLD", label: "Gold", color: "#D4AF37" }),
      program("Blade Room", { key: "GOLD", label: "Gold", color: "#D4AF37" }),
    ];
    expect(bestTier(programs)).toEqual({ key: "GOLD", label: "Gold", color: "#D4AF37", shopName: "Sharp Cuts" });
    expect(heroLine(bestTier(programs), programs)).toBe("Gold member at Sharp Cuts");
  });

  it("reads an older API that sends only the label", () => {
    const old = [program("Fade Factory", { label: "Bronze" })];
    expect(bestTier(old)).toMatchObject({ key: "BRONZE", color: "#B8772F" });
    expect(heroLine(bestTier(old), old)).toBe("Bronze member at Fade Factory");
  });

  it("says what comes next when there is no tier yet", () => {
    expect(bestTier([program("Fade Factory", {})])).toBeNull();
    expect(heroLine(null, [program("Fade Factory", {})])).toBe("Your first visit starts your status");
    expect(heroLine(null, [])).toBe("Your status shows here once a shop you visit runs rewards");
  });

  it("names them the way they wrote it", () => {
    expect(displayName({ firstName: " Jordan ", lastName: "Reyes" })).toBe("Jordan Reyes");
    expect(displayName({ firstName: "Jordan", lastName: null })).toBe("Jordan");
    expect(displayName({ firstName: null, lastName: null })).toBeNull();
    expect(displayName(undefined)).toBeNull();
  });

  it("the card line: the server's words, the old visit count, or the top", () => {
    expect(
      tierProgressLine(
        program("Sharp Cuts", {
          label: "Silver",
          next: { label: "Gold", visitsAway: 1, perk: null, summary: "1 more visit in the last 30 days to reach Gold" },
        }),
      ),
    ).toBe("1 more visit in the last 30 days to reach Gold");
    expect(tierProgressLine(program("Sharp Cuts", { label: "Bronze", next: { label: "Silver", visitsAway: 3, perk: null } }))).toBe(
      "3 visits to Silver",
    );
    expect(tierProgressLine(program("Sharp Cuts", { label: "Gold", next: null }))).toBe("You're at the top tier at Sharp Cuts");
    expect(tierProgressLine(program("Sharp Cuts", { label: null, next: null }))).toBeNull();
  });
});
