import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE MANAGER CONFLICT INBOX, AS A MANAGER SEES IT.
 *
 * The API tests prove the data is right. These prove the SCREEN is right, and
 * the things they check are the ones that cause harm when they are wrong:
 *
 *   * a manager must not be able to believe this button reschedules something;
 *   * resolving must be deliberate (a confirmation), not a stray tap;
 *   * the three kinds must be distinguishable, because what you do about a
 *     synced booking differs from what you do about blocked time;
 *   * a deleted booking must render, not blank or crash;
 *   * no customer information may appear here at all;
 *   * it must work at phone width, because the app shell is a WebView.
 */
const listConflictsAction = vi.hoisted(() => vi.fn());
const resolveConflictAction = vi.hoisted(() => vi.fn());
vi.mock("./conflictActions", () => ({ listConflictsAction, resolveConflictAction }));

const { ConflictInbox } = await import("./ConflictInbox");

const row = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  kind: "appointment",
  staffId: "s1",
  staffName: "Sam",
  overlapStart: "2026-10-05T14:00:00.000Z",
  overlapEnd: "2026-10-05T14:30:00.000Z",
  detectedAt: "2026-10-05T14:00:05.000Z",
  source: "walk_in_quick_log",
  receipt: {
    id: "a1",
    exists: true,
    startsAt: "2026-10-05T14:00:00.000Z",
    endsAt: "2026-10-05T14:30:00.000Z",
    status: "COMPLETED",
  },
  conflicting: {
    id: "a2",
    exists: true,
    startsAt: "2026-10-05T13:55:00.000Z",
    endsAt: "2026-10-05T14:25:00.000Z",
    status: "BOOKED",
  },
  resolvedAt: null,
  resolvedByName: null,
  resolutionNote: null,
  ...over,
});

const page = (items: unknown[], over: Record<string, unknown> = {}) => ({
  ok: true,
  data: { items, nextCursor: null, unresolvedCount: items.length, ...over },
});

beforeEach(() => {
  listConflictsAction.mockReset();
  resolveConflictAction.mockReset();
  listConflictsAction.mockResolvedValue(page([row()]));
  resolveConflictAction.mockResolvedValue({ ok: true, changed: true });
});

describe("what it says about itself", () => {
  it("🔴 says plainly that resolving changes no booking", async () => {
    render(<ConflictInbox />);
    await screen.findByText(/double-booked chairs/i);
    expect(
      screen.getByText(/does not cancel, move or refund anything/i),
    ).toBeInTheDocument();
  });

  it("does not claim the payment was captured", async () => {
    render(<ConflictInbox />);
    await screen.findByText(/double-booked chairs/i);
    // Same rule as the walk-in panel: the amount is barber-typed and ChairBack
    // never handled it. "On the books" is the claim it can stand behind.
    expect(document.body.textContent).toMatch(/on the books/i);
    expect(document.body.textContent).not.toMatch(/payment (was )?(saved|captured|processed)/i);
  });
});

describe("the list", () => {
  it("shows the chair, the overlap and how long it is", async () => {
    render(<ConflictInbox />);
    expect(await screen.findByText("Sam")).toBeInTheDocument();
    expect(screen.getByText(/30 min overlap/i)).toBeInTheDocument();
  });

  it("🔴 distinguishes appointment, synced booking and blocked time", async () => {
    listConflictsAction.mockResolvedValue(
      page([
        row({ id: "c1", kind: "appointment" }),
        row({ id: "c2", kind: "visit" }),
        row({ id: "c3", kind: "block" }),
      ]),
    );
    render(<ConflictInbox />);
    // Named in words a barber would use, not the raw enum - and each carries a
    // hint, because what you DO about blocked time is not what you do about a
    // real booking.
    expect(await screen.findByText("Booked appointment")).toBeInTheDocument();
    expect(screen.getByText("Synced booking")).toBeInTheDocument();
    expect(screen.getByText("Blocked time")).toBeInTheDocument();
    expect(screen.getByText(/connected calendar/i)).toBeInTheDocument();
  });

  it("🔴 renders a booking that has since been DELETED", async () => {
    listConflictsAction.mockResolvedValue(
      page([
        row({
          conflicting: { id: "gone", exists: false, startsAt: null, endsAt: null, status: null },
        }),
      ]),
    );
    render(<ConflictInbox />);
    // The conflict outlives the bookings on purpose; a missing reference is a
    // state to render, never a blank row.
    expect(await screen.findByText(/no longer on the calendar/i)).toBeInTheDocument();
    expect(screen.getByText("Sam")).toBeInTheDocument();
  });

  it("🔴 shows NO customer information", async () => {
    render(<ConflictInbox />);
    await screen.findByText("Sam");
    const text = document.body.textContent ?? "";
    // The payload carries none, and the component must not invent a place to
    // put any either. A phone-shaped string here would be a leak.
    expect(text).not.toMatch(/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/);
    expect(text).not.toMatch(/@\w+\.\w+/);
  });

  it("says so when there is nothing to deal with", async () => {
    listConflictsAction.mockResolvedValue(page([]));
    render(<ConflictInbox />);
    expect(await screen.findByText(/nothing to deal with/i)).toBeInTheDocument();
  });

  it("reports the unresolved count to its parent, for the tab badge", async () => {
    const onCount = vi.fn();
    listConflictsAction.mockResolvedValue(page([row(), row({ id: "c2" })], { unresolvedCount: 7 }));
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(7));
  });
});

