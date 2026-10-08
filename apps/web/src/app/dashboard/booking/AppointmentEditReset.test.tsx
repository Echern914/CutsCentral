import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * 🔴 EVERY VISIT TO EDIT STARTS FROM THE BOOKING AS IT IS NOW.
 *
 * The edit form's state lives on the sheet and outlives the edit view:
 *  - Cancel only switched the view, so the abandoned change came back and
 *    rode along with the next edit (fix the phone, and the visit moved too);
 *  - a price saved from the sheet's hero left the form on the OLD figure, so
 *    the next "Edit appointment" save wrote it back.
 */

const editAppointment = vi.hoisted(() => vi.fn());
const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: editAppointment,
  getEditContextAction: vi.fn(async () => ({
    ok: true,
    data: {
      timezone: "America/New_York",
      services: [{ id: "svc1", name: "Fade", durationMin: 30 }],
      staff: [{ id: "stf1", name: "Dee" }],
      clients: [],
    },
  })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:30:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
};
const detail = {
  id: "appt1",
  source: "appointment",
  origin: "native",
  originLabel: "ChairBack",
  status: "upcoming",
  checkInStatus: null,
  clientId: "cl1",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  staffName: "Dee",
  startsAt: row.start,
  endsAt: row.end,
  durationMin: 30,
  timezone: "America/New_York",
  price: 40,
  notes: null,
  addOns: [],
  intake: [],
  contact: { phone: "+18455551212", phoneDisplay: "(845) 555-1212", email: "marcus@example.com" },
  sms: { state: "no_consent", consentAt: null },
  history: { previous: [], upcoming: [] },
  payment: { state: "unpaid" },
  checkedOutAt: null,
  editable: true,
  readOnlyReason: null,
  externalManageUrl: null,
} as unknown as AppointmentDetail;

const footer = () => document.querySelector('[data-qa="dialog-footer"]') as HTMLElement;
const duration = () => screen.getByLabelText(/^Duration/) as HTMLInputElement;

async function enterEdit() {
  fireEvent.click(await screen.findByRole("button", { name: /edit appointment/i }));
  await screen.findByLabelText(/^Duration/);
  await screen.findByLabelText("Email");
}

beforeEach(() => {
  editAppointment.mockReset();
  getDetail.mockReset();
  getDetail.mockResolvedValue({ ok: true, data: detail });
});

describe("the edit form starts fresh each time", () => {
  it("🔴 Cancel discards: reopening Edit shows the booking, and Save is off", async () => {
    render(<AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
    await enterEdit();
    fireEvent.change(duration(), { target: { value: "45" } });
    expect(duration().value).toBe("45");
    fireEvent.click(within(footer()).getByRole("button", { name: "Cancel" }));
    await enterEdit();
    expect(duration().value).toBe("30");
    expect((within(footer()).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("🔴 a price changed under the sheet is the new baseline, never written back", async () => {
    const { rerender } = render(
      <AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByRole("button", { name: /edit appointment/i });
    // The hero's "Save price" lands and the agenda re-reads the row at $50.
    rerender(<AppointmentSheet row={{ ...row, price: 50 }} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
    await enterEdit();
    expect((screen.getByLabelText(/^Price/) as HTMLInputElement).value).toBe("50");
    expect((within(footer()).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
