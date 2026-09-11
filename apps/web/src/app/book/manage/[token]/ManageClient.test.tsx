import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ManageData } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/book/manage/tok",
}));
vi.mock("./actions", () => ({
  cancelBookingAction: vi.fn(),
  checkInAction: vi.fn(),
  nudgeReplyAction: vi.fn(),
  rescheduleBookingAction: vi.fn(),
  rescheduleOptionsAction: vi.fn(),
}));
vi.mock("@/lib/nativeReady", () => ({ useSignalNativeReady: () => {} }));
vi.mock("@/components/tour/state", () => ({ useDemoTour: () => false }));
vi.mock("@/components/tour/DemoTour", () => ({ DemoTour: () => null }));

const { ManageClient } = await import("./ManageClient");

/**
 * The manage page is what the confirmation text and email link to, and until
 * now it answered "what" and "when" but never "where" or "how long until".
 * Both are computed from the same shared helpers the emails and the app use.
 */

// A fixed "now" so the countdown is deterministic: Tuesday 11:00 New York.
const NOW = new Date("2026-09-08T15:00:00Z");

function data(
  over: Omit<Partial<ManageData>, "shop"> & { shop?: Partial<ManageData["shop"]> } = {},
): ManageData {
  const { shop, ...rest } = over;
  return {
    status: "BOOKED",
    firstName: "Wes",
    startsAt: "2026-09-11T15:00:00Z", // three calendar days on
    endsAt: "2026-09-11T15:30:00Z",
    shop: {
      name: "Chern Cuts",
      timezone: "America/New_York",
      slug: "chern-cuts",
      address: "123 Main St, Wilmington, DE 19801",
      mapsUrl:
        "https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20Wilmington%2C%20DE%2019801",
      ...shop,
    },
    service: { name: "Haircut", durationMin: 30 },
    staff: { name: "Dre" },
    canCancel: true,
    canReschedule: true,
    series: null,
    checkin: { open: false, status: null, etaMinutes: null, runningLate: false },
    nudges: [],
    nudgeReplied: false,
    ...rest,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => vi.useRealTimers());

describe("the manage page says where and how long", () => {
  it("shows the address as a directions link", () => {
    render(<ManageClient token="tok" data={data()} />);
    expect(screen.getByText("Where")).toBeTruthy();
    const link = screen.getByRole("link", { name: "123 Main St, Wilmington, DE 19801" });
    expect(link.getAttribute("href")).toContain("google.com/maps/search/?api=1&query=");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("counts down to the appointment in calendar days", () => {
    render(<ManageClient token="tok" data={data()} />);
    expect(screen.getByText("In 3 days")).toBeTruthy();
  });

  it("says nothing about a place the shop has not published", () => {
    render(<ManageClient token="tok" data={data({ shop: { address: null, mapsUrl: null } })} />);
    expect(screen.queryByText("Where")).toBeNull();
    // ...and still says when.
    expect(screen.getByText("In 3 days")).toBeTruthy();
  });

  it("drops the countdown once the appointment is over or gone", () => {
    render(<ManageClient token="tok" data={data({ status: "CANCELED" })} />);
    expect(screen.queryByText(/^In \d/)).toBeNull();
    // The address still shows - a canceled customer may well be rebooking.
    expect(screen.getByText("Where")).toBeTruthy();
  });
});

describe("the manage page tells the truth about status", () => {
  it("🔴 a pending request reads 'Requested', never 'Confirmed'", () => {
    render(
      <ManageClient
        token="tok"
        data={data({ status: "PENDING", requested: { reason: "approval" }, canCancel: false, canReschedule: false })}
      />,
    );
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.queryByText("Confirmed")).toBeNull();
    expect(screen.queryByText("Booked")).toBeNull();
    expect(screen.getByText("Waiting for Chern Cuts to confirm")).toBeTruthy();
  });

  it("names an unfinished payment instead of the shop", () => {
    render(
      <ManageClient
        token="tok"
        data={data({ status: "PENDING", requested: { reason: "payment" }, canCancel: false, canReschedule: false })}
      />,
    );
    expect(screen.getByText("Payment not finished")).toBeTruthy();
  });

  it("still says 'Requested' when an older API sends no reason", () => {
    render(<ManageClient token="tok" data={data({ status: "PENDING", canCancel: false, canReschedule: false })} />);
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.queryByText("Confirmed")).toBeNull();
  });

  it("a booked appointment reads 'Booked'", () => {
    render(<ManageClient token="tok" data={data()} />);
    expect(screen.getByText("Booked")).toBeTruthy();
    expect(screen.queryByText("Confirmed")).toBeNull();
  });

  it("a no-show reads 'No-show' and is not thanked for visiting", () => {
    render(<ManageClient token="tok" data={data({ status: "NO_SHOW" })} />);
    expect(screen.getByText("No-show")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByText(/Thanks for visiting/)).toBeNull();
    expect(screen.getByText("Chern Cuts marked this appointment as a no-show.")).toBeTruthy();
  });

  it("a completed visit reads 'Completed' and is thanked", () => {
    render(<ManageClient token="tok" data={data({ status: "COMPLETED" })} />);
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Thanks for visiting Chern Cuts!")).toBeTruthy();
  });
});
