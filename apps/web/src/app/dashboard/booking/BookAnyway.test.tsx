import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow, ServiceRow, StaffRow } from "./page";
import type { DashSlot } from "./actions";

type Reply = {
  ok: boolean;
  error?: string;
  code?: string;
  reason?: string;
  confirmation?: string;
  conflicts?: string[];
  message?: string;
  forced?: boolean;
  mirror?: string;
  status?: string;
};

const create = vi.hoisted(() => vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as Reply));
const editAppointment = vi.hoisted(() =>
  vi.fn(async (_id: string, _patch: Record<string, unknown>) => ({ ok: true }) as Reply),
);
vi.mock("./actions", () => ({
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [REGULAR] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  createAppointmentAction: create,
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
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

const { AppointmentForm } = await import("./AppointmentForm");
const { AppointmentEditFields, useAppointmentEdit } = await import("./AppointmentEditForm");

/**
 * "BOOK ANYWAY" - what the barber sees when a save is refused for a time
 * conflict (Eric: "a force appointment button ... even if there's a time
 * conflict").
 *
 *  - the conflict is shown IN THE DIALOG (a toast draws beneath it on a
 *    phone), naming who and when;
 *  - "Book anyway" only ASKS - the server's own question - and nothing is sent;
 *  - "Yes, book it" sends back THAT refusal's answer and books it;
 *  - "Cancel" sends nothing, and a plain save afterwards carries no answer;
 *  - a customer's live hold is named with no Book anyway at all;
 *  - the edit sheet asks the same question for a move.
 */
const TZ = "America/New_York";
const PREFILL = "2026-10-02T14:00:00.000Z"; // Fri 10:00 AM in New York
const REGULAR: DashSlot = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" }; // 11 AM
const DIGEST = "0123456789abcdef0123456789abcdef";
const QUESTION = "This overlaps Marcus R. at 10:00 AM. Book it anyway?";
const OVERLAP: Reply = {
  ok: false,
  error: "slot_taken",
  code: "OVERLAP",
  reason: "That time overlaps what's already on your calendar:",
  conflicts: ["Marcus R. - Fade, 10:00 AM - 10:30 AM"],
  message: QUESTION,
  confirmation: DIGEST,
};
const HELD: Reply = {
  ok: false,
  error: "slot_taken",
  code: "HELD",
  reason:
    "A customer is paying for or confirming this time right now, and it's held for them until 10:12 AM. It can't be booked over while they finish - pick another time, or try again after 10:12 AM.",
};

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "svc1", name: "Fade", durationMin: 30, price: 40, active: true }] as unknown as ServiceRow[];

const toast = vi.fn();
const onCreated = vi.fn();

async function openForm() {
  render(
    <AppointmentForm
      staff={[DEE]}
      services={services}
      timezone={TZ}
      prefillISO={PREFILL}
      onClose={vi.fn()}
      onCreated={onCreated}
      toast={toast}
    />,
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Geo" } });
  return dialog;
}
const customTime = () => fireEvent.click(screen.getByRole("button", { name: "Custom time" }));
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const sent = (call: number) => create.mock.calls[call]![0] as Record<string, unknown>;

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ ok: true });
  editAppointment.mockReset();
  editAppointment.mockResolvedValue({ ok: true, status: "BOOKED", mirror: "skipped" });
  toast.mockReset();
  onCreated.mockReset();
});

