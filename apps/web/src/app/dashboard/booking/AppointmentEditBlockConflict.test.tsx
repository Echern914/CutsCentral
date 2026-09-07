import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

const editAppointment = vi.hoisted(() =>
  vi.fn(async (_id: string, _patch: Record<string, unknown>) => ({ ok: true }) as EditReply),
);
const getEditContext = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    data: {
      timezone: "America/New_York",
      services: [{ id: "svc1", name: "Fade", durationMin: 30 }],
      staff: [{ id: "stf1", name: "Dee" }],
      clients: [],
    },
  })),
);
vi.mock("./actions", () => ({
  editAppointmentAction: editAppointment,
  getEditContextAction: getEditContext,
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentEditFields, useAppointmentEdit } = await import("./AppointmentEditForm");

interface EditReply {
  ok: boolean;
  error?: string;
  reason?: string;
  confirmation?: string;
  status?: string;
  mirror?: string;
}

/**
 * MOVING A BOOKING ONTO TIME THE BARBER BLOCKED IN ACUITY.
 *
 * The sheet has no "Custom time" switch, so this refusal used to be the end of
 * the road: a flat "that time is outside your booking hours" - which was not
 * what happened - and the only way through was to delete the booking and
 * rebuild it in the New appointment form. Now the server names the block and
 * the sheet lets him answer it. What that has to guarantee:
 *
 *  - the block is shown in the SERVER's words, not replacement copy;
 *  - every field he typed survives the refusal;
 *  - nothing is written until he confirms;
 *  - confirming sends back the digest that came with THAT refusal;
 *  - two clicks are one save;
 *  - a conflict that CHANGED needs a fresh confirmation;
 *  - a different failure replaces the banner with the real answer and keeps
 *    the sheet open;
 *  - the calendar refreshes exactly once, on success.
 */
const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-10T14:00:00.000Z", // 10:00 in New York
  end: "2026-09-10T14:30:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: "regular",
  serviceColor: null,
  price: 40,
  status: "upcoming",
};

const REASON = "Blocked in your external calendar: Dentist, Sep 10, 12:00 PM - 2:00 PM";
const DIGEST = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";

const toast = vi.fn();
const onSaved = vi.fn();

/**
 * What the sheet's detail read hands the hook. Only the fields this screen
 * actually reads are filled: the contact it prefills from, and the payment
 * state the price field consults before letting anyone touch a paid ticket.
 */
const detailFor = (phone: string) =>
  ({
    contact: { phone, phoneDisplay: phone, email: "marcus@example.com" },
    payment: { state: "unpaid" },
  }) as unknown as AppointmentDetail;

/**
 * The sheet's sticky footer, in the shape AppointmentSheet actually builds it:
 * `save` is handed down through a `() => void` prop and lands on a real
 * button's onClick. The types stop there, but React does not - at runtime the
 * button hands the CLICK EVENT to `save`, which is why `save` has to read its
 * argument defensively instead of trusting it to be a confirmation.
 */
function Footer({ pending, onSave }: { pending: boolean; onSave: () => void }) {
  return (
    <button type="button" disabled={pending} onClick={onSave}>
      {pending ? "Saving…" : "Save changes"}
    </button>
  );
}

function Harness({ detail = null }: { detail?: AppointmentDetail | null }) {
  const state = useAppointmentEdit({ row, detail, toast, onSaved });
  return (
    <div>
      <AppointmentEditFields state={state} />
      <Footer pending={state.pending} onSave={state.save} />
      {/* 🔴 TWO CONFIRMS IN ONE HANDLER. Separate clicks are separate tasks, so
          React re-renders between them and `disabled` alone stops the second -
          which means a disabled button cannot prove anything about re-entry.
          Both calls here land before any re-render, exactly like a double
          submit, and only the in-flight ref can refuse the second. */}
      <button
        type="button"
        data-qa="double-confirm"
        onClick={() => {
          state.confirmBlock();
          state.confirmBlock();
        }}
      >
        Double confirm
      </button>
    </div>
  );
}

/** Waits for the context fetch, then moves the booking to 12:30. */
async function openAndMove() {
  render(<Harness />);
  await screen.findByLabelText("Start");
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: "12:30" } });
}

const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
const patchOf = (call: number) =>
  editAppointment.mock.calls[call]![1] as Record<string, unknown>;

beforeEach(() => {
  editAppointment.mockReset();
  editAppointment.mockResolvedValue({ ok: true });
  toast.mockReset();
  onSaved.mockReset();
});

