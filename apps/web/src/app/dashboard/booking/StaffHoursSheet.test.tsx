import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";

/**
 * 🔴 A HOURS SHEET THAT FAILED TO LOAD MUST NOT BE SAVEABLE.
 *
 * A save REPLACES the whole week. When loading the hours failed (a weak
 * signal, a server error), the sheet used to show seven unticked days as if
 * that were the saved week. A barber who "fixed" it by ticking Saturday and
 * tapping Save deleted Monday to Friday and every standing break.
 *
 * Also pinned: a refusal (a day that ends before it starts, or the server
 * saying no) is read inside the sheet above Save. It used to be a toast, which
 * draws beneath the sheet, so on a phone Save looked dead.
 */

const getAvailabilityAction = vi.hoisted(() => vi.fn());
const saveAvailabilityAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  getAvailabilityAction,
  saveAvailabilityAction,
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { StaffHoursSheet } = await import("./BookingManager");

const WEEK = {
  rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1020 })),
  recurringBlocks: [{ weekday: 1, startMin: 720, endMin: 780, reason: "Lunch" }],
  weekdaysWithNoService: [],
};

function open() {
  const toast = vi.fn();
  render(<StaffHoursSheet staffId="s1" staffName="Dee" toast={toast} onClose={vi.fn()} />);
  return { toast };
}

beforeEach(() => {
  getAvailabilityAction.mockReset();
  saveAvailabilityAction.mockReset();
  saveAvailabilityAction.mockResolvedValue({ ok: true });
});

describe("Staff hours sheet", () => {
  it("🔴 a failed load shows no editable week and no Save, and says nothing changed", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: false, error: "network_error" });
    open();
    expect(await screen.findByText(/Couldn't load Dee's hours/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Sat" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save hours|Saved/ })).toBeNull();
    expect(saveAvailabilityAction).not.toHaveBeenCalled();
  });

  it("Try again loads the real week, and only then can it be saved", async () => {
    getAvailabilityAction.mockResolvedValueOnce({ ok: false, error: "network_error" });
    getAvailabilityAction.mockResolvedValueOnce({ ok: true, data: WEEK });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const sat = (await screen.findByRole("checkbox", { name: "Sat" })) as HTMLInputElement;
    expect((screen.getByRole("checkbox", { name: "Mon" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(sat);
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(saveAvailabilityAction).toHaveBeenCalledTimes(1));
    const [, rules, breaks] = saveAvailabilityAction.mock.calls[0]!;
    expect((rules as { weekday: number }[]).map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(breaks).toEqual([{ weekday: 1, startMin: 720, endMin: 780, reason: "Lunch" }]);
  });

  it("🔴 a day that ends before it starts is explained in the sheet, not a hidden toast", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: true, data: WEEK });
    const { toast } = open();
    const monEnd = await screen.findByRole("combobox", { name: "Mon end" });
    fireEvent.change(monEnd, { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Mon: the end time must be after the start time/);
    expect(toast).not.toHaveBeenCalled();
    expect(saveAvailabilityAction).not.toHaveBeenCalled();
  });

  it("🔴 a refused save is explained in the sheet and the edits stay unsaved", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: true, data: WEEK });
    saveAvailabilityAction.mockResolvedValue({ ok: false, error: "api_error" });
    const { toast } = open();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Sat" }));
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't save/);
    expect(toast).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save hours" })).toBeTruthy();
  });
});
