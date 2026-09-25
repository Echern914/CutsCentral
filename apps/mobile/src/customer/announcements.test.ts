import { describe, expect, it } from "vitest";
import { badgeText, bellLabel, readThrough, sentLabel } from "./announcements";

describe("the bell", () => {
  it("shows no badge at zero, the count up to nine, then 9+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-1)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
  });

  it("says the count out loud", () => {
    expect(bellLabel(0)).toBe("Announcements");
    expect(bellLabel(3)).toBe("Announcements, 3 new");
  });
});

describe("sentLabel", () => {
  const now = new Date("2026-09-25T18:00:00Z");
  it("the time today, the date before that", () => {
    expect(sentLabel("2026-09-25T14:30:00Z", now, "America/New_York")).toBe("10:30 AM");
    expect(sentLabel("2026-09-20T14:30:00Z", now, "America/New_York")).toBe("Sep 20");
    expect(sentLabel("2025-12-20T14:30:00Z", now, "America/New_York")).toBe("Dec 20, 2025");
  });
});

describe("readThrough", () => {
  const list = [
    { id: "b2", shop: { name: "A", logoUrl: null }, title: null, body: "x", sentAt: "2026-09-25T12:00:00.000Z" },
    { id: "b1", shop: { name: "A", logoUrl: null }, title: null, body: "y", sentAt: "2026-09-24T12:00:00.000Z" },
  ];
  it("marks read only as far as the newest one shown", () => {
    expect(readThrough({ announcements: list, unreadCount: 2 })).toBe("2026-09-25T12:00:00.000Z");
  });
  it("has nothing to mark when nothing is new", () => {
    expect(readThrough({ announcements: list, unreadCount: 0 })).toBeNull();
    expect(readThrough({ announcements: [], unreadCount: 0 })).toBeNull();
    expect(readThrough(undefined)).toBeNull();
  });
});
