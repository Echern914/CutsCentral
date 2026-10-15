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

describe("working until midnight", () => {
  it("🔴 an end of midnight can be picked and saves as the end of the day (1440)", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: true, data: WEEK });
    open();
    const friEnd = (await screen.findByRole("combobox", { name: "Fri end" })) as HTMLSelectElement;
    // The last option, after 11:45 PM; "12:00 AM" at the top is the START of a day.
    const last = friEnd.options[friEnd.options.length - 1]!;
    expect(last.textContent).toBe("12:00 AM (midnight)");
    fireEvent.change(friEnd, { target: { value: last.value } });
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(saveAvailabilityAction).toHaveBeenCalledTimes(1));
    const [, rules] = saveAvailabilityAction.mock.calls[0]!;
    expect((rules as { weekday: number; endMin: number }[]).find((r) => r.weekday === 5)!.endMin).toBe(1440);
  });

  it("a saved midnight end reads as midnight, not noon", async () => {
    getAvailabilityAction.mockResolvedValue({
      ok: true,
      data: { ...WEEK, rules: [{ weekday: 6, startMin: 1080, endMin: 1440 }] },
    });
    open();
    const satEnd = (await screen.findByRole("combobox", { name: "Sat end" })) as HTMLSelectElement;
    expect(satEnd.selectedOptions[0]!.textContent).toBe("12:00 AM (midnight)");
  });
});

/**
 * SWITCHING FROM BOOKSY OR THECUT: the week is pasted from the old profile
 * instead of set day by day. Apply only fills the sheet - the barber checks
 * it and taps Save hours, which is still the only thing that saves.
 */
describe("paste hours from another app", () => {
  const value = (name: string) => (screen.getByRole("combobox", { name }) as HTMLSelectElement).value;
  const on = (name: string) => (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;

  async function paste(text: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Paste hours from another app" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Hours to paste" }), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  }

  it("fills the days it reads, turns a split shift's gap into a break, and saves nothing", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: true, data: WEEK });
    open();
    await paste(
      [
        "Monday 9-12, 1-6",
        "Tue-Thu 10am – 7pm",
        "Saturday 10:00 - 16:00",
        "Sunday Closed",
        "Friday by appointment",
      ].join("\n"),
    );

    expect([value("Mon start"), value("Mon end")]).toEqual(["09:00", "18:00"]);
    // Monday's own 12-1 lunch collided with the pasted gap; one break remains.
    expect(screen.getAllByRole("combobox", { name: "Mon break start" }).map((s) => (s as HTMLSelectElement).value)).toEqual([
      "12:00",
    ]);
    for (const d of ["Tue", "Wed", "Thu"]) {
      expect([value(`${d} start`), value(`${d} end`)]).toEqual(["10:00", "19:00"]);
    }
    expect(on("Sat")).toBe(true);
    expect([value("Sat start"), value("Sat end")]).toEqual(["10:00", "16:00"]);
    expect(on("Sun")).toBe(false);
    // Friday's line couldn't be read: Friday is left as it was, and the line is listed.
    expect([value("Fri start"), value("Fri end")]).toEqual(["09:00", "17:00"]);
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toMatch(/Filled in Mon, Tue, Wed, Thu and Sat\./);
    expect(status).toMatch(/Sun set to closed\./);
    expect(status).toMatch(/gap between shifts on Mon is now a break/);
    expect(status).toMatch(/Nothing is saved yet/);
    expect(status).toMatch(/Couldn't read this line/);
    expect(status).toContain("Friday by appointment");

    expect(saveAvailabilityAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(saveAvailabilityAction).toHaveBeenCalledTimes(1));
    const [, rules, breaks] = saveAvailabilityAction.mock.calls[0]!;
    expect(rules).toEqual([
      { weekday: 1, startMin: 540, endMin: 1080 },
      { weekday: 2, startMin: 600, endMin: 1140 },
      { weekday: 3, startMin: 600, endMin: 1140 },
      { weekday: 4, startMin: 600, endMin: 1140 },
      { weekday: 5, startMin: 540, endMin: 1020 },
      { weekday: 6, startMin: 600, endMin: 960 },
    ]);
    expect(breaks).toEqual([{ weekday: 1, startMin: 720, endMin: 780, reason: undefined }]);
  });

  it("keeps the barber's own break when the pasted day still has room for it", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: true, data: WEEK });
    open();
    await paste("Mon 8am-8pm");
    expect([value("Mon start"), value("Mon end")]).toEqual(["08:00", "20:00"]);
    expect(screen.getAllByRole("combobox", { name: "Mon break start" }).map((s) => (s as HTMLSelectElement).value)).toEqual([
      "12:00",
    ]);
  });

  it("says so when nothing in the paste can be read, and changes no day", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: true, data: WEEK });
    open();
    await paste("Call me for hours");
    expect(screen.getByRole("status").textContent).toMatch(/Couldn't read any days from that/);
    expect(screen.getByRole("status").textContent).toContain("Call me for hours");
    expect([value("Mon start"), value("Mon end")]).toEqual(["09:00", "17:00"]);
    expect(screen.getByRole("button", { name: "Saved ✓" })).toBeTruthy();
  });
});
