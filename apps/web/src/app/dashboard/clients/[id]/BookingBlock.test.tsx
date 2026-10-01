import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/**
 * Blocking a client from booking, on their page. A shop: "if any issues ever
 * happen they don't want that client booking again". Pinned: one tap and a
 * confirm to block (it changes what a real person can do), one tap to unblock,
 * the confirm says their booked appointments stay, and every answer is written
 * in the panel - never only a toast, which can hide under a dialog on a phone.
 */

const setBookingBlockAction = vi.fn();
vi.mock("../../actions", () => ({
  setBookingBlockAction: (...a: unknown[]) => setBookingBlockAction(...a),
}));

const { BookingBlock } = await import("./BookingBlock");

const TZ = "America/New_York";
const BLOCKED_AT = "2026-10-01T15:00:00.000Z";

beforeEach(() => setBookingBlockAction.mockReset());

const stateLine = () => document.querySelector('[data-qa="booking-block-state"]')?.textContent ?? "";
const button = (name: string) => screen.queryByRole("button", { name });

function show(initial: string | null | undefined, upcoming = 0) {
  return render(<BookingBlock clientId="c1" initial={initial} upcoming={upcoming} timezone={TZ} />);
}

describe("a client who can book", () => {
  it("🔴 blocking asks first - one tap sends nothing", () => {
    show(null);
    expect(stateLine()).toBe("Can book online.");
    fireEvent.click(button("Block from booking")!);
    expect(setBookingBlockAction).not.toHaveBeenCalled();
    const ask = screen.getByRole("group", { name: "Block this client from booking?" });
    expect(ask.textContent).toMatch(/won't be able to book, join your waitlist or move a booking online/);
    expect(ask.textContent).toMatch(/You can still book them yourself/);
  });

  it("says their booked appointments stay, with the count", () => {
    show(null, 2);
    fireEvent.click(button("Block from booking")!);
    expect(screen.getByText("Their 2 upcoming appointments stay booked. Cancel any you don't want to keep.")).toBeTruthy();
  });

  it("one upcoming appointment reads in the singular", () => {
    show(null, 1);
    fireEvent.click(button("Block from booking")!);
    expect(screen.getByText("Their upcoming appointment stays booked. Cancel it if you don't want to keep it.")).toBeTruthy();
  });

  it("with nothing coming up, there is no line about appointments", () => {
    show(null, 0);
    fireEvent.click(button("Block from booking")!);
    expect(screen.queryByText(/stays? booked/)).toBeNull();
  });

  it("Cancel backs out and sends nothing", () => {
    show(null);
    fireEvent.click(button("Block from booking")!);
    fireEvent.click(button("Cancel")!);
    expect(screen.queryByRole("group", { name: "Block this client from booking?" })).toBeNull();
    expect(setBookingBlockAction).not.toHaveBeenCalled();
  });

  it("Block saves, and the panel shows the saved block with its date", async () => {
    setBookingBlockAction.mockResolvedValue({ ok: true, bookingBlockedAt: BLOCKED_AT });
    show(null);
    fireEvent.click(button("Block from booking")!);
    await act(async () => fireEvent.click(button("Block")!));
    expect(setBookingBlockAction).toHaveBeenCalledWith("c1", true);
    expect(stateLine()).toMatch(/^Blocked from booking since Oct 1, 2026\./);
    expect(screen.getByRole("status").textContent).toBe("Blocked.");
    expect(button("Unblock")).not.toBeNull();
  });

  it("a failed save says so in the panel and changes nothing", async () => {
    setBookingBlockAction.mockResolvedValue({ ok: false });
    show(null);
    fireEvent.click(button("Block from booking")!);
    await act(async () => fireEvent.click(button("Block")!));
    expect(screen.getByRole("status").textContent).toBe("Could not save that. Try again.");
    expect(stateLine()).toBe("Can book online.");
  });
});

describe("a blocked client", () => {
  it("shows since when and what it means, and unblocks in one tap", async () => {
    setBookingBlockAction.mockResolvedValue({ ok: true, bookingBlockedAt: null });
    show(BLOCKED_AT);
    expect(stateLine()).toMatch(/Blocked from booking since Oct 1, 2026/);
    expect(stateLine()).toMatch(/rebook reminders, deals or announcements/);
    await act(async () => fireEvent.click(button("Unblock")!));
    expect(setBookingBlockAction).toHaveBeenCalledWith("c1", false);
    expect(stateLine()).toBe("Can book online.");
    expect(screen.getByRole("status").textContent).toBe("Unblocked. They can book online again.");
  });
});

it("an API from before this sends nothing: the panel shows nothing", () => {
  const { container } = show(undefined);
  expect(container.textContent).toBe("");
});
