import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SpecialDayRow } from "./actions";
import type { StaffRow } from "./page";

const removeSpecialDaysAction = vi.fn();
vi.mock("./actions", () => ({
  removeSpecialDaysAction: (...a: unknown[]) => removeSpecialDaysAction(...a),
}));

const { SpecialDayCard } = await import("./SpecialDayCard");

/**
 * The Special day card lists what is planned and LEADS INTO THE LIVE VIEW -
 * the same one Holiday pricing opens - so a special day is built and changed
 * in one place. What must not break quietly:
 *   - each planned day opens its live view
 *   - planning a new day asks only for the date, then opens the live view
 *   - remove says what stays booked, and claims success only on the server's ok
 */
const staff = [{ id: "st1", name: "Drick", active: true }] as unknown as StaffRow[];
const iso = (hhmm: string) => `2026-11-26T${hhmm}:00.000Z`;
const row: SpecialDayRow = {
  ruleId: "r1",
  staffId: "st1",
  date: "2026-11-26",
  name: "Thanksgiving",
  price: 65,
  cutMin: 20,
  firstStart: iso("09:00"),
  lastEnd: iso("17:00"),
  openings: 24,
  booked: 3,
  minPrice: 50,
  maxPrice: 80,
};

function card(props: Partial<Parameters<typeof SpecialDayCard>[0]> = {}) {
  const onOpen = vi.fn();
  const toast = vi.fn();
  const onChanged = vi.fn();
  render(
    <SpecialDayCard
      rows={[row]}
      loadFailed={false}
      onReload={vi.fn()}
      staff={staff}
      timezone="UTC"
      toast={toast}
      onOpen={onOpen}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { onOpen, toast, onChanged };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-01T12:00:00.000Z"), toFake: ["Date"] });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Special day card", () => {
  it("lists a planned day with its price range and opens its live view", () => {
    const { onOpen } = card();
    expect(screen.getByText("Thanksgiving")).toBeTruthy();
    expect(screen.getByText(/24 openings · \$50–\$80 · 3 booked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open live view of Thanksgiving/ }));
    expect(onOpen).toHaveBeenCalledWith("2026-11-26", "Thanksgiving");
  });

  it("plans a new day by its date, straight into the live view", () => {
    const { onOpen } = card({ rows: [] });
    expect(screen.getByText(/None planned/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Plan a special day" }));
    const go = screen.getByRole("button", { name: "Open live view" });
    expect(go).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-26" } });
    fireEvent.click(go);
    expect(onOpen).toHaveBeenCalledWith("2026-11-26");
  });

  it("remove keeps booked visits and says so only after the server confirmed", async () => {
    removeSpecialDaysAction.mockResolvedValue({ ok: true, openingsRemoved: 21, bookedKept: 3 });
    const { toast, onChanged } = card();
    fireEvent.click(screen.getByRole("button", { name: /Remove special day on/ }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/3 booked visits stay booked/));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Thanksgiving removed - 3 booked visits kept", "success"));
    expect(removeSpecialDaysAction).toHaveBeenCalledWith(["r1"]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("a refused remove claims nothing; a failed load offers a retry", async () => {
    removeSpecialDaysAction.mockResolvedValue({ ok: false, error: "failed" });
    const { toast, onChanged } = card();
    fireEvent.click(screen.getByRole("button", { name: /Remove special day on/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't remove it - nothing was changed", "error"));
    expect(onChanged).not.toHaveBeenCalled();

    const onReload = vi.fn();
    card({ rows: null, loadFailed: true, onReload });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReload).toHaveBeenCalled();
  });
});
