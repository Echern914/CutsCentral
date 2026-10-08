import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail, SeriesEditPreview } from "./actions";

/**
 * "EDIT THIS AND FUTURE" in the appointment sheet (SeriesEditView.tsx).
 *
 * Pinned here:
 *  - it is offered only on a confirmed ChairBack visit of a repeat;
 *  - only what differs from this visit is sent;
 *  - every date that would change is shown BEFORE anything is applied, and a
 *    date that cannot take it blocks Apply;
 *  - a refusal because the rows changed, or a tap whose answer was lost, reads
 *    the dates again - it is never re-sent blind;
 *  - two taps send one apply;
 *  - what the synced calendar did not confirm is said, by date;
 *  - the result stays on screen when the agenda refreshes under it;
 *  - the single edit on a repeat says it changes this appointment only.
 */

const previewSeries = vi.hoisted(() => vi.fn());
const applySeries = vi.hoisted(() => vi.fn());
const getDetail = vi.hoisted(() => vi.fn());
const getEditContext = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    data: {
      timezone: "America/New_York",
      services: [
        { id: "svc1", name: "Trim", durationMin: 30 },
        { id: "svc2", name: "Trim and wash", durationMin: 60 },
      ],
      staff: [
        { id: "stf1", name: "Dee" },
        { id: "stf2", name: "Jo" },
      ],
      clients: [],
    },
  })),
);
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: getEditContext,
  previewSeriesEditAction: previewSeries,
  applySeriesEditAction: applySeries,
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-10-22T14:00:00.000Z", // Thu 10:00 in New York
  end: "2026-10-22T14:30:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Trim",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
  seriesId: "ser1",
};

function detailFor(over: Partial<Record<string, unknown>> = {}): AppointmentDetail {
  return {
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "upcoming",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Marcus Reed",
    serviceName: "Trim",
    staffName: "Dee",
    startsAt: row.start,
    endsAt: row.end,
    durationMin: 30,
    timezone: "America/New_York",
    price: 40,
    notes: null,
    addOns: [],
    intake: [],
    contact: { phone: null, phoneDisplay: null, email: null },
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: { state: "unpaid" },
    checkedOutAt: null,
    editable: true,
    readOnlyReason: null,
    externalManageUrl: null,
    ...over,
  } as unknown as AppointmentDetail;
}

/** Two Thursdays moving 10:00 -> 11:00, either side of the clock change. */
const PREVIEW: SeriesEditPreview = {
  digest: "d1gest-one",
  alreadyDone: 0,
  change: [
    {
      id: "appt1",
      from: { startsAt: "2026-10-22T14:00:00.000Z", endsAt: "2026-10-22T14:30:00.000Z", staffId: "stf1", serviceId: "svc1" },
      to: { startsAt: "2026-10-22T15:00:00.000Z", endsAt: "2026-10-22T15:30:00.000Z", staffId: "stf1", serviceId: "svc1" },
    },
    {
      id: "appt2",
      from: { startsAt: "2026-11-05T15:00:00.000Z", endsAt: "2026-11-05T15:30:00.000Z", staffId: "stf1", serviceId: "svc1" },
      to: { startsAt: "2026-11-05T16:00:00.000Z", endsAt: "2026-11-05T16:30:00.000Z", staffId: "stf1", serviceId: "svc1" },
    },
  ],
  skipped: [{ id: "appt3", startsAt: "2026-10-29T14:00:00.000Z", reason: "cancelled" }],
};

const onChanged = vi.fn();

function renderSheet(detail = detailFor(), r: AgendaRow = row) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  return render(<AppointmentSheet row={r} toast={vi.fn()} onClose={vi.fn()} onChanged={onChanged} />);
}

async function openMore() {
  fireEvent.click(await screen.findByRole("button", { name: "More" }, { timeout: 5000 }));
  return screen.findByRole("menu", undefined, { timeout: 5000 });
}

async function openSeriesEdit(detail = detailFor()) {
  const view = renderSheet(detail);
  const menu = await openMore();
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Edit this and future/ }));
  await screen.findByTestId("series-edit-form");
  // The time is seeded once the shop's zone has loaded.
  await waitFor(() => expect((screen.getByLabelText(/Start time/) as HTMLInputElement).value).toBe("10:00"));
  return view;
}

async function reviewElevenAm() {
  fireEvent.change(screen.getByLabelText(/Start time/), { target: { value: "11:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Review dates" }));
  return screen.findByTestId("series-edit-review");
}

beforeEach(() => {
  previewSeries.mockReset();
  applySeries.mockReset();
  onChanged.mockReset();
  previewSeries.mockResolvedValue({ ok: true, data: PREVIEW });
});

