import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * THE TIP ROW, directly under Price on the appointment sheet.
 *
 *  - it shows every tip the visit collected (the server's figure), or
 *    "None yet";
 *  - Add / Edit records a tip the barber was HANDED (cash, another app) - a
 *    record, never a charge - and its outcome lands in the sheet's footer,
 *    never a toast a phone cannot see;
 *  - one tap sends one request: a second tap while the first is in flight
 *    sends nothing.
 */

const unpaid = {
  state: "unpaid",
  totalCents: 6000,
  collectedCents: 0,
  onlineCents: 0,
  inPersonCents: 0,
  refundedCents: 0,
  authorizedCents: 0,
  remainingCents: 6000,
  method: null,
  card: null,
  receiptUrl: null,
} as unknown as AppointmentDetail["payment"];

type Tips = NonNullable<AppointmentDetail["tips"]>;
const noTips: Tips = { totalCents: 0, onlineCents: 0, recordedCents: 0, recordedMethod: null, recordable: true };

const detailFor = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "upcoming",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Sample Client",
    serviceName: "Standard visit",
    staffName: "Sam",
    startsAt: "2026-09-18T14:00:00.000Z",
    endsAt: "2026-09-18T14:30:00.000Z",
    durationMin: 30,
    timezone: "America/New_York",
    price: 60,
    notes: null,
    addOns: [],
    intake: [],
    contact: { phone: null, phoneDisplay: null, email: null },
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: unpaid,
    keptDeposit: null,
    tip: null,
    tips: noTips,
    checkedOutAt: null,
    serviceCheckoutEnabled: false,
    editable: true,
    readOnlyReason: null,
    externalManageUrl: null,
    ...over,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const recordTip = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  recordTipAction: recordTip,
  refundDepositAction: vi.fn(),
  refundTipAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
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

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:30:00.000Z",
  clientName: "Sample Client",
  serviceName: "Standard visit",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 60,
  status: "upcoming",
};

const toast = vi.fn();
const onChanged = vi.fn();

async function open(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={toast} onClose={vi.fn()} onChanged={onChanged} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
}

/** The <div> one Fact renders, found by its label. */
function fact(label: string): HTMLElement {
  const dt = screen.getAllByText(label).find((el) => el.closest("dt"));
  if (!dt) throw new Error(`no fact "${label}"`);
  return dt.closest("div") as HTMLElement;
}

beforeEach(() => {
  cleanup();
  getDetail.mockReset();
  recordTip.mockReset();
  toast.mockReset();
  onChanged.mockReset();
});

