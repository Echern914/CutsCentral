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
const resolveAllConflictsAction = vi.hoisted(() => vi.fn());
vi.mock("./conflictActions", () => ({
  listConflictsAction,
  resolveConflictAction,
  resolveAllConflictsAction,
}));

/** When the fake server "read" the list - what resolve-all must send back. */
const AS_OF = "2026-10-05T15:00:00.000Z";

const { ConflictInbox, ConflictTabBadge, useUnresolvedConflictCount } = await import(
  "./ConflictInbox"
);

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
  data: { items, nextCursor: null, unresolvedCount: items.length, asOf: AS_OF, ...over },
});

beforeEach(() => {
  listConflictsAction.mockReset();
  resolveConflictAction.mockReset();
  resolveAllConflictsAction.mockReset();
  listConflictsAction.mockResolvedValue(page([row()]));
  resolveConflictAction.mockResolvedValue({ ok: true, changed: true });
  resolveAllConflictsAction.mockResolvedValue({ ok: true, resolved: 1 });
});

describe("what it says about itself", () => {
  it("🔴 says plainly that resolving changes no booking", async () => {
    render(<ConflictInbox />);
    await screen.findByRole("heading", { name: /double-booked/i });
    expect(
      screen.getByText(/does not cancel, move or refund anything/i),
    ).toBeInTheDocument();
  });

  it("does not claim the payment was captured", async () => {
    render(<ConflictInbox />);
    await screen.findByRole("heading", { name: /double-booked/i });
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

describe("the badge count", () => {
  it("🔴 DECREMENTS IMMEDIATELY on confirm, before the server answers", async () => {
    const onCount = vi.fn();
    listConflictsAction.mockResolvedValue(page([row()], { unresolvedCount: 3 }));
    // Hold the resolve open so the optimistic step can be observed on its own.
    let release!: (v: unknown) => void;
    resolveConflictAction.mockReturnValue(new Promise((r) => (release = r)));

    render(<ConflictInbox onUnresolvedCount={onCount} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(3));
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^mark resolved$/i }));

    // The badge has already moved while the request is still in flight - a
    // badge that lags makes a manager think the click did not land.
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(2));
    release({ ok: true, changed: true });
  });

  it("then RECONCILES with whatever the server says", async () => {
    const onCount = vi.fn();
    listConflictsAction
      .mockResolvedValueOnce(page([row()], { unresolvedCount: 3 }))
      // A teammate resolved two more while this one was in flight.
      .mockResolvedValueOnce(page([], { unresolvedCount: 0 }));
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(3));
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^mark resolved$/i }));
    // Not 2 (the optimistic guess) - the server's number wins.
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0));
  });

  it("🔴 a FAILED resolution puts the count back", async () => {
    const onCount = vi.fn();
    listConflictsAction.mockResolvedValue(page([row()], { unresolvedCount: 3 }));
    resolveConflictAction.mockResolvedValue({ ok: false, error: "failed" });
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(3));
    fireEvent.click(await screen.findByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^mark resolved$/i }));
    // Back to 3, not stuck at the optimistic 2 - a badge one short hides real work.
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(3));
    expect(await screen.findByText(/nothing was changed/i)).toBeInTheDocument();
  });

  it("never publishes a negative count", async () => {
    const onCount = vi.fn();
    // The count and the list disagree (a teammate just resolved it): the
    // optimistic step must floor at zero rather than show "-1".
    listConflictsAction.mockResolvedValue(page([row()], { unresolvedCount: 0 }));
    resolveConflictAction.mockResolvedValue({ ok: true, changed: false });
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    await screen.findByText("Sam");
    fireEvent.click(screen.getByRole("button", { name: /mark resolved/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^mark resolved$/i }));
    await waitFor(() => expect(resolveConflictAction).toHaveBeenCalled());
    for (const call of onCount.mock.calls) expect(call[0]).toBeGreaterThanOrEqual(0);
  });

  it("🔴 ZERO conflicts reports 0, so the badge can hide entirely", async () => {
    const onCount = vi.fn();
    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 0 }));
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(0));
    // And the empty state is reassuring, not an alarm.
    expect(screen.getByText(/nothing to deal with/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("holds no module-level cache - a remount refetches from scratch", async () => {
    // Switching shops redirects to /dashboard, which unmounts this. The count
    // must come from the server on the way back in, never from a stale module
    // variable that would show the previous shop's number.
    listConflictsAction.mockResolvedValue(page([row()], { unresolvedCount: 5 }));
    const first = render(<ConflictInbox />);
    await screen.findByText("Sam");
    first.unmount();
    listConflictsAction.mockClear();
    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 0 }));
    const onCount = vi.fn();
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    await waitFor(() => expect(listConflictsAction).toHaveBeenCalled());
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0));
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