describe("the edit sheet meets an external block", () => {
  it("🔴 shows the server's own sentence and keeps every value the barber entered", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    await openAndMove();
    fireEvent.change(screen.getByLabelText("Only you see this"), {
      target: { value: "moved him to the afternoon" },
    });
    save();

    const banner = await screen.findByRole("alertdialog");
    expect(banner).toHaveTextContent(REASON);
    // Not replacement copy, and not a toast that vanishes.
    expect(toast).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(banner);
    // Every entered value is still there - the sheet stayed open on the edit.
    expect(screen.getByLabelText("Start")).toHaveValue("12:30");
    expect(screen.getByLabelText("Only you see this")).toHaveValue(
      "moved him to the afternoon",
    );
    // Nothing was written and the sheet did not close.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("🔴 choosing another time never sends a confirmation", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    await openAndMove();
    save();
    await screen.findByRole("alertdialog");

    fireEvent.click(screen.getByRole("button", { name: "Choose another time" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // A plain save afterwards is a plain save.
    editAppointment.mockResolvedValueOnce({ ok: true });
    save();
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(2));
    expect(patchOf(0).externalBlockConfirmation).toBeUndefined();
    expect(patchOf(1).externalBlockConfirmation).toBeUndefined();
  });

  it("🔴 confirming sends back THAT refusal's digest, then closes and refreshes once", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    await openAndMove();
    save();
    await screen.findByRole("alertdialog");

    editAppointment.mockResolvedValueOnce({ ok: true, status: "BOOKED", mirror: "skipped" });
    fireEvent.click(screen.getByRole("button", { name: "Save over this block" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(editAppointment).toHaveBeenCalledTimes(2);
    expect(patchOf(1).externalBlockConfirmation).toBe(DIGEST);
    // The same edit, not a different one.
    expect(patchOf(1).startsAt).toBe(patchOf(0).startsAt);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("🔴 double-clicking the confirmation saves once", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    await openAndMove();
    save();
    await screen.findByRole("alertdialog");

    let release: (v: EditReply) => void = () => {};
    editAppointment.mockImplementationOnce(
      () => new Promise<EditReply>((resolve) => (release = resolve)),
    );
    // Two separate clicks (the disabled attribute's job) AND two calls inside
    // one handler (the ref's job) - one effective save either way.
    const confirm = screen.getByRole("button", { name: "Save over this block" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Double confirm" }));
    expect(editAppointment).toHaveBeenCalledTimes(2); // the refusal + one retry
    release({ ok: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(editAppointment).toHaveBeenCalledTimes(2);
  });

  it("🔴 a conflict that CHANGED replaces the banner and needs its own confirmation", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    await openAndMove();
    save();
    await screen.findByRole("alertdialog");

    // Acuity synced another block while the banner sat there: the server
    // refuses the stale confirmation and answers with the new conflict.
    const NEW_REASON = "Blocked in your external calendar: School run, Sep 10, 12:15 PM - 12:45 PM";
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: NEW_REASON,
      confirmation: "ffffffffffffffffffffffffffffffff",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save over this block" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveTextContent(NEW_REASON));
    expect(screen.queryByText(REASON)).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();

    // The next confirmation is the NEW one, never the digest he first saw.
    editAppointment.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Save over this block" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patchOf(2).externalBlockConfirmation).toBe("ffffffffffffffffffffffffffffffff");
  });

  it("🔴 a confirmed retry that fails for ANOTHER reason keeps the sheet, the values and the truth", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    await openAndMove();
    fireEvent.change(screen.getByLabelText("Only you see this"), {
      target: { value: "keep me" },
    });
    save();
    await screen.findByRole("alertdialog");

    // Someone took the slot in the meantime.
    editAppointment.mockResolvedValueOnce({ ok: false, error: "slot_taken" });
    fireEvent.click(screen.getByRole("button", { name: "Save over this block" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]![0]).toMatch(/already taken/i);
    // The block banner is gone - it is no longer the authoritative answer.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // The sheet is open and nothing he typed was lost.
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Start")).toHaveValue("12:30");
    expect(screen.getByLabelText("Only you see this")).toHaveValue("keep me");
  });

  it("🔴 a refresh of the surrounding sheet does not erase the conflict", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    // A real detail read, so the effects that react to one actually run.
    const { rerender } = render(<Harness detail={detailFor("+12025550171")} />);
    await screen.findByLabelText("Start");
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "12:30" } });
    save();
    await screen.findByRole("alertdialog");

    // The calendar polls every 20s and the sheet re-reads the booking under it,
    // handing down a FRESH object each time. The refusal is still the last
    // thing the server said, and it must survive that.
    rerender(<Harness detail={detailFor("+12025550171")} />);
    expect(screen.getByRole("alertdialog")).toHaveTextContent(REASON);
    expect(screen.getByLabelText("Start")).toHaveValue("12:30");
  });

  it("shows a pending confirm state without losing the banner", async () => {
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: REASON,
      confirmation: DIGEST,
    });
    await openAndMove();
    save();
    await screen.findByRole("alertdialog");

    let release: (v: EditReply) => void = () => {};
    editAppointment.mockImplementationOnce(
      () => new Promise<EditReply>((resolve) => (release = resolve)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save over this block" }));
    // The sticky footer says "Saving…" too - this asserts about the banner's
    // own button, which must stay put and stay disabled while the retry runs.
    await waitFor(() =>
      expect(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Saving…" }),
      ).toBeDisabled(),
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(REASON);
    release({ ok: true });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("🔴 a hostile block reason reaches the screen as text, not as markup", async () => {
    const nasty = '<img src=x onerror="alert(1)"> Dentist';
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "external_block",
      reason: nasty,
      confirmation: DIGEST,
    });
    const { container } = render(<Harness />);
    await screen.findByLabelText("Start");
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "12:30" } });
    save();
    await screen.findByRole("alertdialog");
    expect(screen.getByRole("alertdialog")).toHaveTextContent(nasty);
    expect(container.querySelector("img")).toBeNull();
  });
});
