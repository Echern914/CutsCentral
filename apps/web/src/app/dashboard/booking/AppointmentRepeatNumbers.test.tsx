import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";
import type { DashSlot } from "./actions";

const AT_11: DashSlot = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" };
const getSlots = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getDashSlotsAction: getSlots,
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  createAppointmentAction: create,
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
}));

const { AppointmentForm } = await import("./AppointmentForm");

/**
 * 🔴 THE REPEAT NUMBERS CAN BE TYPED.
 *
 * Reported from a barber's phone, 2026-10-06: "it's only letting him do 8 even
 * when he tries a different number". Each box clamped on every keystroke, so
 * clearing 8 snapped to 1, and typing 3 next to it read 13 and snapped back to
 * 8. Every test here types the way a phone does - one character at a time,
 * through a cleared box - and checks what Schedule actually sends.
 */
const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "svc1", name: "Haircut", durationMin: 30, price: 35, active: true }] as unknown as ServiceRow[];

async function openRepeating() {
  render(
    <AppointmentForm
      staff={[DEE]}
      services={services}
      timezone="America/New_York"
      prefillISO="2026-10-02T14:00:00.000Z"
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={vi.fn()}
    />,
  );
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Repeat appointment" }));
  fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
  fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
}

const weeks = () => screen.getByLabelText("Repeat every how many weeks") as HTMLInputElement;
const total = () => screen.getByLabelText("How many appointments in total") as HTMLInputElement;
/** A phone keyboard: one keystroke at a time, each one a change event. */
function typeOnPhone(box: HTMLInputElement, keys: string) {
  for (const k of keys) {
    if (k === "⌫") fireEvent.change(box, { target: { value: box.value.slice(0, -1) } });
    else fireEvent.change(box, { target: { value: box.value + k } });
  }
}
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const sentRecurrence = () => (create.mock.calls[0]![0] as { recurrence?: unknown }).recurrence;

beforeEach(() => {
  getSlots.mockReset();
  create.mockReset();
  getSlots.mockResolvedValue({ ok: true, slots: [AT_11] });
  create.mockResolvedValue({ ok: true });
});

describe("the repeat boxes on a phone", () => {
  it("🔴 clear the box, type 3: every 3 weeks - not 1, not 8", async () => {
    await openRepeating();
    typeOnPhone(weeks(), "⌫");
    expect(weeks().value).toBe("");
    typeOnPhone(weeks(), "3");
    expect(weeks().value).toBe("3");
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sentRecurrence()).toEqual({ interval: 3, count: 4 });
  });

  it("🔴 from 8, clear and type 6: every 6 weeks", async () => {
    await openRepeating();
    typeOnPhone(weeks(), "⌫8");
    expect(weeks().value).toBe("8");
    typeOnPhone(weeks(), "⌫6");
    expect(weeks().value).toBe("6");
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sentRecurrence()).toMatchObject({ interval: 6 });
  });

  it("🔴 the appointment count takes 10 and 12 - two-digit numbers type through", async () => {
    await openRepeating();
    typeOnPhone(total(), "⌫10");
    expect(total().value).toBe("10");
    typeOnPhone(total(), "⌫⌫12");
    expect(total().value).toBe("12");
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sentRecurrence()).toEqual({ interval: 1, count: 12 });
  });

  it("🔴 a number over the limit stays as typed, says the range, and Schedule refuses - never a different number", async () => {
    await openRepeating();
    typeOnPhone(weeks(), "⌫12");
    fireEvent.blur(weeks());
    expect(weeks().value).toBe("12");
    expect(screen.getAllByText("A repeat can be every 1 to 8 weeks.").length).toBeGreaterThan(0);
    schedule();
    expect(create).not.toHaveBeenCalled();
    // Fixing it lets it through.
    typeOnPhone(weeks(), "⌫⌫5");
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sentRecurrence()).toMatchObject({ interval: 5 });
  });

  it("a box left empty goes back to its last number", async () => {
    await openRepeating();
    typeOnPhone(weeks(), "⌫4");
    typeOnPhone(weeks(), "⌫");
    fireEvent.blur(weeks());
    expect(weeks().value).toBe("4");
  });

  it("letters never get in", async () => {
    await openRepeating();
    typeOnPhone(weeks(), "⌫a2");
    expect(weeks().value).toBe("2");
  });
});
