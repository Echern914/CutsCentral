import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { NextVisitCard, type NextVisit } from "./NextVisitCard";
import { resolveRewardsTheme } from "./theme";

/**
 * The card someone opens the app for. Pins that it says how long, when, what,
 * with whom, where - and that the manage link appears only when ChairBack
 * holds the booking.
 */

// A fixed "now": Tuesday 11:00 New York.
const NOW = new Date("2026-09-08T15:00:00Z");
const theme = resolveRewardsTheme({
  accentColor: null,
  theme: null,
  fontKey: null,
  layoutStyle: null,
} as Parameters<typeof resolveRewardsTheme>[0]);

const visit: NextVisit = {
  startsAt: "2026-09-11T15:00:00Z", // three calendar days on
  serviceName: "Haircut",
  staffName: "Dre",
  manageToken: "tok_123",
  timezone: "America/New_York",
  address: "123 Main St, Wilmington, DE 19801",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=123%20Main%20St",
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => vi.useRealTimers());

describe("NextVisitCard", () => {
  it("says how long until, in calendar days, once mounted", async () => {
    render(<NextVisitCard visit={visit} theme={theme} />);
    // The countdown is clock math, so it lands after the mount effect.
    await act(async () => {});
    expect(screen.getByText("In 3 days")).toBeTruthy();
  });

  it("says when, what, with whom, and where (as directions)", async () => {
    render(<NextVisitCard visit={visit} theme={theme} />);
    await act(async () => {});
    expect(screen.getByText(/Friday, September 11/)).toBeTruthy();
    expect(screen.getByText("Haircut · with Dre")).toBeTruthy();
    const where = screen.getByRole("link", { name: "123 Main St, Wilmington, DE 19801" });
    expect(where.getAttribute("href")).toContain("google.com/maps");
  });

  it("offers Manage only when ChairBack holds the booking", async () => {
    const { unmount } = render(<NextVisitCard visit={visit} theme={theme} />);
    expect(screen.getByRole("link", { name: "Manage appointment" }).getAttribute("href")).toBe(
      "/book/manage/tok_123",
    );
    unmount();
    // Synced from Acuity: no manage page exists, so no button that would 404.
    render(<NextVisitCard visit={{ ...visit, manageToken: null, staffName: null }} theme={theme} />);
    expect(screen.queryByRole("link", { name: "Manage appointment" })).toBeNull();
    expect(screen.getByText("Haircut")).toBeTruthy();
  });

  it("says nothing about a place the shop has not published", async () => {
    render(<NextVisitCard visit={{ ...visit, address: null, mapsUrl: null }} theme={theme} />);
    expect(screen.queryByText("Where")).toBeNull();
  });

  it("keeps counting while the page stays open", async () => {
    render(
      <NextVisitCard visit={{ ...visit, startsAt: "2026-09-08T17:30:00Z" }} theme={theme} />,
    );
    await act(async () => {});
    expect(screen.getByText("In 2 hours 30 minutes")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(31 * 60_000);
    });
    expect(screen.getByText("In 1 hour 59 minutes")).toBeTruthy();
  });
});
