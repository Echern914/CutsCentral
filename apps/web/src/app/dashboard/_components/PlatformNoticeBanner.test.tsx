import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlatformNotice } from "@/lib/platformNotices";

const dismissAction = vi.fn(async (_id: string) => {});
vi.mock("./platformNoticeActions", () => ({
  dismissPlatformNoticeAction: (id: string) => dismissAction(id),
}));
vi.mock("./whatsNewActions", () => ({ markWhatsNewSeenAction: vi.fn(async () => {}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { PlatformNoticeBanner } = await import("./PlatformNoticeBanner");
const { NotificationBell } = await import("./NotificationBell");

/**
 * "We know about it and we're fixing it" - the status banner at the top of
 * every dashboard. A barber asked to be told when something is broken or
 * being worked on; the platform owner posts it from the admin portal.
 */

function notice(over: Partial<PlatformNotice> = {}): PlatformNotice {
  return {
    id: "n1",
    title: "Texts are delayed",
    body: "We're on it. Your bookings are safe.",
    severity: "issue",
    state: "active",
    startsAt: "2026-10-27T14:00:00.000Z",
    endsAt: null,
    resolvedAt: null,
    dismissed: false,
    ...over,
  };
}

const banners = () => Array.from(document.querySelectorAll<HTMLElement>('[data-qa="platform-notice"]'));

afterEach(() => {
  cleanup();
  dismissAction.mockClear();
});

describe("the status banner", () => {
  it("🔴 nothing at all when there is nothing to say - which is also what a failed fetch becomes", () => {
    const { container } = render(<PlatformNoticeBanner notices={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("styles and names each severity", () => {
    render(
      <PlatformNoticeBanner
        notices={[
          notice({ id: "a", severity: "issue", title: "Payments are down" }),
          notice({ id: "b", severity: "maintenance", title: "Planned work tonight", endsAt: "2026-10-28T04:00:00.000Z" }),
          notice({ id: "c", severity: "info", title: "New help articles" }),
        ]}
      />,
    );
    const [issue, maint, info] = banners();
    expect(issue!.dataset.severity).toBe("issue");
    expect(issue!.textContent).toContain("Known issue");
    expect(issue!.className).toContain("danger-soft");
    expect(maint!.textContent).toContain("Maintenance");
    expect(maint!.className).toContain("warning-soft");
    expect(maint!.textContent).toContain("Expected until");
    expect(info!.textContent).toContain("Info");
    expect(info!.className).toContain("info-soft");
    // Read out politely, not as an alarm.
    expect(issue!.getAttribute("role")).toBe("status");
  });

  it("a fixed notice says Fixed, in green, without the old problem text", () => {
    render(<PlatformNoticeBanner notices={[notice({ state: "resolved", resolvedAt: "2026-10-27T15:00:00.000Z" })]} />);
    const [b] = banners();
    expect(b!.dataset.state).toBe("resolved");
    expect(b!.textContent).toContain("Fixed");
    expect(b!.textContent).toContain("Texts are delayed");
    expect(b!.textContent).not.toContain("We're on it");
    expect(b!.className).toContain("emerald-soft");
  });

  it("🔴 closing one hides it at once and remembers it on the account; the others stay", () => {
    render(<PlatformNoticeBanner notices={[notice({ id: "a" }), notice({ id: "b", title: "Calendar is slow" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Close notice: Texts are delayed" }));
    expect(dismissAction).toHaveBeenCalledWith("a");
    expect(banners().map((b) => b.textContent)).toEqual([expect.stringContaining("Calendar is slow")]);
  });

  it("one this person already closed does not come back", () => {
    render(<PlatformNoticeBanner notices={[notice({ dismissed: true })]} />);
    expect(banners()).toHaveLength(0);
  });

  it("the read-only demo closes it on screen and saves nothing", () => {
    render(<PlatformNoticeBanner notices={[notice()]} demo />);
    fireEvent.click(screen.getByRole("button", { name: /Close notice/ }));
    expect(banners()).toHaveLength(0);
    expect(dismissAction).not.toHaveBeenCalled();
  });

  it("a failed save never breaks the page", async () => {
    dismissAction.mockRejectedValueOnce(new Error("network"));
    render(<PlatformNoticeBanner notices={[notice()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Close notice/ }));
    await Promise.resolve();
    expect(banners()).toHaveLength(0);
  });
});

describe("in the bell", () => {
  it("lists live notices - even a closed one - and lights the gold dot for an open one", () => {
    render(
      <NotificationBell
        signals={[]}
        notices={[notice({ id: "a" }), notice({ id: "b", title: "Was slow", state: "resolved", dismissed: true })]}
      />,
    );
    expect(document.querySelector('[data-qa="whats-new-dot"]')).not.toBeNull();
    const bell = screen.getByRole("button", { name: /1 service notice/ });
    fireEvent.click(bell);
    const section = document.querySelector('[data-qa="bell-notices"]')!;
    expect(section.textContent).toContain("Known issue: Texts are delayed");
    expect(section.textContent).toContain("Fixed: Was slow");
  });

  it("no notices, no section", () => {
    render(<NotificationBell signals={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(document.querySelector('[data-qa="bell-notices"]')).toBeNull();
  });
});
