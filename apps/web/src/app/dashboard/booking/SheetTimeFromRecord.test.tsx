import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * THE SHEET'S TIME IS THE BOOKING'S OWN, ONCE IT HAS LOADED.
 *
 * An open sheet now follows its booking through calendar refreshes
 * (BookingCalendar's SheetHost). A save that moves the booking beyond the
 * calendar's loaded weeks leaves the sheet holding the last agenda row it had
 * for a moment, so the time it shows comes from the booking's own record, which
 * the sheet re-reads after every change.
 */
const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z", // 10:00 AM in New York
  end: "2026-09-18T14:30:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
} as AgendaRow;

const detailAt = (startsAt: string, endsAt: string | null, source = "appointment") =>
  ({
    id: "appt1",
    source,
    origin: "chairback",
    originLabel: "ChairBack",
    status: "upcoming",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Marcus Reed",
    serviceName: "Fade",
    staffName: "Dee",
    startsAt,
    endsAt,
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
  }) as unknown as AppointmentDetail;

const dialogText = () => (screen.getByRole("dialog").textContent ?? "").replace(/\s+/g, " ");

beforeEach(() => getDetail.mockReset());

describe("the sheet's date and time", () => {
  it("🔴 the booking moved to 3:00 PM on Oct 30: the sheet says so, not the row's 10:00 AM", async () => {
    getDetail.mockResolvedValue({
      ok: true,
      data: detailAt("2026-10-30T19:00:00.000Z", "2026-10-30T19:30:00.000Z"),
    });
    render(<AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(dialogText()).toMatch(/3:00/));
    expect(dialogText()).toMatch(/Oct/);
    expect(dialogText()).not.toMatch(/10:00/);
  });

  it("before the record loads, the row's own time shows", async () => {
    let answer: (v: unknown) => void = () => {};
    getDetail.mockReturnValue(new Promise((r) => (answer = r)));
    const { unmount } = render(
      <AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    try {
      // No record yet, so no shop zone either: the row's time in the device's
      // own zone (CI runs in UTC; a phone in New York reads 10:00 AM).
      const own = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" })
        .format(new Date(row.start))
        .split(/\s/)[0]!;
      expect(dialogText()).toContain(own);
    } finally {
      // Never leave a pending read behind for the next test.
      unmount();
      answer({ ok: false });
    }
  });

  it("a synced visit keeps the row's time (its record is not the calendar's source)", async () => {
    getDetail.mockResolvedValue({ ok: true, data: detailAt("2026-10-30T19:00:00.000Z", null, "visit") });
    render(
      <AppointmentSheet row={{ ...row, source: "visit" } as AgendaRow} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    await waitFor(() => expect(getDetail).toHaveBeenCalled());
    await waitFor(() => expect(dialogText()).toMatch(/Dee/)); // the record has rendered
    expect(dialogText()).toMatch(/10:00/);
  });
});
