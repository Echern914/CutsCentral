import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * A team member's own time off.
 *
 * Pinned: time the shop blocked for several people is shown and cannot be
 * removed from here; a block over one of their bookings names the booking and
 * is only saved once they confirm; and that confirmation is the SAME save
 * retried, so it is never written twice.
 */

const actions = vi.hoisted(() => ({
  addOwnTimeOffAction: vi.fn(),
  getOwnHoursAction: vi.fn(),
  removeOwnTimeOffAction: vi.fn(),
}));
vi.mock("./barberCalendarActions", () => actions);

const { BarberTimeOffSheet } = await import("./BarberTimeOffSheet");

const DAY = "2026-11-24";

const off = (over: Record<string, unknown> = {}) => ({
  id: "x1",
  startsAt: `${DAY}T13:00:00.000Z`,
  endsAt: `${DAY}T14:00:00.000Z`,
  isBlock: true,
  reason: "Dentist",
  shared: false,
  ...over,
});

function open(exceptions: ReturnType<typeof off>[] = []) {
  actions.getOwnHoursAction.mockResolvedValue({
    ok: true,
    data: { rules: [], recurringBlocks: [], exceptions, timezone: "UTC" },
  });
  const onChanged = vi.fn();
  render(
    <BarberTimeOffSheet timezone="UTC" startDay={DAY} today="2026-11-20" onClose={vi.fn()} onChanged={onChanged} />,
  );
  return { onChanged };
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.addOwnTimeOffAction.mockResolvedValue({ ok: true });
  actions.removeOwnTimeOffAction.mockResolvedValue({ ok: true });
});

describe("Time off", () => {
  it("lists what is coming up, in the shop's time", async () => {
    open([
      off(),
      off({ id: "x2", startsAt: "2026-12-01T00:00:00.000Z", endsAt: "2026-12-04T00:00:00.000Z", reason: null }),
    ]);
    expect(await screen.findByText("Tue, Nov 24 · 1:00 PM to 2:00 PM")).toBeTruthy();
    expect(screen.getByText("Tue, Dec 1 to Thu, Dec 3")).toBeTruthy();
  });

  it("🔴 time the shop blocked is shown and has no Remove", async () => {
    open([off({ id: "shop1", shared: true, reason: "Shop closed" }), off({ id: "mine" })]);
    await screen.findByText(/Set by the shop/);
    const removes = screen.getAllByRole("button", { name: /^Remove time off/ });
    expect(removes).toHaveLength(1);
  });

  it("blocks a whole day and says so in the dialog", async () => {
    const { onChanged } = open();
    await screen.findByText("No time off coming up.");
    fireEvent.click(screen.getByRole("button", { name: "Block this time" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Time off added");
    expect(onChanged).toHaveBeenCalled();
    const sent = actions.addOwnTimeOffAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ fromDate: DAY, toDate: DAY });
    expect(sent).not.toHaveProperty("fromMin");
    // 🔴 Never whose calendar, and never which services: both are the server's.
    expect(Object.keys(sent).sort()).toEqual(["fromDate", "requestId", "toDate"]);
  });

  it("sends the hours when it is not all day, and refuses an end before the start", async () => {
    open();
    await screen.findByText("No time off coming up.");
    fireEvent.click(screen.getByLabelText("All day"));
    fireEvent.change(screen.getByLabelText("Time off starts"), { target: { value: "15:00" } });
    fireEvent.change(screen.getByLabelText("Time off ends"), { target: { value: "14:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Block this time" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The end time has to be after the start time.");
    expect(actions.addOwnTimeOffAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Time off ends"), { target: { value: "17:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Block this time" }));
    await screen.findByRole("status");
    expect(actions.addOwnTimeOffAction.mock.calls[0]![0]).toMatchObject({ fromMin: 900, toMin: 1020 });
  });

  it("🔴 a booking in the way is named, and blocking anyway is the same save confirmed", async () => {
    actions.addOwnTimeOffAction
      .mockResolvedValueOnce({
        ok: false,
        error: "appointments_overlap",
        conflicts: ["Tue 10:00 AM · Jordan P · Trim"],
        confirmation: "digest-1",
      })
      .mockResolvedValueOnce({ ok: true });
    open();
    await screen.findByText("No time off coming up.");
    fireEvent.click(screen.getByRole("button", { name: "Block this time" }));

    expect(await screen.findByText("Tue 10:00 AM · Jordan P · Trim")).toBeTruthy();
    expect(screen.getByText(/does not cancel or move it/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Block the time anyway" }));
    await screen.findByRole("status");
    const [first, second] = actions.addOwnTimeOffAction.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(second!.confirmation).toBe("digest-1");
    expect(second!.requestId).toBe(first!.requestId);
  });

  it("changing the form after a refusal drops the old confirmation", async () => {
    actions.addOwnTimeOffAction.mockResolvedValueOnce({
      ok: false,
      error: "appointments_overlap",
      conflicts: ["Tue 10:00 AM · Jordan P · Trim"],
      confirmation: "digest-1",
    });
    open();
    await screen.findByText("No time off coming up.");
    fireEvent.click(screen.getByRole("button", { name: "Block this time" }));
    await screen.findByRole("button", { name: "Block the time anyway" });

    fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2026-11-25" } });
    fireEvent.click(screen.getByRole("button", { name: "Block this time" }));
    await waitFor(() => expect(actions.addOwnTimeOffAction).toHaveBeenCalledTimes(2));
    expect(actions.addOwnTimeOffAction.mock.calls[1]![0]).not.toHaveProperty("confirmation");
  });

  it("removes one of their own, and says so when it could not", async () => {
    actions.removeOwnTimeOffAction
      .mockResolvedValueOnce({ ok: false, error: "network_error" })
      .mockResolvedValueOnce({ ok: true });
    const { onChanged } = open([off()]);
    const remove = await screen.findByRole("button", { name: /^Remove time off/ });

    fireEvent.click(remove);
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't remove it. Try again.");
    expect(screen.getByText("Tue, Nov 24 · 1:00 PM to 2:00 PM")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Remove time off/ }));
    await waitFor(() => expect(screen.queryByText("Tue, Nov 24 · 1:00 PM to 2:00 PM")).toBeNull());
    expect(actions.removeOwnTimeOffAction).toHaveBeenCalledWith("x1");
    expect(onChanged).toHaveBeenCalled();
  });
});
