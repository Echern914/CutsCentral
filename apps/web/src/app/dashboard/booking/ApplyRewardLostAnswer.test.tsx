import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";

/**
 * "REWARD READY - APPLY" WHEN THE ANSWER IS LOST.
 *
 * Apply redeems the reward. An Apply whose answer never came back, tapped
 * again, redeemed a second reward off a client holding punches for two. The
 * tap's requestId now survives an unknown outcome (no answer, a 5xx), so the
 * retry is the same redemption; a definite answer settles it.
 */

vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
const applyRewardAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  applyRewardAction,
  getAppointmentDetailAction: vi.fn(async () => ({ ok: false })),
  cancelAppointmentAction: vi.fn(),
  cancelSeriesAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  approveAppointmentAction: vi.fn(),
  declineAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
  sendNudgeAction: vi.fn(),
  grantRewardAction: vi.fn(),
}));

const { AppointmentBlock } = await import("./BookingCalendar");

const row = {
  id: "a1",
  source: "appointment",
  start: "2026-09-25T15:00:00.000Z",
  end: "2026-09-25T15:30:00.000Z",
  clientName: "Sample C",
  clientId: "c1",
  serviceName: "Cut",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
  rewardReady: { rewardId: "r1", rewardName: "Free Cut", punchCost: 5 },
} as unknown as AgendaRow;

const sentId = (n: number) => applyRewardAction.mock.calls[n]![2] as string;

describe("Apply a ready reward, and a lost answer", () => {
  it("🔴 an unknown outcome keeps the tap: Apply again is the same redemption", async () => {
    const toast = vi.fn();
    render(<AppointmentBlock row={row} timeLabel="3:00 – 3:30 PM" toast={toast} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Expand appointment/ }));

    applyRewardAction.mockResolvedValueOnce({ ok: false, error: "failed", answered: false });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("No answer from ChairBack - tap Apply again. It won't apply twice.", "error"),
    );

    applyRewardAction.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applyRewardAction).toHaveBeenCalledTimes(2));

    applyRewardAction.mockResolvedValueOnce({ ok: true, answered: true });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(applyRewardAction).toHaveBeenCalledTimes(3));
    expect(sentId(0)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(sentId(1)).toBe(sentId(0));
    expect(sentId(2)).toBe(sentId(0));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Free Cut applied", "success"));
  });
});