describe("the manager entry point (badge + mount fetch)", () => {
  /**
   * 🔴 THESE ARE ABOUT BEING SEEN AT ALL. Everything else in this file assumes
   * the manager already opened the Conflicts tab. The entry point is what gets
   * them there, and the failure this whole feature exists to fix is a conflict
   * nobody went looking for.
   */
  function Harness() {
    const [count] = useUnresolvedConflictCount();
    // Stands in for the tab strip: the badge renders WITHOUT the inbox being
    // mounted, which is the property under test.
    return (
      <button type="button">
        Conflicts
        <ConflictTabBadge count={count} />
      </button>
    );
  }

  it("🔴 the badge appears WITHOUT the Conflicts tab ever being opened", async () => {
    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 4 }));
    render(<Harness />);
    expect(await screen.findByLabelText("4 unresolved")).toBeInTheDocument();
    // ...and it fetched on mount, cheaply.
    expect(listConflictsAction).toHaveBeenCalledWith({ status: "open", limit: 1 });
  });

  it("🔴 ZERO renders NOTHING - no misleading alert on a healthy shop", async () => {
    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 0 }));
    render(<Harness />);
    await waitFor(() => expect(listConflictsAction).toHaveBeenCalled());
    // A permanent "0" trains people to ignore the tab, and then they miss the 1.
    expect(screen.queryByLabelText(/unresolved/)).toBeNull();
    expect(screen.getByRole("button")).toHaveTextContent(/^Conflicts$/);
  });

  it("a failed count stays silent rather than alarming", async () => {
    listConflictsAction.mockResolvedValue({ ok: false, error: "boom" });
    render(<Harness />);
    await waitFor(() => expect(listConflictsAction).toHaveBeenCalled());
    expect(screen.queryByLabelText(/unresolved/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("🔴 a REMOUNT refetches - the previous shop's count cannot persist", async () => {
    // Switching shops redirects to /dashboard, unmounting this. If the count
    // were cached at module scope, shop B would briefly wear shop A's number.
    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 9 }));
    const first = render(<Harness />);
    expect(await screen.findByLabelText("9 unresolved")).toBeInTheDocument();
    first.unmount();

    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 1 }));
    render(<Harness />);
    expect(await screen.findByLabelText("1 unresolved")).toBeInTheDocument();
    expect(screen.queryByLabelText("9 unresolved")).toBeNull();
  });

  it("the badge is a plain inline span - it wraps with the tab on a phone", async () => {
    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 12 }));
    const { container } = render(<Harness />);
    await screen.findByLabelText("12 unresolved");
    const badge = container.querySelector('[aria-label="12 unresolved"]')!;
    // No fixed width and no absolute positioning: at 390px the tab strip
    // scrolls as one row, and a badge that escaped its button would overlap
    // the next tab.
    expect(badge.className).not.toMatch(/absolute|fixed|w-\[/);
    expect(badge.tagName).toBe("SPAN");
  });
});

describe("vertical vocabulary", () => {
  /**
   * 🔴 THE WORDS COME FROM THE SHOP'S BUSINESS TYPE, NOT FROM THIS FILE. The
   * first version hard-coded "chair" in eight places and shipped that way -
   * the config package's vocabulary lint caught it, but a lint only proves the
   * literal is gone. This proves the replacement is WIRED: a barbershop reads
   * "chairs", and with no provider at all the neutral vocabulary renders
   * complete words rather than blanks.
   */
  it("says chairs for a barbershop and stations by default", async () => {
    const { VocabProvider } = await import("@/components/VocabProvider");
    const { vocabularyFor } = await import("@chairback/config/businessTypes");
    const barbershop = vocabularyFor("barber");
    // Guard the fixture itself: if the id is wrong, fail here, not silently.
    expect(barbershop.stationNounPlural).toBe("chairs");

    const withShop = render(
      <VocabProvider value={barbershop}>
        <ConflictInbox />
      </VocabProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: /double-booked chairs/i }),
    ).toBeInTheDocument();
    withShop.unmount();

    // No provider: the NEUTRAL vocabulary, whatever word it uses - read from
    // the constant rather than guessed, so a copy change there cannot make
    // this test lie about wiring.
    const { NEUTRAL_VOCABULARY } = await import("@chairback/config/businessTypes");
    expect(NEUTRAL_VOCABULARY.stationNounPlural).not.toBe("chairs");
    render(<ConflictInbox />);
    expect(
      await screen.findByRole("heading", {
        name: new RegExp(`double-booked ${NEUTRAL_VOCABULARY.stationNounPlural}`, "i"),
      }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined/);
  });
});

/**
 * RESOLVE ALL - asked for after a shop worked sixteen of these one tap and one
 * confirmation at a time. Same promises as the single button, and it has to
 * send back exactly what the manager was SHOWN: the server refuses to reach
 * past that, in time or in number.
 */