describe("pagination", () => {
  it("loads more and appends without repeating a row", async () => {
    listConflictsAction
      .mockResolvedValueOnce(
        page([row({ id: "c1" })], { nextCursor: { detectedAt: "x", id: "c1" } }),
      )
      // The second page repeats c1 (it could, if something resolved between
      // pages) and adds c2. Only c2 should be appended.
      .mockResolvedValueOnce(page([row({ id: "c1" }), row({ id: "c2" })]));
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /load more/i }));
    await waitFor(() => expect(screen.getAllByText("Sam")).toHaveLength(2));
  });

  it("hides Load more on the last page", async () => {
    render(<ConflictInbox />);
    await screen.findByText("Sam");
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });
});

describe("marking resolved", () => {
  it("🔴 REQUIRES CONFIRMATION - one tap does not resolve anything", async () => {
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    // The dialog is up and nothing has been sent yet.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(resolveConflictAction).not.toHaveBeenCalled();
  });

  it("🔴 the confirmation spends its words on what this does NOT do", async () => {
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/not.*cancel, move or refund/i);
    expect(dialog).toHaveTextContent(/doesn.t tell the customer/i);
  });

  it("sends the note and says no booking changed", async () => {
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/called the client/i), {
      target: { value: "Rang them, moved to 3pm" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^mark resolved$/i }));
    await waitFor(() =>
      expect(resolveConflictAction).toHaveBeenCalledWith("c1", "Rang them, moved to 3pm"),
    );
    expect(await screen.findByText(/no booking was changed/i)).toBeInTheDocument();
  });

  it("cancelling sends nothing", async () => {
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(resolveConflictAction).not.toHaveBeenCalled();
  });

  it("🔴 tells the truth when SOMEBODY ELSE already resolved it", async () => {
    resolveConflictAction.mockResolvedValue({
      ok: true,
      changed: false,
      resolvedByName: "Dana",
    });
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^mark resolved$/i }));
    // Not "you resolved this" - the audit trail names Dana, and the UI must
    // match it rather than flatter the person who clicked second.
    expect(await screen.findByText(/already resolved by dana/i)).toBeInTheDocument();
  });

  it("a failure says nothing was changed", async () => {
    resolveConflictAction.mockResolvedValue({ ok: false, error: "failed" });
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^mark resolved$/i }));
    expect(await screen.findByText(/nothing was changed/i)).toBeInTheDocument();
  });
});

describe("audit fields", () => {
  it("a resolved row shows who did it and what they wrote, and offers no button", async () => {
    listConflictsAction.mockResolvedValue(
      page([
        row({
          resolvedAt: "2026-10-05T15:00:00.000Z",
          resolvedByName: "Dana",
          resolutionNote: "Called the client",
        }),
      ]),
    );
    render(<ConflictInbox />);
    expect(await screen.findByText(/resolved by dana/i)).toBeInTheDocument();
    expect(screen.getByText(/called the client/i)).toBeInTheDocument();
    // Resolved rows stay in the list - auditable, never deleted - but cannot
    // be resolved again.
    expect(screen.queryByRole("button", { name: /^mark resolved$/i })).toBeNull();
  });

  it("can switch to the resolved and all filters", async () => {
    render(<ConflictInbox />);
    await screen.findByText("Sam");
    fireEvent.click(screen.getByRole("tab", { name: /resolved/i }));
    await waitFor(() =>
      expect(listConflictsAction).toHaveBeenCalledWith(
        expect.objectContaining({ status: "resolved" }),
      ),
    );
  });
});

describe("phone width (the app is a WebView)", () => {
  it("nothing forces the row wider than a phone", async () => {
    listConflictsAction.mockResolvedValue(
      page([row({ staffName: "A barber with a very long name indeed" })]),
    );
    const { container } = render(<ConflictInbox />);
    await screen.findByText(/a barber with a very long name/i);
    // 🔴 The two traps that actually bite here: a grid cell with no min-w-0
    // refuses to shrink below its content, and a header row that cannot wrap
    // pushes the card sideways. Both are asserted structurally because jsdom
    // has no layout engine to measure.
    expect(container.querySelector(".min-w-0")).toBeTruthy();
    expect(container.querySelector(".flex-wrap")).toBeTruthy();
    expect(container.querySelector(".break-words")).toBeTruthy();
    // The filter strip scrolls rather than overflowing the viewport.
    expect(container.querySelector(".overflow-x-auto")).toBeTruthy();
  });

  it("the note field is 16px, so iOS does not zoom on focus", async () => {
    render(<ConflictInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByPlaceholderText(/called the client/i);
    expect(input.className).toMatch(/\btext-base\b/);
  });
});
