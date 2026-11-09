import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SignupSourcesSection, type SignupSources } from "./SignupSourcesSection";

function data(over: Partial<Record<SignupSources["answers"][number]["id"], number>> = {}, none = 0): SignupSources {
  const ids = ["another_barber", "instagram", "tiktok", "google", "friend_family", "other"] as const;
  return {
    days: 30,
    answers: ids.map((id) => ({ id, total: over[id] ?? 0, recent: over[id] ? 1 : 0 })),
    noAnswer: { total: none, recent: 0 },
  };
}

describe("the how-did-you-hear chart", () => {
  it("🔴 biggest answer first, each with its numbers", () => {
    render(<SignupSourcesSection data={data({ tiktok: 2, instagram: 9 })} />);
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(6);
    expect(rows[0]?.textContent).toContain("Instagram");
    expect(rows[0]?.textContent).toContain("9 · 1");
    expect(rows[1]?.textContent).toContain("TikTok");
    expect(rows[5]?.textContent).toContain("0 · 0");
  });

  it("🔴 businesses with no answer stay out of the bars, so they can't shrink the answers", () => {
    render(<SignupSourcesSection data={data({ google: 1 }, 40)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText(/40 businesses have no answer/)).toBeTruthy();
  });

  it("before anyone has answered it says so rather than drawing empty bars", () => {
    render(<SignupSourcesSection data={data({}, 12)} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText(/No answers yet/)).toBeTruthy();
    expect(screen.getByText(/12 businesses have no answer/)).toBeTruthy();
  });
});
