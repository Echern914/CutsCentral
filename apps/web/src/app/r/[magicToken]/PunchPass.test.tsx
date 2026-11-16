import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PunchPass, passColours, passMessage, type PunchPassProps } from "./PunchPass";
import type { RewardsTheme } from "./theme";
import { contrastRatio } from "@/lib/contrast";

/**
 * THE PUNCH CARD AS A PASS (Studio redesign, rewards board): the one-card
 * balance printed as a card a client would show at the counter.
 *
 * Pinned: the count reads "7 of 10" toward the next reward with a punch drawn
 * for each; the words under it are the ones the page always said; the shop's
 * Punch grid toggle hides the punches and never the count; and the card stays
 * dark and readable on every page theme, whatever accent a shop picks.
 */

const LIGHT: RewardsTheme = {
  bg: "#F7F6F2",
  surface: "#FFFFFF",
  border: "rgba(0,0,0,0.08)",
  text: "#1A1A1E",
  muted: "#6B6B70",
  accent: "#A07807",
  onAccent: "#FFFFFF",
  scheme: "light",
  radius: "1rem",
  buttonRadius: "9999px",
};
const DARK: RewardsTheme = { ...LIGHT, bg: "#0A0A0B", surface: "#161618", text: "#F5F5F4", accent: "#D4AF37", onAccent: "#101012", scheme: "dark" };

function pass(over: Partial<PunchPassProps> = {}) {
  const props: PunchPassProps = {
    theme: DARK,
    shopName: "Fresh Studio",
    logoUrl: null,
    firstName: "Jordan",
    balance: 7,
    next: { name: "Free cut", punchCost: 10, remaining: 3 },
    ready: [],
    hasRewards: true,
    badge: { label: "Gold", color: "#D4AF37" },
    visits: 12,
    showDots: true,
    ...over,
  };
  return render(<PunchPass {...props} />);
}

describe("the pass", () => {
  it("🔴 counts toward the next reward, with a punch drawn for each one it takes", () => {
    pass();
    expect(screen.getByText("of 10")).toBeTruthy();
    expect(screen.getByText("3 more to your Free cut")).toBeTruthy();
    const punches = screen.getByRole("list", { name: "7 of 10 punches toward your Free cut" });
    expect(punches.querySelectorAll("li")).toHaveLength(10);
  });

  it("prints the shop, the tier, and the client's name and visits", () => {
    pass();
    expect(screen.getByText("Fresh Studio")).toBeTruthy();
    expect(screen.getByText("Gold")).toBeTruthy();
    expect(screen.getByText("Jordan")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("a client with no name on file is still the member", () => {
    pass({ firstName: null, badge: null });
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.queryByText("Gold")).toBeNull();
  });

  it("a shop's extra card carries its own name, in place of the shop's", () => {
    pass({ title: "VIP", badge: { label: "VIP", color: null } });
    expect(screen.queryByText("Fresh Studio")).toBeNull();
    expect(screen.getAllByText("VIP")).toHaveLength(2);
  });

  it("🔴 the shop's Punch grid toggle hides the punches, never the count", () => {
    pass({ showDots: false });
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("of 10")).toBeTruthy();
  });

  it("a long card shows a bar instead of a wall of punches", () => {
    pass({ next: { name: "Free color", punchCost: 30, remaining: 12 } });
    expect(screen.queryByRole("list")).toBeNull();
    const bar = screen.getByRole("progressbar", { name: "Progress toward Free color" });
    expect(bar.getAttribute("aria-valuenow")).toBe("18");
  });

  it("with nothing to work toward, it shows the balance", () => {
    pass({ next: null, balance: 1 });
    expect(screen.getByText("punch")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("the words under the count - the ones the page always said", () => {
  it.each([
    [{ ready: [{ name: "Free cut" }], next: null, hasRewards: true }, "Your Free cut is ready!"],
    [{ ready: [{ name: "A" }, { name: "B" }], next: null, hasRewards: true }, "2 rewards ready to claim!"],
    [{ ready: [], next: { name: "Free cut", punchCost: 10, remaining: 3 }, hasRewards: true }, "3 more to your Free cut"],
    [{ ready: [], next: null, hasRewards: true }, "Keep visiting to stack up punches"],
    [{ ready: [], next: null, hasRewards: false }, "Every visit earns punches"],
  ])("%j -> %s", (p, words) => {
    expect(passMessage(p)).toBe(words);
  });
});

describe("the pass's colours", () => {
  it("🔴 is a dark card on a light page and on a dark one", () => {
    expect(passColours(LIGHT).card).toBe(LIGHT.text);
    expect(passColours(DARK).card).toBe(DARK.surface);
    for (const t of [LIGHT, DARK]) {
      const c = passColours(t);
      expect(contrastRatio(c.ink, c.card), t.scheme).toBeGreaterThanOrEqual(7);
    }
  });

  it("🔴 a punch never vanishes: an accent too close to the card is printed in the card's ink", () => {
    const navy = passColours({ ...DARK, accent: "#1A1F2E", onAccent: "#FFFFFF" });
    expect(navy.punch).toBe(DARK.text);
    expect(contrastRatio(navy.punch, navy.card)).toBeGreaterThanOrEqual(2);
    // A shop's own accent is kept whenever it reads.
    expect(passColours(DARK).punch).toBe(DARK.accent);
  });
});
