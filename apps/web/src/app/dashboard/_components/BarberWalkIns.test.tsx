import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BarberWalkIns } from "./BarberWalkIns";
import {
  barberWalkInAction,
  getBarberWalkInsAction,
} from "./barberWalkInActions";
import type { WalkInEntryRow } from "../booking/actions";

vi.mock("@/lib/useVisiblePoll", () => ({ useVisiblePoll: () => {} }));
vi.mock("./barberWalkInActions", () => ({
  getBarberWalkInsAction: vi.fn(),
  barberWalkInAction: vi.fn(async () => ({ ok: true })),
}));

/** The barber home section: quiet when the feature is off, one-tap claim,
 * own-chair actions only - all server truths. */

const getMock = vi.mocked(getBarberWalkInsAction);
const actMock = vi.mocked(barberWalkInAction);

const entry = (over: Partial<WalkInEntryRow> = {}): WalkInEntryRow =>
  ({
    id: `e${Math.random().toString(36).slice(2, 8)}`,
    status: "WAITING",
    source: "KIOSK",
    position: 1024,
    firstName: "Marcus",
    lastName: "Long",
    phone: null,
    clientId: null,
    note: null,
    preferredStaffId: null,
    assignedStaffId: null,
    appointmentId: null,
    quotedWaitMin: null,
    joinedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    services: [
      { serviceId: "s1", name: "Fade", durationMin: 30, price: 40, sortOrder: 0 },
    ],
    totalDurationMin: 30,
    estimate: { projectedStaffId: null, startsAt: null, waitMin: 10 },
    ...over,
  }) as WalkInEntryRow;

beforeEach(() => {
  vi.resetAllMocks();
  actMock.mockResolvedValue({ ok: true });
});

describe("BarberWalkIns", () => {
  it("renders NOTHING when the feature is off or dark", async () => {
    getMock.mockResolvedValue({ ok: false, error: "walk_in_disabled", status: 409 } as never);
    const { container } = render(<BarberWalkIns />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("renders NOTHING when the line is empty - a quiet feature, not an ad", async () => {
    getMock.mockResolvedValue({
      ok: true,
      data: { chairStaffId: "b1", acceptingNow: true, now: new Date().toISOString(), entries: [] },
    } as never);
    const { container } = render(<BarberWalkIns />);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("claim is one tap", async () => {
    const e = entry();
    getMock.mockResolvedValue({
      ok: true,
      data: { chairStaffId: "b1", acceptingNow: true, now: new Date().toISOString(), entries: [e] },
    } as never);
    render(<BarberWalkIns />);
    fireEvent.click(await screen.findByRole("button", { name: /claim/i }));
    await waitFor(() => expect(actMock).toHaveBeenCalledWith(e.id, "claim"));
  });

  it("a chairless seat sees the line but cannot act", async () => {
    getMock.mockResolvedValue({
      ok: true,
      data: { chairStaffId: null, acceptingNow: true, now: new Date().toISOString(), entries: [entry()] },
    } as never);
    render(<BarberWalkIns />);
    const claim = await screen.findByRole("button", { name: /claim/i });
    expect((claim as HTMLButtonElement).disabled).toBe(true);
  });

  it("their claimed customer shows the own-chair ladder: ready -> start -> complete", async () => {
    const mine = entry({ status: "ASSIGNED", assignedStaffId: "b1" });
    getMock.mockResolvedValue({
      ok: true,
      data: { chairStaffId: "b1", acceptingNow: true, now: new Date().toISOString(), entries: [mine] },
    } as never);
    render(<BarberWalkIns />);
    expect(await screen.findByRole("button", { name: /ready/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));
    await waitFor(() => expect(actMock).toHaveBeenCalledWith(mine.id, "start"));
  });
});
