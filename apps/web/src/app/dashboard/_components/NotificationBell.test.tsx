import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WHATS_NEW } from "@chairback/config/whatsNew";

const markSeen = vi.fn(async () => {});
vi.mock("./whatsNewActions", () => ({
  markWhatsNewSeenAction: (...a: unknown[]) => markSeen(...(a as [])),
}));

const { NotificationBell } = await import("./NotificationBell");

/**
 * "What's new" in the header bell. Eric: barbers should see a little bell for
 * every new feature and fix. News gets a GOLD dot - never the red count, which
 * means work waiting on the barber - and opening the bell marks it seen.
 */

const longAgo = "2026-01-01T00:00:00.000Z";
const signal = { key: "waitlist", label: "3 people waiting", count: 3, href: "/dashboard/booking" };

afterEach(() => {
  cleanup();
  markSeen.mockClear();
});

describe("what's new in the bell", () => {
  it("🔴 unseen updates show a gold dot and are named in the label - not added to the red count", () => {
    render(<NotificationBell signals={[]} whatsNew={{ seenId: null, accountCreatedAt: longAgo }} />);
    expect(document.querySelector('[data-qa="whats-new-dot"]')).not.toBeNull();
    const bell = screen.getByRole("button", { name: /new update/ });
    expect(bell.textContent).not.toMatch(/\d/); // no count on the badge
  });

  it("work waiting keeps its red count; the dot does not stack on it", () => {
    render(<NotificationBell signals={[signal]} whatsNew={{ seenId: null, accountCreatedAt: longAgo }} />);
    expect(screen.getByRole("button", { name: /3 things need you/ }).textContent).toContain("3");
    expect(document.querySelector('[data-qa="whats-new-dot"]')).toBeNull();
  });

  it("opening it lists the updates, marks the new ones, and saves that they were seen", () => {
    render(<NotificationBell signals={[]} whatsNew={{ seenId: null, accountCreatedAt: longAgo }} />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByText("What's new")).toBeTruthy();
    expect(screen.getByText(WHATS_NEW[0]!.title)).toBeTruthy();
    expect(screen.getAllByText("New").length).toBeGreaterThan(0);
    expect(markSeen).toHaveBeenCalledWith(WHATS_NEW[0]!.id);
    // The dot clears now that they have looked.
    expect(document.querySelector('[data-qa="whats-new-dot"]')).toBeNull();
  });

  it("nothing new once the newest entry has been seen", () => {
    render(<NotificationBell signals={[]} whatsNew={{ seenId: WHATS_NEW[0]!.id, accountCreatedAt: longAgo }} />);
    expect(document.querySelector('[data-qa="whats-new-dot"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.queryByText("New")).toBeNull();
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("the read-only demo never stamps anything", () => {
    render(<NotificationBell signals={[]} whatsNew={{ seenId: null, accountCreatedAt: longAgo }} demo />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("🔴 Back closes the panel - on a phone the list covers the backdrop, so it is the only way out", () => {
    render(<NotificationBell signals={[]} whatsNew={{ seenId: WHATS_NEW[0]!.id, accountCreatedAt: longAgo }} />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("🔴 every unseen update is listed, not just the newest six - opening marks them all seen", () => {
    // Seen up to the 11th entry: the ten above it are new.
    render(<NotificationBell signals={[]} whatsNew={{ seenId: WHATS_NEW[10]!.id, accountCreatedAt: longAgo }} />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(document.querySelectorAll('[data-qa="whats-new-entry"]').length).toBe(10);
    expect(screen.getByText(WHATS_NEW[9]!.title)).toBeTruthy();
  });

  it("nothing new still shows the newest six, and a long absence stops at twenty", () => {
    render(<NotificationBell signals={[]} whatsNew={{ seenId: WHATS_NEW[0]!.id, accountCreatedAt: longAgo }} />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(document.querySelectorAll('[data-qa="whats-new-entry"]').length).toBe(6);
    cleanup();
    render(<NotificationBell signals={[]} whatsNew={{ seenId: null, accountCreatedAt: longAgo }} />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(document.querySelectorAll('[data-qa="whats-new-entry"]').length).toBe(20);
  });

  it("an older API that sends no marker shows no dot", () => {
    render(<NotificationBell signals={[]} />);
    expect(document.querySelector('[data-qa="whats-new-dot"]')).toBeNull();
  });
});
