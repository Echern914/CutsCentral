import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BlockDetail } from "./actions";

const a = vi.hoisted(() => ({
  getBlockAction: vi.fn(),
  editBlockAction: vi.fn(),
  removeBlockAction: vi.fn(),
  addBlockAction: vi.fn(),
}));
vi.mock("./actions", () => a);

const { BlockEditSheet } = await import("./BlockEditSheet");

/**
 * A blocked band, opened. What has to hold:
 *  - it says what the block is and the save it came from (barbers, days);
 *  - an edit sends a new day+hours for THIS block, or new hours for the whole
 *    group, as shop-local minutes; a note-only edit sends no time;
 *  - a new time over bookings is refused and confirmable, as a save is;
 *  - 🔴 removing ASKS FIRST, naming exactly what goes;
 *  - the confirm buttons sit side by side on a phone (#635).
 */
const TZ = "America/New_York";
// Wed Sep 9 2099, 12:00-13:00 New York (EDT) = 16:00-17:00Z: far enough ahead
// that the real "today" never passes it, so a moved date is never "past".
const BLOCK: BlockDetail = {
  id: "blk1",
  staffId: "stf1",
  staffName: "Dee",
  startsAt: "2099-09-09T16:00:00.000Z",
  endsAt: "2099-09-09T17:00:00.000Z",
  reason: "Lunch",
  pattern: "weekly",
  groupId: "g1",
  group: {
    count: 4,
    staff: [
      { id: "stf1", name: "Dee" },
      { id: "stf2", name: "Max" },
    ],
    days: ["2099-09-09", "2099-09-16"],
    timesEditable: true,
  },
};

const toast = vi.fn();
const onClose = vi.fn();
const onChanged = vi.fn();

async function open(block: BlockDetail = BLOCK) {
  a.getBlockAction.mockResolvedValue({ ok: true, block, timezone: TZ });
  render(<BlockEditSheet blockId={block.id} onClose={onClose} onChanged={onChanged} toast={toast} />);
  await screen.findByText(/Saved together/);
}
const set = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  a.editBlockAction.mockResolvedValue({ ok: true, created: 1 });
  a.removeBlockAction.mockResolvedValue({ ok: true, removed: 1 });
  toast.mockReset();
  onClose.mockReset();
  onChanged.mockReset();
});