describe("the Tip row", () => {
  it("🔴 sits directly under Price, and says None yet when there is no tip", async () => {
    await open(detailFor());
    await screen.findByText("None yet");
    const price = fact("Price");
    const tip = fact("Tip");
    // The very next fact after Price.
    expect(price.nextElementSibling).toBe(tip);
    expect(within(tip).getByText("None yet")).toBeTruthy();
    expect(within(tip).getByRole("button", { name: "Add a tip you received" }).textContent).toBe("Add");
  });

  it("shows the server's total and where it came from; Edit when a tip was recorded", async () => {
    await open(
      detailFor({ tips: { totalCents: 1000, onlineCents: 0, recordedCents: 1000, recordedMethod: "cash", recordable: true } }),
    );
    const tip = fact("Tip");
    await waitFor(() => expect(within(tip).getByText("$10.00")).toBeTruthy());
    expect(tip.textContent).toContain("Cash");
    expect(within(tip).getByRole("button", { name: "Edit recorded tip" }).textContent).toBe("Edit");

    cleanup();
    await open(
      detailFor({ tips: { totalCents: 1300, onlineCents: 800, recordedCents: 500, recordedMethod: "other", recordable: true } }),
    );
    const both = fact("Tip");
    expect(within(both).getByText("$13.00")).toBeTruthy();
    expect(both.textContent).toContain("online + other app");
  });

  it("no Add where the server would refuse it, and no row at all from an API that predates it", async () => {
    await open(detailFor({ status: "canceled", tips: { ...noTips, recordable: false } } as Partial<AppointmentDetail>));
    const tip = fact("Tip");
    expect(within(tip).getByText("None yet")).toBeTruthy();
    expect(within(tip).queryByRole("button")).toBeNull();

    cleanup();
    await open(detailFor({ tips: undefined }));
    await screen.findByText("Price");
    expect(screen.queryByText("None yet")).toBeNull();
  });

  it("🔴 records a tip you were handed - outcome in the footer, never a toast", async () => {
    await open(detailFor());
    recordTip.mockResolvedValue({ ok: true });
    getDetail.mockResolvedValue({
      ok: true,
      data: detailFor({ tips: { totalCents: 1250, onlineCents: 0, recordedCents: 1250, recordedMethod: "other", recordable: true } }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Add a tip you received" }));
    expect(screen.getByText(/Nothing is charged to a card/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Tip in dollars"), { target: { value: "12.50" } });
    fireEvent.click(screen.getByRole("radio", { name: "Other app" }));
    fireEvent.click(screen.getByRole("button", { name: "Save tip" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Tip recorded: $12.50 · Other app. No card was charged.",
    );
    expect(recordTip).toHaveBeenCalledTimes(1);
    expect(recordTip).toHaveBeenCalledWith("appt1", { amountCents: 1250, method: "other", expectedCents: null });
    expect(toast).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    // The editor closed and the row now reads the server's new figure.
    await waitFor(() => expect(within(fact("Tip")).getByText("$12.50")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Save tip" })).toBeNull();
  });

  it("Edit starts from the recorded tip and sends the figure it showed; Remove takes it off", async () => {
    const recorded = { totalCents: 500, onlineCents: 0, recordedCents: 500, recordedMethod: "cash", recordable: true };
    await open(detailFor({ tips: recorded }));
    recordTip.mockResolvedValue({ ok: true });

    fireEvent.click(await screen.findByRole("button", { name: "Edit recorded tip" }));
    const input = screen.getByLabelText("Tip in dollars") as HTMLInputElement;
    expect(input.value).toBe("5.00");
    expect(screen.getByRole("radio", { name: "Cash" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tip" }));
    await waitFor(() =>
      expect(recordTip).toHaveBeenCalledWith("appt1", { amountCents: 800, method: "cash", expectedCents: 500 }),
    );

    cleanup();
    recordTip.mockReset();
    recordTip.mockResolvedValue({ ok: true });
    await open(detailFor({ tips: recorded }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit recorded tip" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove tip" }));
    expect((await screen.findByRole("status")).textContent).toBe("Recorded tip removed.");
    expect(recordTip).toHaveBeenCalledWith("appt1", { amountCents: null, expectedCents: 500 });
  });

  it("🔴 a double tap sends ONE request", async () => {
    await open(detailFor());
    let answer!: (v: { ok: boolean }) => void;
    recordTip.mockImplementation(() => new Promise((r) => (answer = r)));

    fireEvent.click(await screen.findByRole("button", { name: "Add a tip you received" }));
    const input = screen.getByLabelText("Tip in dollars");
    fireEvent.change(input, { target: { value: "10" } });
    const save = screen.getByRole("button", { name: "Save tip" });
    // Three presses in the same tick, before React has re-rendered the button
    // as disabled - the case a `pending` flag cannot catch.
    act(() => {
      save.click();
      save.click();
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(recordTip).toHaveBeenCalledTimes(1);

    await act(async () => answer({ ok: true }));
    expect((await screen.findByRole("status")).textContent).toContain("Tip recorded: $10.00");
    expect(recordTip).toHaveBeenCalledTimes(1);
  });

  it("a bad amount is caught before anything is sent; a refusal stays inline in the editor", async () => {
    await open(detailFor());
    fireEvent.click(await screen.findByRole("button", { name: "Add a tip you received" }));
    const input = screen.getByLabelText("Tip in dollars");
    for (const bad of ["", "0", "abc", "12.345", "600"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "Save tip" }));
      expect(screen.getByRole("alert").textContent, bad).toContain("Enter a tip from $0.01 to $500.00");
    }
    expect(recordTip).not.toHaveBeenCalled();

    recordTip.mockResolvedValue({ ok: false, error: "not_tippable" });
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save tip" }));
    expect((await screen.findByRole("alert")).textContent).toContain("can't take a tip");
    // Still open, nothing claimed in the footer, no toast.
    expect(screen.getByRole("button", { name: "Save tip" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
