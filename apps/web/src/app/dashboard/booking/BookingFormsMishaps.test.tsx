import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { ServiceRow, StaffRow } from "./page";

/**
 * Booking form mishaps from the 2026-10-08 sweep:
 *
 *  - 🔴 a booking question just added couldn't be removed: it carried a
 *    made-up id, so Remove deleted nothing and said "Removed.";
 *  - 🔴 leaving Custom time kept the typed time, which could be another day;
 *  - opened with no tapped hour (the waitlist's Book), Schedule without a
 *    pick said "That time isn't available" instead of "Pick a time";
 *  - a block could not run to midnight;
 *  - a near-miss email on Add to waitlist said "try again" forever;
 *  - End hold reported itself in a toast hidden under its dialog.
 */

const a = vi.hoisted(() => ({
  createBookingQuestionAction: vi.fn(),
  deleteBookingQuestionAction: vi.fn(),
  updateBookingQuestionAction: vi.fn(),
  seedBookingQuestionsAction: vi.fn(),
  addBlockAction: vi.fn(),
  createWaitlistEntryAction: vi.fn(),
  getDashSlotsAction: vi.fn(),
  createAppointmentAction: vi.fn(),
  listTierOpeningsAction: vi.fn(),
  releaseTierOpeningAction: vi.fn(),
}));
vi.mock("./actions", () => ({
  ...a,
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  previewTierOpeningAction: vi.fn(async () => ({ ok: false })),
  createTierOpeningAction: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { BookingQuestionsCard } = await import("./BookingQuestionsCard");
const { AppointmentForm } = await import("./AppointmentForm");
const { BlockOffForm } = await import("./BlockOffForm");
const { WaitlistAddForm } = await import("./WaitlistAddForm");
const { TierOpeningForm } = await import("./TierOpeningForm");

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "svc1", name: "Haircut", durationMin: 30, price: 35, active: true }] as unknown as ServiceRow[];
const toast = vi.fn();

beforeEach(() => {
  for (const f of Object.values(a)) f.mockReset();
  toast.mockReset();
});

describe("booking questions", () => {
  it("🔴 a question just added is removed by its REAL id", async () => {
    a.createBookingQuestionAction.mockResolvedValue({ ok: true, id: "q_real_1" });
    a.deleteBookingQuestionAction.mockResolvedValue({ ok: true });
    render(<BookingQuestionsCard initial={[]} services={[]} toast={toast} />);
    const form = screen.getAllByLabelText("Question");
    fireEvent.change(form[form.length - 1]!, { target: { value: "Gate code" } });
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    await screen.findByText("Gate code");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(a.deleteBookingQuestionAction).toHaveBeenCalledWith("q_real_1"));
  });
});

describe("New appointment", () => {
  const SLOT = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" };

  function openForm(props: { tapped?: boolean; prefillISO?: string } = {}) {
    a.getDashSlotsAction.mockResolvedValue({ ok: true, slots: [SLOT] });
    a.createAppointmentAction.mockResolvedValue({ ok: true });
    render(
      <AppointmentForm
        staff={[DEE]}
        services={services}
        timezone="America/New_York"
        prefillISO={props.prefillISO ?? "2026-10-02T14:00:00.000Z"}
        tapped={props.tapped}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        toast={toast}
      />,
    );
  }
  const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));

  it("🔴 Schedule with no time picked says 'Pick a time.', and sends nothing", async () => {
    openForm({ prefillISO: "2026-10-02T13:47:12.345Z" });
    await screen.findByRole("button", { name: "11:00 AM" });
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
    schedule();
    expect(await screen.findByText("Pick a time.")).toBeTruthy();
    expect(a.createAppointmentAction).not.toHaveBeenCalled();
  });

  it("🔴 leaving Custom time forgets the typed time", async () => {
    // Opened on the 11:00 AM slot, which the grid shows as picked.
    openForm({ tapped: true, prefillISO: SLOT.startsAt });
    await screen.findByRole("button", { name: "11:00 AM" });
    fireEvent.click(screen.getByRole("button", { name: "Custom time" }));
    fireEvent.change(screen.getByLabelText("Custom date and time"), { target: { value: "2026-10-03T16:00" } });
    // Back to the open slots WITHOUT tapping one: the Saturday 4 PM typed
    // above is no longer on screen, so it must not be what gets booked.
    fireEvent.click(screen.getByRole("button", { name: "Pick from open slots" }));
    await screen.findByRole("button", { name: "11:00 AM" });
    fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
    schedule();
    await waitFor(() => expect(a.createAppointmentAction).toHaveBeenCalledTimes(1));
    expect((a.createAppointmentAction.mock.calls[0]![0] as { startsAt: string }).startsAt).toBe(SLOT.startsAt);
  });
});

describe("block off", () => {
  it("🔴 a timed block can run to midnight", async () => {
    a.addBlockAction.mockResolvedValue({ ok: true });
    render(
      <BlockOffForm
        staff={[DEE]}
        dayKey="2026-09-09"
        todayKey="2026-09-08"
        timezone="America/New_York"
        defaultFromHour={23}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        toast={toast}
      />,
    );
    await screen.findByLabelText("To");
    expect(screen.getByLabelText("To")).toHaveValue("00:00");
    fireEvent.click(screen.getByRole("button", { name: /Add block/ }));
    await waitFor(() => expect(a.addBlockAction).toHaveBeenCalledTimes(1));
    const sent = a.addBlockAction.mock.calls[0]![0] as { startsAt: string; endsAt: string };
    // 11 PM to midnight in New York (EDT) = 03:00Z to 04:00Z next day.
    expect(sent.startsAt).toBe("2026-09-10T03:00:00.000Z");
    expect(sent.endsAt).toBe("2026-09-10T04:00:00.000Z");
  });
});

describe("add to waitlist", () => {
  it("a near-miss email is named before anything is sent", () => {
    render(<WaitlistAddForm staff={[DEE]} services={services} toast={toast} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@gmail" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to waitlist" }));
    expect(screen.getByText(/That email doesn't look right/)).toBeTruthy();
    expect(a.createWaitlistEntryAction).not.toHaveBeenCalled();
  });
});

describe("offer to a tier", () => {
  it("🔴 a refused End hold is said inside the dialog, not in a hidden toast", async () => {
    a.listTierOpeningsAction.mockResolvedValue({
      ok: true,
      openings: [
        {
          id: "op1",
          staffName: "Dee",
          serviceName: "Haircut",
          startsAt: "2026-10-02T15:00:00.000Z",
          endsAt: "2026-10-02T15:30:00.000Z",
          minTier: "gold",
          heldUntil: "2026-10-02T14:00:00.000Z",
          state: "held",
          recipients: 3,
          claimedBy: null,
        },
      ],
    });
    a.releaseTierOpeningAction.mockResolvedValue({ ok: false });
    a.getDashSlotsAction.mockResolvedValue({ ok: true, slots: [] });
    render(
      <TierOpeningForm
        staff={[DEE]}
        services={services}
        timezone="America/New_York"
        dayKey="2026-10-02"
        todayKey="2026-10-01"
        onClose={vi.fn()}
        onHeld={vi.fn()}
        toast={toast}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "End hold" }));
    expect(await within(dialog).findByText(/Couldn't end that hold/)).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });
});