describe("New appointment: a time that overlaps another booking", () => {
  it("🔴 shows who and when IN the dialog - never a toast - and books nothing yet", async () => {
    create.mockResolvedValueOnce(OVERLAP);
    const dialog = await openForm();
    customTime();
    schedule();

    const banner = await within(dialog).findByRole("alertdialog");
    expect(banner).toHaveTextContent("That time overlaps what's already on your calendar:");
    expect(banner).toHaveTextContent("Marcus R. - Fade, 10:00 AM - 10:30 AM");
    expect(within(banner).getByRole("button", { name: "Book anyway" })).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(sent(0).overlapConfirmation).toBeUndefined();
  });

  it("🔴 Book anyway ASKS first; only 'Yes, book it' sends the answer and books it", async () => {
    create.mockResolvedValueOnce(OVERLAP);
    const dialog = await openForm();
    customTime();
    schedule();
    const banner = await within(dialog).findByRole("alertdialog");

    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    // The one more tap: the server's own question, and still nothing sent.
    expect(await within(banner).findByText(QUESTION)).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValueOnce({ ok: true, forced: true, mirror: "skipped" });
    fireEvent.click(within(banner).getByRole("button", { name: "Yes, book it" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(2);
    expect(sent(1).overlapConfirmation).toBe(DIGEST);
    expect(sent(1).customTime).toBe(true);
    expect(sent(1).startsAt).toBe(sent(0).startsAt);
  });

  it("🔴 Cancel on the question sends nothing - and a plain save afterwards carries no answer", async () => {
    create.mockResolvedValueOnce(OVERLAP);
    const dialog = await openForm();
    customTime();
    schedule();
    const banner = await within(dialog).findByRole("alertdialog");

    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    fireEvent.click(await within(banner).findByRole("button", { name: "Cancel" }));
    // Back to the list, nothing sent, nothing created.
    expect(within(banner).queryByText(QUESTION)).toBeNull();
    expect(within(banner).getByRole("button", { name: "Book anyway" })).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(within(banner).getByRole("button", { name: "Choose another time" }));
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(sent(1).overlapConfirmation).toBeUndefined();
  });

  it("a slot picked from the open list that was taken meanwhile gets the same Book anyway", async () => {
    create.mockResolvedValueOnce(OVERLAP);
    const dialog = await openForm();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    schedule();
    const banner = await within(dialog).findByRole("alertdialog");
    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    create.mockResolvedValueOnce({ ok: true, forced: true, mirror: "skipped" });
    fireEvent.click(await within(banner).findByRole("button", { name: "Yes, book it" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(sent(1)).toMatchObject({
      startsAt: REGULAR.startsAt,
      customTime: false,
      overlapConfirmation: DIGEST,
    });
  });

  it("🔴 a customer's live hold is named, with no Book anyway at all", async () => {
    create.mockResolvedValueOnce(HELD);
    const dialog = await openForm();
    customTime();
    schedule();
    const banner = await within(dialog).findByRole("alertdialog");
    expect(banner).toHaveTextContent("held for them until 10:12 AM");
    expect(within(banner).queryByRole("button", { name: "Book anyway" })).toBeNull();
    expect(within(banner).getByRole("button", { name: "Choose another time" })).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("Acuity refusing a forced booking is said in the footer, above the button", async () => {
    create.mockResolvedValueOnce(OVERLAP);
    const dialog = await openForm();
    customTime();
    schedule();
    const banner = await within(dialog).findByRole("alertdialog");
    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    create.mockResolvedValueOnce({
      ok: false,
      error: "acuity_refused",
      reason: "Acuity wouldn't block this time on your calendar, so it wasn't booked.",
    });
    fireEvent.click(await within(banner).findByRole("button", { name: "Yes, book it" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("so it wasn't booked");
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("the edit sheet: moving a booking onto another one", () => {
  const row: AgendaRow = {
    id: "appt1",
    source: "appointment",
    start: "2026-10-02T18:00:00.000Z", // 2:00 PM in New York
    end: "2026-10-02T18:30:00.000Z",
    clientName: "Geo",
    serviceName: "Fade",
    serviceId: "svc1",
    staffId: "stf1",
    notes: null,
    serviceColor: null,
    price: 40,
    status: "upcoming",
  };
  const onSaved = vi.fn();
  function Harness() {
    const state = useAppointmentEdit({ row, detail: null, onSaved });
    return (
      <div>
        <AppointmentEditFields state={state} />
        {state.saveError && <p role="alert">{state.saveError}</p>}
        <button type="button" disabled={state.pending || !state.dirty} onClick={() => state.save()}>
          Save changes
        </button>
      </div>
    );
  }
  async function openAndMove() {
    onSaved.mockReset();
    render(<Harness />);
    await screen.findByLabelText("Start");
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    return screen.findByRole("alertdialog");
  }
  const patchOf = (call: number) => editAppointment.mock.calls[call]![1] as Record<string, unknown>;

  it("names who is there, asks, and only 'Yes' moves it over them", async () => {
    editAppointment.mockResolvedValueOnce(OVERLAP);
    const banner = await openAndMove();
    expect(banner).toHaveTextContent("Marcus R. - Fade, 10:00 AM - 10:30 AM");
    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    expect(await within(banner).findByText(QUESTION)).toBeInTheDocument();
    expect(editAppointment).toHaveBeenCalledTimes(1);
    expect(patchOf(0).overlapConfirmation).toBeUndefined();

    fireEvent.click(within(banner).getByRole("button", { name: "Yes, book it" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patchOf(1).overlapConfirmation).toBe(DIGEST);
    expect(patchOf(1).startsAt).toBe(patchOf(0).startsAt);
  });

  it("Cancel on the question sends nothing", async () => {
    editAppointment.mockResolvedValueOnce(OVERLAP);
    const banner = await openAndMove();
    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    fireEvent.click(await within(banner).findByRole("button", { name: "Cancel" }));
    expect(within(banner).queryByText(QUESTION)).toBeNull();
    expect(editAppointment).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a customer's live hold is named with nothing to confirm", async () => {
    editAppointment.mockResolvedValueOnce(HELD);
    const banner = await openAndMove();
    expect(banner).toHaveTextContent("held for them until 10:12 AM");
    expect(within(banner).queryByRole("button", { name: "Book anyway" })).toBeNull();
  });
});