describe("where it is offered", () => {
  it("on a confirmed ChairBack visit of a repeat", async () => {
    renderSheet();
    const menu = await openMore();
    expect(within(menu).getByRole("menuitem", { name: /Edit this and future/ })).toBeTruthy();
  });

  it("not on a visit that is not part of a repeat", async () => {
    renderSheet(detailFor(), { ...row, seriesId: null });
    const menu = await openMore();
    expect(within(menu).queryByRole("menuitem", { name: /Edit this and future/ })).toBeNull();
  });

  it("not on a request still waiting, nor on a visit owned by a synced calendar", async () => {
    const first = renderSheet(detailFor({ status: "pending" }), { ...row, status: "pending" });
    expect(within(await openMore()).queryByRole("menuitem", { name: /Edit this and future/ })).toBeNull();
    first.unmount();
    renderSheet(detailFor({ origin: "acuity", originLabel: "Acuity", editable: false }));
    expect(within(await openMore()).queryByRole("menuitem", { name: /Edit this and future/ })).toBeNull();
  });

  it("the single edit on a repeat says it changes this appointment only", async () => {
    renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: /edit appointment/i }));
    expect((await screen.findByTestId("edit-this-only")).textContent).toMatch(/this appointment only/);
  });
});

describe("review before anything changes", () => {
  it("🔴 sends only what changed, and shows every date before applying", async () => {
    await openSeriesEdit();
    expect((screen.getByRole("button", { name: "Review dates" }) as HTMLButtonElement).disabled).toBe(true);
    const review = await reviewElevenAm();
    expect(previewSeries).toHaveBeenCalledWith("ser1", { fromAppointmentId: "appt1", changes: { startMin: 660 } });
    // The same 10 -> 11 on both sides of the clock change, in the shop's zone.
    expect(review.textContent).toContain("Thu, Oct 22");
    expect(review.textContent).toContain("10:00 AM → 11:00 AM");
    expect(review.textContent).toContain("Thu, Nov 5");
    expect(review.textContent).toMatch(/Oct 29.*cancelled/);
    expect(review.textContent).toMatch(/Prices stay as booked/);
    expect(applySeries).not.toHaveBeenCalled();
  });

  it("🔴 a date that cannot take it blocks Apply, and names what is in the way", async () => {
    previewSeries.mockResolvedValue({
      ok: true,
      data: {
        ...PREVIEW,
        change: [PREVIEW.change[0], { ...PREVIEW.change[1]!, problem: { code: "overlap", text: "Overlaps Ana - Trim, 11:00 AM - 11:30 AM" } }],
      },
    });
    await openSeriesEdit();
    await reviewElevenAm();
    expect(screen.getByTestId("series-problem").textContent).toContain("Overlaps Ana");
    const apply = screen.getByRole("button", { name: "Fix the dates above first" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(applySeries).not.toHaveBeenCalled();
  });
});

describe("apply", () => {
  it("applies exactly the reviewed dates and says what happened", async () => {
    applySeries.mockResolvedValue({
      ok: true,
      data: {
        changed: [
          { id: "appt1", startsAt: PREVIEW.change[0]!.to.startsAt, endsAt: PREVIEW.change[0]!.to.endsAt, mirror: "skipped" },
          { id: "appt2", startsAt: PREVIEW.change[1]!.to.startsAt, endsAt: PREVIEW.change[1]!.to.endsAt, mirror: "skipped" },
        ],
        skipped: PREVIEW.skipped,
        clientNotified: true,
      },
    });
    await openSeriesEdit();
    await reviewElevenAm();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 appointments" }));
    const done = await screen.findByTestId("series-edit-done");
    expect(applySeries).toHaveBeenCalledWith("ser1", {
      fromAppointmentId: "appt1",
      changes: { startMin: 660 },
      digest: "d1gest-one",
    });
    expect(done.textContent).toContain("Changed 2 appointments.");
    expect(done.textContent).toMatch(/one email with the new time for the next visit/);
    // 🔴 Not while the result is on screen: re-reading the agenda moves this
    // visit's card to its new slot, which remounts it and closes the sheet.
    expect(onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("🔴 closing the sheet straight from the result still re-reads the calendar, once", async () => {
    applySeries.mockResolvedValue({
      ok: true,
      data: {
        changed: [{ id: "appt1", startsAt: PREVIEW.change[0]!.to.startsAt, endsAt: PREVIEW.change[0]!.to.endsAt, mirror: "skipped" }],
        skipped: [],
      },
    });
    const view = await openSeriesEdit();
    await reviewElevenAm();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 appointments" }));
    await screen.findByTestId("series-edit-done");
    expect(onChanged).not.toHaveBeenCalled();
    view.unmount();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("🔴 two taps send one apply", async () => {
    let finish!: (v: unknown) => void;
    applySeries.mockReturnValue(new Promise((r) => (finish = r)));
    await openSeriesEdit();
    await reviewElevenAm();
    const btn = screen.getByRole("button", { name: "Apply to 2 appointments" });
    // Both taps in ONE batch, before React re-renders: the button is still
    // enabled for the second, so only the in-flight guard can stop it.
    act(() => {
      btn.click();
      btn.click();
    });
    expect(applySeries).toHaveBeenCalledTimes(1);
    finish({ ok: true, data: { changed: [], skipped: [], alreadyApplied: true } });
    expect((await screen.findByTestId("series-edit-done")).textContent).toMatch(/Already done/);
  });

  it("🔴 rows that changed since the review are reviewed again, not re-sent", async () => {
    applySeries.mockResolvedValue({ ok: false, error: "stale_preview" });
    await openSeriesEdit();
    await reviewElevenAm();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 appointments" }));
    expect(await screen.findByText(/changed since you looked/)).toBeTruthy();
    expect(previewSeries).toHaveBeenCalledTimes(2);
    expect(applySeries).toHaveBeenCalledTimes(1);
  });

  it("🔴 a tap whose answer was lost reads the dates again instead of guessing", async () => {
    applySeries.mockRejectedValue(new Error("connection reset"));
    previewSeries
      .mockResolvedValueOnce({ ok: true, data: PREVIEW })
      .mockResolvedValueOnce({ ok: true, data: { ...PREVIEW, change: [], alreadyDone: 2 } });
    await openSeriesEdit();
    await reviewElevenAm();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 appointments" }));
    expect(await screen.findByText(/couldn't confirm that went through/)).toBeTruthy();
    expect(screen.getByTestId("series-edit-review").textContent).toMatch(/already like that/);
    expect(applySeries).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Nothing to apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("something booked on a date since the review: shown by date, nothing moved", async () => {
    applySeries.mockResolvedValue({
      ok: false,
      error: "series_conflict",
      preview: {
        ...PREVIEW,
        change: [PREVIEW.change[0], { ...PREVIEW.change[1]!, problem: { code: "overlap", text: "Overlaps Ana - Trim" } }],
      },
    });
    await openSeriesEdit();
    await reviewElevenAm();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 appointments" }));
    expect(await screen.findByText(/Nothing was moved/)).toBeTruthy();
    expect(screen.getByTestId("series-problem").textContent).toContain("Overlaps Ana");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("🔴 says which dates Acuity has not confirmed, or refused", async () => {
    applySeries.mockResolvedValue({
      ok: true,
      data: {
        changed: [
          { id: "appt1", startsAt: PREVIEW.change[0]!.to.startsAt, endsAt: PREVIEW.change[0]!.to.endsAt, mirror: "unknown" },
          { id: "appt2", startsAt: PREVIEW.change[1]!.to.startsAt, endsAt: PREVIEW.change[1]!.to.endsAt, mirror: "failed" },
        ],
        skipped: [],
      },
    });
    await openSeriesEdit();
    await reviewElevenAm();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 appointments" }));
    const done = await screen.findByTestId("series-edit-done");
    expect(done.textContent).toMatch(/Still confirming with Acuity for Thu, Oct 22/);
    expect(done.textContent).toMatch(/Acuity didn't take the new time for Thu, Nov 5/);
  });

  it("🔴 the result stays on screen when the agenda refreshes under it", async () => {
    applySeries.mockResolvedValue({
      ok: true,
      data: {
        changed: [{ id: "appt1", startsAt: PREVIEW.change[0]!.to.startsAt, endsAt: PREVIEW.change[0]!.to.endsAt, mirror: "skipped" }],
        skipped: [],
      },
    });
    const view = await openSeriesEdit();
    await reviewElevenAm();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 appointments" }));
    await screen.findByTestId("series-edit-done");
    // The calendar re-reads and hands the sheet this visit at its new time.
    view.rerender(
      <AppointmentSheet
        row={{ ...row, start: "2026-10-22T15:00:00.000Z", end: "2026-10-22T15:30:00.000Z" }}
        toast={vi.fn()}
        onClose={vi.fn()}
        onChanged={onChanged}
      />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("series-edit-done").textContent).toContain("Changed 1 appointment.");
  });
});
