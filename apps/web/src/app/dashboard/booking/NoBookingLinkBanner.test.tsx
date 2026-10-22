import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NoBookingLinkBanner } from "./NoBookingLinkBanner";
import { CONNECT_CARD_NAMES } from "./connectCardNames";

/**
 * A barber with no way to be booked is told the REAL name of the switch.
 *
 * 2026-10-22: a barber set up his services, himself and his hours, and his
 * booking link still went nowhere. The banner told him to "switch to Run
 * booking on ChairBack ... below" - a control by that name exists nowhere;
 * the switch is the "ChairBack Booking" card on the Settings tab.
 */
describe("the no-booking-link banner", () => {
  it("🔴 names the card the barber will actually see, and the tab it is on", () => {
    render(<NoBookingLinkBanner mode="link" onOpenSettings={vi.fn()} />);
    const text = screen.getByText(/Clients can.t book you yet/).textContent ?? "";
    expect(text).toContain("ChairBack Booking");
    expect(text).toContain("Settings");
    expect(text).not.toMatch(/Run booking on ChairBack/);
  });

  it("🔴 the name it uses IS the card's name (pinned to the card list)", () => {
    expect(CONNECT_CARD_NAMES.native).toBe("ChairBack Booking");
  });

  it("Open Settings takes them there", () => {
    const open = vi.fn();
    render(<NoBookingLinkBanner mode="link" onOpenSettings={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("no button while Settings is already open", () => {
    render(<NoBookingLinkBanner mode="link" onOpenSettings={null} />);
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("Square and Acuity point at the link box on Settings, not 'below'", () => {
    const { rerender } = render(<NoBookingLinkBanner mode="square" onOpenSettings={vi.fn()} />);
    expect(screen.getByText(/Square is syncing/).textContent).toContain("Settings");
    rerender(<NoBookingLinkBanner mode="acuity" onOpenSettings={vi.fn()} />);
    expect(screen.getByText(/Acuity is syncing/).textContent).not.toMatch(/below/);
  });
});
