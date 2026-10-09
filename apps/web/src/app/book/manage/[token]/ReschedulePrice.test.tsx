import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * MOVING TO A TIME WITH A DIFFERENT PRICE, on the client's own page.
 *
 * The API answers `price_changes` with both figures and moves nothing. The
 * page shows "$40 to $45", and only a tap on "Move it at $45" sends that
 * figure back. "Keep my time" moves nothing. A same-price move needs no ask.
 */
const rescheduleBooking = vi.hoisted(() => vi.fn());
const rescheduleOptions = vi.hoisted(() => vi.fn());
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  rescheduleBookingAction: rescheduleBooking,
  rescheduleOptionsAction: rescheduleOptions,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/book/manage/tok",
}));

const { ManageClient } = await import("./ManageClient");

const SUNDAY = "2026-10-18T14:00:00.000Z";
const data = {
  status: "BOOKED",
  requested: null,
  finish: null,
  addCard: null,
  savedCard: null,
  neverBooked: false,
  firstName: "Casey",
  startsAt: "2026-10-12T14:00:00.000Z",
  endsAt: "2026-10-12T14:30:00.000Z",
  shop: { name: "Move Cuts", slug: "move-cuts", timezone: "UTC", address: null, mapsUrl: null, clientNote: null, phone: null },
  service: { name: "Haircut", durationMin: 30 },
  staff: { name: "Sam" },
  canCancel: true,
  canReschedule: true,
  nonRefundable: null,
  tip: null,
  series: null,
  checkin: { open: false, status: null, etaMinutes: null, runningLate: false },
  nudges: [],
  nudgeReplied: false,
  walletPass: { appointment: false },
  serviceCharge: null,
} as never;

async function openPicker() {
  render(<ManageClient token="tok" data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
  const sunday = await screen.findByRole("button", { name: "2:00 PM" });
  return sunday;
}

beforeEach(() => {
  rescheduleBooking.mockReset();
  rescheduleOptions.mockReset().mockResolvedValue({ timezone: "UTC", slots: [SUNDAY] });
});

describe("a move that changes the price", () => {
  it("🔴 shows both figures and moves nothing until 'Move it at $45' sends the figure back", async () => {
    rescheduleBooking.mockResolvedValueOnce({ ok: false, error: "price_changes", priceChange: { fromCents: 4000, toCents: 4500 } });
    fireEvent.click(await openPicker());
    const ask = await screen.findByRole("alertdialog", { name: "This time has a different price" });
    expect(ask.textContent).toContain("from $40 to $45");
    expect(ask.textContent).toContain("Nothing has moved yet.");
    expect(rescheduleBooking).toHaveBeenCalledWith("tok", SUNDAY, undefined);
    expect(screen.queryByText(/Moved — see you/)).toBeNull();

    rescheduleBooking.mockResolvedValueOnce({ ok: true, repriced: { fromCents: 4000, toCents: 4500 } });
    fireEvent.click(screen.getByRole("button", { name: "Move it at $45" }));
    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalledTimes(2));
    expect(rescheduleBooking.mock.calls[1]).toEqual(["tok", SUNDAY, 4500]);
    expect(await screen.findByText(/Moved — see you/)).toBeTruthy();
  });

  it("'Keep my time' moves nothing", async () => {
    rescheduleBooking.mockResolvedValueOnce({ ok: false, error: "price_changes", priceChange: { fromCents: 4000, toCents: 4500 } });
    fireEvent.click(await openPicker());
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Keep my time" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(rescheduleBooking).toHaveBeenCalledTimes(1);
  });

  it("a same-price move asks nothing", async () => {
    rescheduleBooking.mockResolvedValueOnce({ ok: true });
    fireEvent.click(await openPicker());
    expect(await screen.findByText(/Moved — see you/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a lost answer claims nothing", async () => {
    rescheduleBooking.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(await openPicker());
    expect(await screen.findByRole("alert")).toHaveTextContent(/No answer/);
    expect(screen.queryByText(/Moved — see you/)).toBeNull();
  });
});
