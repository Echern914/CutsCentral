import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { StaffRow } from "./page";

/**
 * Setting up more than one person (Calendar → Staff).
 *
 *  - "Copy hours from" fills this person's week from someone else's and saves
 *    NOTHING: a shop whose people keep the same week sets it once. It is not
 *    offered where there is nobody to copy from, so a one-person shop's sheet
 *    is the sheet it always was;
 *  - a person's name and photo can be changed. Before, a name typed wrong at
 *    setup could only be fixed by removing them, which throws their hours away.
 */
const a = vi.hoisted(() => ({
  getAvailabilityAction: vi.fn(),
  saveAvailabilityAction: vi.fn(),
  updateStaffAction: vi.fn(),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  ...a,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/booking",
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { StaffHoursSheet, StaffTab } = await import("./BookingManager");

const EMPTY = { rules: [], recurringBlocks: [], weekdaysWithNoService: [] };
const KAI_WEEK = {
  rules: [2, 3, 4].map((weekday) => ({ weekday, startMin: 600, endMin: 1080 })),
  recurringBlocks: [{ weekday: 3, startMin: 780, endMin: 840, reason: "Lunch" }],
  weekdaysWithNoService: [],
};
const person = (id: string, name: string, over: Partial<StaffRow> = {}): StaffRow => ({
  id,
  name,
  bio: null,
  imageUrl: null,
  active: true,
  sortOrder: 0,
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.saveAvailabilityAction.mockResolvedValue({ ok: true });
  a.updateStaffAction.mockResolvedValue({ ok: true });
});

describe("copy hours from someone else", () => {
  const others = [{ id: "kai", name: "Kai" }];
  const openSheet = (copyFrom?: { id: string; name: string }[]) =>
    render(<StaffHoursSheet staffId="dee" staffName="Dee" copyFrom={copyFrom} toast={vi.fn()} onClose={vi.fn()} />);
  const byWho = (dee: unknown, kai: unknown) =>
    a.getAvailabilityAction.mockImplementation(async (id: string) => (id === "kai" ? kai : dee));

  it("🔴 fills the week, breaks included, and saves nothing until Save hours", async () => {
    byWho({ ok: true, data: EMPTY }, { ok: true, data: KAI_WEEK });
    openSheet(others);
    const pick = await screen.findByRole("combobox", { name: "Copy hours from someone else" });
    await act(async () => {
      fireEvent.change(pick, { target: { value: "kai" } });
    });
    expect(await screen.findByText(/Copied Kai's hours and breaks\. Nothing is saved yet/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Tue" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Mon" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("combobox", { name: "Tue start" }) as HTMLSelectElement).value).toBe("10:00");
    expect(a.saveAvailabilityAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save hours" }));
    await waitFor(() => expect(a.saveAvailabilityAction).toHaveBeenCalledTimes(1));
    const [who, rules, breaks] = a.saveAvailabilityAction.mock.calls[0]!;
    // Saved onto Dee, never back onto the person copied from.
    expect(who).toBe("dee");
    expect(rules).toEqual(KAI_WEEK.rules);
    expect(breaks).toEqual(KAI_WEEK.recurringBlocks);
  });

  it("🔴 someone with no hours, or a load that fails, changes nothing here and says why", async () => {
    const DEE_WEEK = { rules: [{ weekday: 1, startMin: 540, endMin: 1020 }], recurringBlocks: [], weekdaysWithNoService: [] };
    byWho({ ok: true, data: DEE_WEEK }, { ok: true, data: EMPTY });
    openSheet(others);
    const pick = await screen.findByRole("combobox", { name: "Copy hours from someone else" });
    await act(async () => {
      fireEvent.change(pick, { target: { value: "kai" } });
    });
    expect(await screen.findByText(/Kai has no hours yet/)).toBeTruthy();
    // Dee's own Monday is still there: an empty week was not copied over it.
    expect((screen.getByRole("checkbox", { name: "Mon" }) as HTMLInputElement).checked).toBe(true);

    byWho({ ok: true, data: DEE_WEEK }, { ok: false, error: "network_error" });
    await act(async () => {
      fireEvent.change(pick, { target: { value: "kai" } });
    });
    expect(await screen.findByText(/Couldn't load Kai's hours\. Nothing here has changed/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Mon" }) as HTMLInputElement).checked).toBe(true);
  });

  it("🔴 nobody to copy from: no control at all (a one-person shop's sheet is unchanged)", async () => {
    a.getAvailabilityAction.mockResolvedValue({ ok: true, data: EMPTY });
    openSheet();
    await screen.findByRole("checkbox", { name: "Mon" });
    expect(screen.queryByRole("combobox", { name: "Copy hours from someone else" })).toBeNull();
  });

  it("the Staff tab offers everyone else, never the person themselves", async () => {
    a.getAvailabilityAction.mockResolvedValue({ ok: true, data: EMPTY });
    render(<StaffTab initial={[person("dee", "Dee"), person("kai", "Kai"), person("old", "Gone", { active: false })]} toast={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Hours" })[0]!);
    const pick = (await screen.findByRole("combobox", { name: "Copy hours from someone else" })) as HTMLSelectElement;
    expect(Array.from(pick.options).map((o) => o.textContent)).toEqual(["Copy hours from…", "Kai"]);
  });
});

describe("a person's name and photo", () => {
  it("🔴 Edit saves the new name once, however fast the taps", async () => {
    let answer!: (v: unknown) => void;
    a.updateStaffAction.mockReturnValue(new Promise((r) => (answer = r)));
    const toast = vi.fn();
    render(<StaffTab initial={[person("dee", "New provider")]} toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit New provider" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "  Dee Fields " } });
    const save = screen.getByRole("button", { name: "Save" });
    await act(async () => {
      save.click();
      save.click();
    });
    expect(a.updateStaffAction).toHaveBeenCalledTimes(1);
    expect(a.updateStaffAction).toHaveBeenCalledWith("dee", { name: "Dee Fields", imageUrl: "" });
    await act(async () => answer({ ok: true }));
    expect(toast).toHaveBeenCalledWith("Saved", "success");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("🔴 a refused save is said inside the sheet, and the typing stays", async () => {
    a.updateStaffAction.mockResolvedValue({ ok: false, error: "api_error" });
    const toast = vi.fn();
    render(<StaffTab initial={[person("dee", "Dee")]} toast={toast} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dee" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Deandra" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't save\. Your changes are still here/);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Deandra");
    expect(toast).not.toHaveBeenCalled();
  });

  it("a blank name is refused before anything is sent", async () => {
    render(<StaffTab initial={[person("dee", "Dee")]} toast={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dee" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "   " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/Add a name/);
    expect(a.updateStaffAction).not.toHaveBeenCalled();
  });
});
