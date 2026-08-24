import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WaitlistBoard } from "./WaitlistBoard";
import { getWaitlistAction, setWaitlistStatusAction, type WaitlistEntry } from "./actions";

vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(),
  setWaitlistStatusAction: vi.fn(async () => ({ ok: true })),
  createWaitlistEntryAction: vi.fn(async () => ({ ok: true })),
}));

/**
 * The board's promises to a barber: a BOOKED entry never lies about whether a
 * real appointment exists, legacy rows are visibly legacy, "booked externally"
 * asks before it commits, and every action refreshes what is on screen.
 */

const mockGet = vi.mocked(getWaitlistAction);
const mockSet = vi.mocked(setWaitlistStatusAction);
const toast = vi.fn();

const entry = (over: Partial<WaitlistEntry> = {}): WaitlistEntry => ({
  id: "e1",
  firstName: "Marcus",
  lastName: "Reed",
  phone: "+12025550171",
  email: null,
  serviceId: "svc1",
  staffId: "stf1",
  serviceName: "Classic Fade",
  staffName: "Dee",
  preferredTime: null,
  note: null,
  status: "WAITING",
  createdAt: "2026-08-24T12:00:00.000Z",
  windows: [{ startDate: "2026-08-25", endDate: "2026-08-25", startMin: 540, endMin: 720 }],
  timezone: "America/New_York",
  minHoursNotice: null,
  notifiedAt: null,
  requestedDate: "2026-08-25",
  legacyAnyDate: false,
  bookedAppointmentId: null,
  bookedAppointment: null,
  ...over,
});

const page = (rows: WaitlistEntry[]) => ({
  ok: true as const,
  waitlist: rows,
  counts: { WAITING: rows.length, CONTACTED: 0, BOOKED: 0, EXPIRED: 0, REMOVED: 0 },
  nextCursor: null,
});

const props = {
  staff: [{ id: "stf1", name: "Dee", active: true }] as never,
  services: [{ id: "svc1", name: "Classic Fade", active: true }] as never,
  timezone: "America/New_York",
  toast: toast as never,
};

beforeEach(() => {
  mockGet.mockReset();
  mockSet.mockClear();
  toast.mockClear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("what a card says", () => {
  it("shows the full name, service, provider and every preference window", async () => {
    mockGet.mockResolvedValue(
      page([
        entry({
          windows: [
            { startDate: "2026-08-25", endDate: "2026-08-25", startMin: 540, endMin: 720 },
            { startDate: "2026-08-29", endDate: "2026-08-29", startMin: null, endMin: null },
          ],
        }),
      ]),
    );
    render(<WaitlistBoard {...props} />);
    expect(await screen.findByText("Marcus Reed")).toBeTruthy();
    expect(screen.getByText(/Classic Fade · Dee/)).toBeTruthy();
    expect(screen.getByText(/Aug 25 · 9:00 AM–12:00 PM/)).toBeTruthy();
    expect(screen.getByText(/Aug 29 · any time/)).toBeTruthy();
  });

  it("🔑 a BOOKED entry with no appointment says so - never implies a real booking", async () => {
    mockGet.mockResolvedValue(
      page([entry({ status: "BOOKED", bookedAppointmentId: null, bookedAppointment: null })]),
    );
    render(<WaitlistBoard {...props} />);
    expect(await screen.findByText("Booked externally")).toBeTruthy();
    expect(screen.getByText(/no linked appointment/i)).toBeTruthy();
  });

  it("a BOOKED entry WITH an appointment shows when it is", async () => {
    mockGet.mockResolvedValue(
      page([
        entry({
          status: "BOOKED",
          bookedAppointmentId: "a1",
          bookedAppointment: {
            id: "a1",
            startsAt: "2026-08-26T14:00:00.000Z",
            status: "BOOKED",
            staffName: "Dee",
            serviceName: "Classic Fade",
          },
        }),
      ]),
    );
    render(<WaitlistBoard {...props} />);
    expect(await screen.findByText(/Booked Aug 26.*with Dee/)).toBeTruthy();
    expect(screen.queryByText("Booked externally")).toBeNull();
  });

  it("legacy NULL-date rows are labelled, not silently undated", async () => {
    mockGet.mockResolvedValue(
      page([
        entry({
          legacyAnyDate: true,
          requestedDate: null,
          windows: [{ startDate: null, endDate: null, startMin: null, endMin: null }],
        }),
      ]),
    );
    render(<WaitlistBoard {...props} />);
    expect(await screen.findByText("legacy")).toBeTruthy();
    expect(screen.getByText(/Any date · any time/)).toBeTruthy();
  });
});

describe("actions", () => {
  it("🔴 'Booked externally' asks first, then refreshes", async () => {
    mockGet.mockResolvedValue(page([entry()]));
    render(<WaitlistBoard {...props} />);
    await screen.findByText("Marcus Reed");
    const callsBefore = mockGet.mock.calls.length;

    fireEvent.click(screen.getByText("Booked externally"));
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringMatching(/outside ChairBack/i),
    );
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith("e1", "BOOKED"));
    // every action re-reads the board
    await waitFor(() => expect(mockGet.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("a declined confirmation changes nothing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    mockGet.mockResolvedValue(page([entry()]));
    render(<WaitlistBoard {...props} />);
    await screen.findByText("Marcus Reed");
    fireEvent.click(screen.getByText("Booked externally"));
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("Contacted and Remove need no confirmation", async () => {
    mockGet.mockResolvedValue(page([entry()]));
    render(<WaitlistBoard {...props} />);
    await screen.findByText("Marcus Reed");
    // "Contacted" is BOTH a section chip and a card action - the chip's
    // accessible name carries its count, so an exact name hits the button.
    fireEvent.click(screen.getByRole("button", { name: "Contacted" }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith("e1", "CONTACTED"));
  });

  it("a closed entry can be put back on the list", async () => {
    mockGet.mockResolvedValue(page([entry({ status: "REMOVED" })]));
    render(<WaitlistBoard {...props} />);
    await screen.findByText("Marcus Reed");
    fireEvent.click(screen.getByText("Put back on the list"));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith("e1", "WAITING"));
  });
});

describe("sections, filters and empty states", () => {
  it("switching section re-queries with that status", async () => {
    mockGet.mockResolvedValue(page([entry()]));
    render(<WaitlistBoard {...props} />);
    await screen.findByText("Marcus Reed");
    fireEvent.click(screen.getByText("Expired"));
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({ status: "EXPIRED" })),
    );
  });

  it("sorting by requested date re-queries", async () => {
    mockGet.mockResolvedValue(page([entry()]));
    render(<WaitlistBoard {...props} />);
    await screen.findByText("Marcus Reed");
    fireEvent.click(screen.getByText("Requested date"));
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(expect.objectContaining({ sort: "requested" })),
    );
  });

  it("each empty section explains itself in its own words", async () => {
    mockGet.mockResolvedValue({
      ok: true,
      waitlist: [],
      counts: { WAITING: 0, CONTACTED: 0, BOOKED: 0, EXPIRED: 0, REMOVED: 0 },
      nextCursor: null,
    });
    render(<WaitlistBoard {...props} />);
    expect(await screen.findByText("Nobody's waiting")).toBeTruthy();
    fireEvent.click(screen.getByText("Removed"));
    expect(await screen.findByText("Nobody removed")).toBeTruthy();
    expect(screen.getByText(/kept, not deleted/i)).toBeTruthy();
  });
});
