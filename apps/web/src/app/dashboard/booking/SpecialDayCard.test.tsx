import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";

const listSpecialDaysAction = vi.fn();
const previewSpecialDayAction = vi.fn();
const publishSpecialDayAction = vi.fn();
const removeSpecialDaysAction = vi.fn();
vi.mock("./actions", () => ({
  listSpecialDaysAction: (...a: unknown[]) => listSpecialDaysAction(...a),
  previewSpecialDayAction: (...a: unknown[]) => previewSpecialDayAction(...a),
  publishSpecialDayAction: (...a: unknown[]) => publishSpecialDayAction(...a),
  removeSpecialDaysAction: (...a: unknown[]) => removeSpecialDaysAction(...a),
}));

const { SpecialDayCard } = await import("./SpecialDayCard");

/**
 * The Special day builder (Drick: "make all cuts (20 min long) only on that
 * day and charge $65 all day"). What must not break quietly:
 *   - nothing publishes before the barber has SEEN the openings
 *   - the preview says what was left out and that bookings stay
 *   - a success toast only after the server confirmed
 *   - changing a field after the preview throws the preview away
 */
const staff = [{ id: "st1", name: "Drick", active: true }] as unknown as StaffRow[];
const services = [
  { id: "cut", name: "Cut", active: true, price: 40 },
  { id: "beard", name: "Beard", active: true, price: 25 },
] as unknown as ServiceRow[];

const iso = (hhmm: string) => `2026-11-26T${hhmm}:00.000Z`;
const plan = {
  staffId: "st1",
  openings: [iso("09:00"), iso("09:20"), iso("10:40")],
  skipped: [
    { startsAt: iso("10:00"), reason: "booking" },
    { startsAt: iso("10:20"), reason: "booking" },
  ],
  bookings: [{ startsAt: iso("10:00"), endsAt: iso("10:30") }],
};

function fill() {
  fireEvent.click(screen.getByRole("button", { name: "+ Plan a special day" }));
  fireEvent.change(screen.getByPlaceholderText("Thanksgiving"), { target: { value: "Thanksgiving" } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-26" } });
  fireEvent.change(screen.getByLabelText("Price each"), { target: { value: "65" } });
  fireEvent.click(screen.getByRole("button", { name: "Cut" }));
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-01T12:00:00.000Z"), toFake: ["Date"] });
  listSpecialDaysAction.mockResolvedValue({ ok: true, specialDays: [] });
  previewSpecialDayAction.mockResolvedValue({ ok: true, plans: [plan], bufferMin: 0 });
  publishSpecialDayAction.mockResolvedValue({ ok: true, created: [{ staffId: "st1", openings: 3 }] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Special day builder", () => {
  it("previews first, shows what was left out, then publishes exactly that", async () => {
    const toast = vi.fn();
    render(<SpecialDayCard services={services} staff={staff} timezone="UTC" toast={toast} />);
    await screen.findByText(/None planned/);
    fill();
    // No Publish before a preview exists.
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview openings" }));

    await screen.findByText(/3 openings at \$65/);
    expect(previewSpecialDayAction).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-11-26",
        staffIds: ["st1"],
        start: "09:00",
        end: "17:00",
        cutMin: 20,
        price: 65,
        serviceIds: ["cut"],
        name: "Thanksgiving",
      }),
    );
    expect(screen.getByText(/Left out:/).textContent).toMatch(/already booked/);
    expect(screen.getByText(/They stay booked/)).toBeTruthy();
    expect(publishSpecialDayAction).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Publish 3 openings" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Thanksgiving published: 3 openings/), "success"));
    const sent = publishSpecialDayAction.mock.calls[0]![0];
    expect(sent.expectOpenings).toBe(3);
    expect(sent.requestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("a change after the preview throws the preview away", async () => {
    render(<SpecialDayCard services={services} staff={staff} timezone="UTC" toast={vi.fn()} />);
    await screen.findByText(/None planned/);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Preview openings" }));
    await screen.findByRole("button", { name: "Publish 3 openings" });
    fireEvent.change(screen.getByLabelText("Price each"), { target: { value: "70" } });
    expect(screen.queryByRole("button", { name: /Publish/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview openings" })).toBeTruthy();
  });

  it("a refused publish shows why and claims no success", async () => {
    publishSpecialDayAction.mockResolvedValue({
      ok: false,
      error: "already_exists",
      message: "That chair already has a special day on that date. Remove it first to change it.",
    });
    const toast = vi.fn();
    render(<SpecialDayCard services={services} staff={staff} timezone="UTC" toast={toast} />);
    await screen.findByText(/None planned/);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Preview openings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish 3 openings" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has a special day/);
    expect(toast).not.toHaveBeenCalled();
  });

  it("lists a planned day by its name, and a failed load offers a retry", async () => {
    listSpecialDaysAction.mockResolvedValueOnce({ ok: false });
    const { unmount } = render(<SpecialDayCard services={services} staff={staff} timezone="UTC" toast={vi.fn()} />);
    expect(await screen.findByText(/Couldn.t load your special days/)).toBeTruthy();
    unmount();

    listSpecialDaysAction.mockResolvedValue({
      ok: true,
      specialDays: [
        {
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
        },
      ],
    });
    render(<SpecialDayCard services={services} staff={staff} timezone="UTC" toast={vi.fn()} />);
    expect(await screen.findByText("Thanksgiving")).toBeTruthy();
    expect(screen.getByText(/24 openings · 20 min · \$65 · 3 booked/)).toBeTruthy();
  });
});