describe("an opened block", () => {
  it("says what it is and the save it came from", async () => {
    await open();
    expect(screen.getByText("Wednesday, September 9, 2099 · 12:00 PM–1:00 PM")).toBeInTheDocument();
    expect(screen.getByText("Dee · Lunch")).toBeInTheDocument();
    expect(document.querySelector('[data-qa="block-group-line"]')).toHaveTextContent(
      "Saved together: 4 blocks · Dee, Max · September 9–16, 2099 · Repeats weekly",
    );
    expect(screen.getByLabelText("Date")).toHaveValue("2099-09-09");
    expect(screen.getByLabelText("From")).toHaveValue("12:00");
    expect(screen.getByLabelText("To")).toHaveValue("13:00");
    expect(screen.getByLabelText("Only you see this")).toHaveValue("Lunch");
  });

  it("moves THIS block to a new day and hours, as shop-local minutes", async () => {
    await open();
    set("Date", "2099-09-10");
    set("From", "14:00");
    set("To", "15:30");
    press("Save changes");
    await waitFor(() => expect(a.editBlockAction).toHaveBeenCalledTimes(1));
    expect(a.editBlockAction).toHaveBeenCalledWith("blk1", {
      scope: "one",
      timing: { kind: "day", date: "2099-09-10", fromMin: 14 * 60, toMin: 15 * 60 + 30 },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith("Block updated", "success");
    expect(onClose).toHaveBeenCalled();
  });

  it("moves the hours of the WHOLE group, each on its own day", async () => {
    await open();
    press("All 4 in this group");
    expect(screen.queryByLabelText("Date")).toBeNull();
    set("From", "12:30");
    set("To", "13:30");
    press("Save all 4");
    await waitFor(() => expect(a.editBlockAction).toHaveBeenCalledTimes(1));
    expect(a.editBlockAction).toHaveBeenCalledWith("blk1", {
      scope: "group",
      timing: { kind: "window", fromMin: 12 * 60 + 30, toMin: 13 * 60 + 30 },
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("4 blocks updated", "success"));
  });

  it("a note-only edit sends no time at all", async () => {
    await open();
    set("Only you see this", "Long lunch");
    press("Save changes");
    await waitFor(() => expect(a.editBlockAction).toHaveBeenCalledTimes(1));
    expect(a.editBlockAction).toHaveBeenCalledWith("blk1", { scope: "one", reason: "Long lunch" });
  });

  it("a continuous absence keeps its group hours locked and says why", async () => {
    await open({ ...BLOCK, pattern: "continuous", group: { ...BLOCK.group, timesEditable: false } });
    press("All 4 in this group");
    expect(screen.queryByLabelText("From")).toBeNull();
    expect(screen.getByText(/its hours change one day at a time/)).toBeInTheDocument();
  });

  it("a new time over bookings is refused, listed, and saved only with that confirmation", async () => {
    a.editBlockAction.mockResolvedValueOnce({
      ok: false,
      error: "appointments_overlap",
      reason: "1 appointment is already booked during this time.",
      conflicts: ["Thu, Sep 10, 2:00 PM–2:30 PM · Marcus Reed · Fade"],
      confirmation: "c0ffee00c0ffee00c0ffee00c0ffee00",
    });
    await open();
    set("From", "13:00");
    set("To", "15:00");
    press("Save changes");
    const banner = await screen.findByRole("alertdialog");
    expect(banner).toHaveTextContent("Marcus Reed");
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(within(banner).getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(a.editBlockAction).toHaveBeenCalledTimes(2));
    expect(a.editBlockAction.mock.calls[1]![1]).toMatchObject({
      scope: "one",
      confirmation: "c0ffee00c0ffee00c0ffee00c0ffee00",
    });
  });

  it("🔴 removing asks first - and Keep it sends nothing", async () => {
    await open();
    press("Remove block");
    const ask = screen.getByRole("alertdialog");
    expect(ask).toHaveTextContent("Remove this block?");
    expect(a.removeBlockAction).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(a.removeBlockAction).not.toHaveBeenCalled();

    press("Remove block");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(a.removeBlockAction).toHaveBeenCalledWith("blk1", "one"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Time unblocked", "success"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("🔴 removing the whole group names how many go", async () => {
    a.removeBlockAction.mockResolvedValueOnce({ ok: true, removed: 4 });
    await open();
    press("All 4 in this group");
    press("Remove all 4");
    const ask = screen.getByRole("alertdialog");
    expect(ask).toHaveTextContent("Remove all 4 blocks in this group?");
    fireEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(a.removeBlockAction).toHaveBeenCalledWith("blk1", "group"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("4 blocks removed", "success"));
  });

  it("🔴 on a phone the confirm buttons share a row at full height, never a squashed column", async () => {
    await open();
    press("Remove block");
    const ask = screen.getByRole("alertdialog");
    const buttons = within(ask).getAllByRole("button");
    const row = buttons[0]!.parentElement!;
    expect(row.className).toContain("flex");
    expect(row.className).not.toContain("flex-col");
    for (const b of buttons) {
      expect(b.className).toContain("min-w-0");
      expect(b.className).toContain("flex-1");
      expect(b.className).toContain("h-11");
    }
    const scope = document.querySelector('[data-qa="block-scope"]')!;
    expect(scope.className).not.toContain("flex-col");
  });

  it("says so when the block cannot be opened", async () => {
    a.getBlockAction.mockResolvedValue({ ok: false, error: "not_found" });
    render(<BlockEditSheet blockId="gone" onClose={onClose} onChanged={onChanged} toast={toast} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open this block");
  });
});
