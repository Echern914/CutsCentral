import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DELETING RESOLVED CONFLICTS, AS A MANAGER SEES IT (a barber, 2026-09-29:
 * "all resolved appointments should be able to be deleted").
 *
 *   * only a resolved card has Delete - an open one is dealt with, not deleted;
 *   * it asks first, and the question says no booking changes;
 *   * "Delete all resolved" sends back exactly the count it showed;
 *   * a refusal is read INSIDE the dialog (the page notice sits behind it).
 */
const listConflictsAction = vi.hoisted(() => vi.fn());
const resolveConflictAction = vi.hoisted(() => vi.fn());
const resolveAllConflictsAction = vi.hoisted(() => vi.fn());
const deleteConflictAction = vi.hoisted(() => vi.fn());
const deleteResolvedConflictsAction = vi.hoisted(() => vi.fn());
vi.mock("./conflictActions", () => ({
  listConflictsAction,
  resolveConflictAction,
  resolveAllConflictsAction,
  deleteConflictAction,
  deleteResolvedConflictsAction,
}));

const AS_OF = "2026-10-05T15:00:00.000Z";
const { ConflictInbox } = await import("./ConflictInbox");

const ctx = (id: string) => ({
  id,
  exists: true,
  startsAt: "2026-10-05T14:00:00.000Z",
  endsAt: "2026-10-05T14:30:00.000Z",
  status: "COMPLETED",
});
const row = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  kind: "appointment",
  staffId: "s1",
  staffName: "Sam",
  overlapStart: "2026-10-05T14:00:00.000Z",
  overlapEnd: "2026-10-05T14:30:00.000Z",
  detectedAt: "2026-10-05T14:00:05.000Z",
  source: "walk_in_quick_log",
  receipt: ctx("a1"),
  conflicting: ctx("a2"),
  resolvedAt: null,
  resolvedByName: null,
  resolutionNote: null,
  ...over,
});
const RESOLVED = row({ id: "r1", resolvedAt: "2026-10-05T16:00:00.000Z", resolvedByName: "Drew" });
const OPEN = row({ id: "o1" });

const page = (items: unknown[], counts: { open: number; resolved: number }) => ({
  ok: true,
  data: {
    items,
    nextCursor: null,
    unresolvedCount: counts.open,
    resolvedCount: counts.resolved,
    asOf: AS_OF,
  },
});

beforeEach(() => {
  for (const f of [
    listConflictsAction,
    resolveConflictAction,
    resolveAllConflictsAction,
    deleteConflictAction,
    deleteResolvedConflictsAction,
  ]) {
    f.mockReset();
  }
  listConflictsAction.mockResolvedValue(page([OPEN, RESOLVED], { open: 1, resolved: 1 }));
  deleteConflictAction.mockResolvedValue({ ok: true, changed: true });
  deleteResolvedConflictsAction.mockResolvedValue({ ok: true, deleted: 1 });
});

async function openAll() {
  render(<ConflictInbox />);
  fireEvent.click(await screen.findByRole("tab", { name: "all" }));
  await waitFor(() => expect(listConflictsAction).toHaveBeenLastCalledWith(expect.objectContaining({ status: "all" })));
  await screen.findAllByText("Sam");
}

describe("Delete on a card", () => {
  it("🔴 only a RESOLVED card has it", async () => {
    await openAll();
    const buttons = screen.getAllByRole("button", { name: "Delete" });
    expect(buttons).toHaveLength(1);
    // ...and it sits on the resolved card, next to who resolved it.
    expect(buttons[0]!.closest("li")!.textContent).toContain("Resolved by Drew");
  });

  it("🔴 asks first, says no booking changes, then deletes that one", async () => {
    await openAll();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this conflict?" });
    expect(dialog.textContent).toMatch(/does not cancel, move or refund either booking/i);
    expect(deleteConflictAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteConflictAction).toHaveBeenCalledWith("r1"));
    expect(await screen.findByText("Deleted from the list. No booking was changed.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete this conflict?" })).toBeNull());
  });

  it("🔴 a refusal is read in the dialog, which stays open", async () => {
    deleteConflictAction.mockResolvedValue({ ok: false, error: "network_error" });
    await openAll();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this conflict?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect((await within(dialog).findByTestId("delete-error")).textContent).toMatch(
      /Couldn't delete it\. Nothing was changed/,
    );
    expect(screen.getByRole("dialog", { name: "Delete this conflict?" })).toBeTruthy();
  });

  it("Cancel sends nothing", async () => {
    await openAll();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this conflict?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteConflictAction).not.toHaveBeenCalled();
  });
});

describe("Delete all resolved", () => {
  it("is not offered on the Open list", async () => {
    render(<ConflictInbox />);
    await screen.findAllByText("Sam");
    expect(screen.queryByRole("button", { name: /Delete all resolved/ })).toBeNull();
  });

  it("🔴 sends back exactly the count and time it showed", async () => {
    listConflictsAction.mockResolvedValue(page([RESOLVED], { open: 3, resolved: 7 }));
    await openAll();
    fireEvent.click(screen.getByRole("button", { name: "Delete all resolved (7)" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 7 resolved?" });
    expect(dialog.textContent).toMatch(/Open ones stay/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 7" }));
    await waitFor(() =>
      expect(deleteResolvedConflictsAction).toHaveBeenCalledWith({ asOf: AS_OF, expected: 7 }),
    );
  });

  it("more resolved than shown: says nothing was deleted and reloads", async () => {
    deleteResolvedConflictsAction.mockResolvedValue({ ok: false, error: "conflicts_changed" });
    await openAll();
    const calls = listConflictsAction.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /Delete all resolved/ }));
    const dialog = await screen.findByRole("dialog", { name: /resolved\?/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Delete \d/ }));
    expect(await screen.findByText(/Nothing was deleted/)).toBeTruthy();
    await waitFor(() => expect(listConflictsAction.mock.calls.length).toBeGreaterThan(calls));
  });
});