describe("resolve all", () => {
  /** Sixteen open, one page on screen - the real shape of the ask. */
  const sixteen = () =>
    listConflictsAction.mockResolvedValue(page([row()], { unresolvedCount: 16 }));
  const openConfirm = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Resolve all (16)" }));
    return screen.findByRole("dialog", { name: "Resolve all 16?" });
  };

  it("offers the WHOLE open count, not just the rows on this page", async () => {
    sixteen();
    render(<ConflictInbox />);
    expect(await screen.findByRole("button", { name: "Resolve all (16)" })).toBeInTheDocument();
    // An action, not a filter: it must not sit inside the tab strip.
    expect(
      within(screen.getByRole("tablist")).queryByRole("button", { name: /resolve all/i }),
    ).toBeNull();
  });

  it("is not offered when nothing is open, or on the resolved list", async () => {
    listConflictsAction.mockResolvedValue(page([], { unresolvedCount: 0 }));
    const empty = render(<ConflictInbox />);
    await screen.findByText(/nothing to deal with/i);
    expect(screen.queryByRole("button", { name: /resolve all/i })).toBeNull();
    empty.unmount();

    sixteen();
    render(<ConflictInbox />);
    await screen.findByRole("button", { name: "Resolve all (16)" });
    fireEvent.click(screen.getByRole("tab", { name: /resolved/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /resolve all/i })).toBeNull(),
    );
  });

  it("🔴 is deliberate, and its confirmation says what it does NOT do", async () => {
    sixteen();
    render(<ConflictInbox />);
    const dialog = await openConfirm();
    expect(dialog).toHaveTextContent(/not.*cancel, move or refund any booking/i);
    expect(dialog).toHaveTextContent(/doesn.t tell any customer/i);
    // It covers rows not loaded yet - say so, since the manager can't see them.
    expect(dialog).toHaveTextContent(/including any not shown on this page/i);
    expect(resolveAllConflictsAction).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(resolveAllConflictsAction).not.toHaveBeenCalled();
  });

  it("🔴 sends back the list's asOf and the count it showed, with the note", async () => {
    sixteen();
    resolveAllConflictsAction.mockResolvedValue({ ok: true, resolved: 16 });
    render(<ConflictInbox />);
    const dialog = await openConfirm();
    fireEvent.change(within(dialog).getByPlaceholderText(/called everyone/i), {
      target: { value: "Rang all of them" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve all 16" }));
    await waitFor(() =>
      expect(resolveAllConflictsAction).toHaveBeenCalledWith({
        asOf: AS_OF,
        expected: 16,
        note: "Rang all of them",
      }),
    );
    expect(await screen.findByText("Marked 16 resolved. No booking was changed.")).toBeInTheDocument();
    // And the list is re-read, so the screen shows the server's truth.
    await waitFor(() => expect(listConflictsAction).toHaveBeenCalledTimes(2));
  });

  it("drops the badge to zero at once, then takes the server's count", async () => {
    const onCount = vi.fn();
    listConflictsAction
      .mockResolvedValueOnce(page([row()], { unresolvedCount: 16 }))
      // One arrived after the list was read, so it is still open.
      .mockResolvedValueOnce(page([row({ id: "late" })], { unresolvedCount: 1 }));
    let release!: (v: unknown) => void;
    resolveAllConflictsAction.mockReturnValue(new Promise((r) => (release = r)));
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve all 16" }));
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0));
    release({ ok: true, resolved: 16 });
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(1));
  });

  it("🔴 when MORE came in than were shown, says so, puts the count back and re-reads", async () => {
    const onCount = vi.fn();
    sixteen();
    resolveAllConflictsAction.mockResolvedValue({ ok: false, error: "conflicts_changed" });
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve all 16" }));
    expect(await screen.findByText(/new conflicts came in/i)).toHaveTextContent(
      /nothing was changed/i,
    );
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(16));
    await waitFor(() => expect(listConflictsAction).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failure says nothing was changed and keeps the count", async () => {
    const onCount = vi.fn();
    sixteen();
    resolveAllConflictsAction.mockResolvedValue({ ok: false, error: "failed" });
    render(<ConflictInbox onUnresolvedCount={onCount} />);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve all 16" }));
    expect(await screen.findByText("Couldn't mark them resolved. Nothing was changed.")).toBeInTheDocument();
    await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(16));
  });

  it("tells the truth when a teammate had already done them all", async () => {
    sixteen();
    resolveAllConflictsAction.mockResolvedValue({ ok: true, resolved: 0 });
    render(<ConflictInbox />);
    const dialog = await openConfirm();
    fireEvent.click(within(dialog).getByRole("button", { name: "Resolve all 16" }));
    expect(await screen.findByText(/already been resolved by a teammate/i)).toBeInTheDocument();
  });
});
