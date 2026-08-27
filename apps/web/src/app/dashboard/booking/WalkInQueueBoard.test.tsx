import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WalkInQueueBoard } from "./WalkInQueueBoard";
import {
  getWalkInQueueAction,
  walkInStartAction,
  walkInTransitionAction,
  type WalkInEntryRow,
} from "./actions";
import type { StaffRow } from "./page";

vi.mock("@/lib/useVisiblePoll", () => ({ useVisiblePoll: () => {} }));
vi.mock("./actions", () => ({
  getWalkInQueueAction: vi.fn(),
  walkInTransitionAction: vi.fn(async () => ({ ok: true })),
  walkInAssignAction: vi.fn(async () => ({ ok: true })),
  walkInStartAction: vi.fn(async () => ({ ok: true })),
  walkInReorderAction: vi.fn(async () => ({ ok: true })),
}));

/**
 * The Live Queue board's rendered promises: server truths only (disabled
 * state, honest stale copy), the right actions per status, and the one
 * expected conflict (slot_taken) reads as what it is.
 */

const staff: StaffRow[] = [
  { id: "b1", name: "Ava", bio: null, imageUrl: null, active: true, sortOrder: 0 },
  { id: "b2", name: "Ben", bio: null, imageUrl: null, active: true, sortOrder: 1 },
];

const entry = (over: Partial<WalkInEntryRow> = {}): WalkInEntryRow => ({
  id: `e${Math.random().toString(36).slice(2, 8)}`,
  status: "WAITING",
  source: "KIOSK",
  position: 1024,
  firstName: "Marcus",
  lastName: "Longname",
  phone: "+12125550000",
  clientId: null,
  note: null,
  preferredStaffId: null,
  assignedStaffId: null,
  appointmentId: null,
  quotedWaitMin: 20,
  joinedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  startedAt: null,
  completedAt: null,
  services: [
    { serviceId: "s1", name: "Fade", durationMin: 30, price: 40, sortOrder: 0 },
  ],
  totalDurationMin: 30,
  estimate: { projectedStaffId: "b1", startsAt: null, waitMin: 15 },
  ...over,
});

const queueMock = vi.mocked(getWalkInQueueAction);
const startMock = vi.mocked(walkInStartAction);
const transitionMock = vi.mocked(walkInTransitionAction);
const toast = vi.fn();

const data = (entries: WalkInEntryRow[]) => ({
  ok: true,
  data: { acceptingNow: true, now: new Date().toISOString(), entries, done: [] },
});

beforeEach(() => {
  vi.resetAllMocks();
  transitionMock.mockResolvedValue({ ok: true });
  startMock.mockResolvedValue({ ok: true });
});

describe("states", () => {
  it("Walk-In Mode off renders the explanation card and never fetches", () => {
    render(
      <WalkInQueueBoard staff={staff} walkInEnabled={false} timezone="UTC" toast={toast} />,
    );
    expect(screen.getByText(/walk-in mode is off/i)).toBeTruthy();
    expect(queueMock).not.toHaveBeenCalled();
  });

  it("an empty line says so instead of rendering a blank board", async () => {
    queueMock.mockResolvedValue(data([]) as never);
    render(
      <WalkInQueueBoard staff={staff} walkInEnabled timezone="UTC" toast={toast} />,
    );
    expect(await screen.findByText(/the line is empty/i)).toBeTruthy();
  });

  it("a card shows first name + last INITIAL, the ask, the wait, and the labeled estimate", async () => {
    queueMock.mockResolvedValue(data([entry()]) as never);
    render(
      <WalkInQueueBoard staff={staff} walkInEnabled timezone="UTC" toast={toast} />,
    );
    expect(await screen.findByText("Marcus L.")).toBeTruthy();
    expect(screen.queryByText(/Longname/)).toBeNull(); // never the full surname
    expect(screen.getByText(/asked for/i)).toBeTruthy();
    expect(screen.getByText(/waiting 10m/i)).toBeTruthy();
    expect(screen.getByText(/est\. start ~15m.*estimate/i)).toBeTruthy();
  });
});

describe("actions land on the server's lifecycle", () => {
  it("WAITING: Start service uses the projected chair by default", async () => {
    const e = entry();
    queueMock.mockResolvedValue(data([e]) as never);
    render(
      <WalkInQueueBoard staff={staff} walkInEnabled timezone="UTC" toast={toast} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /start service/i }));
    await waitFor(() => expect(startMock).toHaveBeenCalledWith(e.id, "b1"));
  });

  it("IN_SERVICE: Complete fires the complete transition", async () => {
    const e = entry({ status: "IN_SERVICE", assignedStaffId: "b1", startedAt: new Date().toISOString() });
    queueMock.mockResolvedValue(data([e]) as never);
    render(
      <WalkInQueueBoard staff={staff} walkInEnabled timezone="UTC" toast={toast} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /^complete$/i }));
    await waitFor(() =>
      expect(transitionMock).toHaveBeenCalledWith(e.id, "complete"),
    );
  });

  it("Remove asks twice; slot_taken reads as the booking race it is", async () => {
    const e = entry({ status: "READY", assignedStaffId: "b1" });
    queueMock.mockResolvedValue(data([e]) as never);
    startMock.mockResolvedValue({ ok: false, error: "slot_taken" });
    render(
      <WalkInQueueBoard staff={staff} walkInEnabled timezone="UTC" toast={toast} />,
    );
    // Remove needs the confirm tap - one tap does nothing destructive.
    fireEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    expect(transitionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /yes, remove/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /keep/i }));
    // The lost race surfaces as plain language, not an error code.
    fireEvent.click(screen.getByRole("button", { name: /start service/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.stringMatching(/just got booked/i),
      ),
    );
  });
});
