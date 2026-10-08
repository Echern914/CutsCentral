import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { NotifyPrefs } from "./types";

/**
 * The "Remind me __ minutes" and travel-buffer boxes.
 *
 * 🔴 They saved on every keystroke with the CLAMPED in-between value: typing
 * 15 into a 5..120 box saved 5 (the clamp of "1") and then 15. Two writes, and
 * for a moment the reminder really was set to 5 minutes. They now save once,
 * when the box is left.
 */

const a = vi.hoisted(() => ({
  saveNotifyPrefsAction: vi.fn(),
  forgetDeviceAction: vi.fn(),
  sendTestNotificationAction: vi.fn(),
  signOutEverywhereAction: vi.fn(),
}));
vi.mock("./actions", () => a);
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { NotificationsCard } = await import("./NotificationsCard");

const PREFS = {
  pushEnabled: true,
  smsEnabled: false,
  smsRemindersEnabled: false,
  emailEnabled: true,
  notifyPhone: null,
  nextUpEnabled: true,
  nextUpLeadMin: 10,
  travelBufferMin: 0,
  dayAheadEnabled: false,
  dayAheadHour: 20,
  newBookingEnabled: true,
  cancelEnabled: true,
} as unknown as NotifyPrefs;

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.saveNotifyPrefsAction.mockResolvedValue({ ok: true });
  toast.mockReset();
});

function minutesBox() {
  render(<NotificationsCard initial={PREFS} devices={[]} shopNotifyPhone={null} />);
  return screen.getByLabelText("Minutes before the appointment") as HTMLInputElement;
}

describe("the reminder minutes box", () => {
  it("🔴 typing 15 saves nothing until the box is left, then saves 15 once", async () => {
    const box = minutesBox();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "1" } });
    fireEvent.change(box, { target: { value: "15" } });
    expect(a.saveNotifyPrefsAction).not.toHaveBeenCalled();
    await act(async () => fireEvent.blur(box));
    expect(a.saveNotifyPrefsAction).toHaveBeenCalledTimes(1);
    expect(a.saveNotifyPrefsAction).toHaveBeenCalledWith({ nextUpLeadMin: 15 });
  });

  it("leaving it unchanged saves nothing", async () => {
    const box = minutesBox();
    fireEvent.focus(box);
    await act(async () => fireEvent.blur(box));
    expect(a.saveNotifyPrefsAction).not.toHaveBeenCalled();
  });

  it("a refused save goes back to the last value the server confirmed", async () => {
    a.saveNotifyPrefsAction.mockResolvedValue({ ok: false });
    const box = minutesBox();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "30" } });
    await act(async () => fireEvent.blur(box));
    expect(toast).toHaveBeenCalledWith("Couldn't save that", "error");
    expect(box.value).toBe("10");
  });
});
