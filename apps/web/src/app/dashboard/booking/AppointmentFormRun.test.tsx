import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MAX_DASH_RUN } from "@chairback/config/constants";
import type { AddOnRow, ServiceRow, StaffRow } from "./page";
import type { CreateApptResult, DashSlot, DaySpecial } from "./actions";

type SlotsReply = { ok: boolean; slots?: DashSlot[] };
type SpecialsReply = { ok: boolean; specials?: DaySpecial[] };

const getSlots = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true, slots: [] }) as SlotsReply),
);
const getDaySpecials = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true, specials: [] }) as SpecialsReply),
);
const create = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true, answered: true }) as CreateApptResult),
);
const createRun = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true, answered: true }) as CreateApptResult),
);
vi.mock("./actions", () => ({
  getDashSlotsAction: getSlots,
  getDaySpecialsAction: getDaySpecials,
  createAppointmentAction: create,
  createAppointmentRunAction: createRun,
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
}));

const { AppointmentForm } = await import("./AppointmentForm");

/**
 * THE `- 1 +`. "It takes me a minute to add 3 services back to back", from a
 * live shop. The form's job: ask for times the whole run fits from, send one
 * request for all of them, and never let something priced for one visit ride
 * along on a card the screen has stopped showing.
 */
const TZ = "America/New_York";
// Friday Oct 2 2026 in New York.
const THREE_PM = "2026-10-02T19:00:00.000Z";
const FOUR_PM = "2026-10-02T20:00:00.000Z";
const FIVE_PM = "2026-10-02T21:00:00.000Z";
const NOON = "2026-10-02T16:00:00.000Z";
const slot = (startsAt: string, endsAt: string): DashSlot => ({ startsAt, endsAt });
const ONE_AT_THREE = slot(THREE_PM, "2026-10-02T19:30:00.000Z");
const ONE_AT_FOUR = slot(FOUR_PM, "2026-10-02T20:30:00.000Z");
const FOUR_AT_THREE = slot(THREE_PM, FIVE_PM);
const SPECIAL: DaySpecial = {
  id: "ts-am",
  staffId: "stf1",
  serviceIds: ["svc1"],
  startsAt: NOON,
  endsAt: "2026-10-02T16:30:00.000Z",
  durationMin: 30,
  price: 60,
  label: "Early bird",
};

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [
  { id: "svc1", name: "Mens Haircut", durationMin: 30, price: 50, active: true },
] as unknown as ServiceRow[];
const addOns = [
  { id: "add1", name: "Beard trim", durationMin: 10, price: 15, active: true, serviceIds: [] },
] as unknown as AddOnRow[];

type FormProps = Parameters<typeof AppointmentForm>[0];
const toast = vi.fn();

function open(props: Partial<FormProps> = {}) {
  render(
    <AppointmentForm
      staff={[DEE]}
      services={services}
      timezone={TZ}
      prefillISO={NOON}
      tapped={false}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={toast}
      {...props}
    />,
  );
  return screen.findByRole("dialog");
}

const more = () => fireEvent.click(screen.getByRole("button", { name: "One more" }));
const fewer = () => fireEvent.click(screen.getByRole("button", { name: "One fewer" }));
const nameIt = () => fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const pickThree = async () => fireEvent.click(await screen.findByRole("button", { name: /^3:00 PM/ }));
const runArgs = (call = 0) => createRun.mock.calls[call]![0] as Record<string, unknown>;

/** The slots call the form made last: [staff, service, from, to, addOnIds, run]. */
const lastSlotsCall = () => getSlots.mock.calls[getSlots.mock.calls.length - 1]!;

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // The day before those times, fixed: past them, the form rightly drops the
  // confirmation box, and this file would go red the day the date went by.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T16:00:00.000Z") });
  toast.mockReset();
  getSlots.mockReset();
  getDaySpecials.mockReset();
  create.mockReset();
  createRun.mockReset();
  getSlots.mockImplementation(async (...a: unknown[]) => ({
    ok: true,
    slots: a[5] ? [FOUR_AT_THREE] : [ONE_AT_THREE, ONE_AT_FOUR],
  }));
  getDaySpecials.mockResolvedValue({ ok: true, specials: [] });
  create.mockResolvedValue({ ok: true, answered: true, id: "a1" });
  createRun.mockResolvedValue({
    ok: true,
    answered: true,
    id: "a1",
    startsAt: THREE_PM,
    endsAt: FIVE_PM,
    run: { count: 4 },
    mirror: "none",
  });
});

describe("the stepper", () => {
  it("🔴 is there once a service is picked, starts at 1, and stops at both ends", async () => {
    await open();
    await screen.findByRole("button", { name: "One more" });
    expect(screen.getByRole("group", { name: "How many back to back" }).textContent).toContain("1");
    expect((screen.getByRole("button", { name: "One fewer" }) as HTMLButtonElement).disabled).toBe(true);
    for (let i = 1; i < MAX_DASH_RUN; i += 1) more();
    expect(screen.getByRole("group", { name: "How many back to back" }).textContent).toContain(String(MAX_DASH_RUN));
    expect((screen.getByRole("button", { name: "One more" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("🔴 taps quicker than a render each count", async () => {
    await open();
    const plus = (await screen.findByRole("button", { name: "One more" })) as HTMLButtonElement;
    act(() => {
      plus.click();
      plus.click();
      plus.click();
    });
    expect(screen.getByRole("group", { name: "How many back to back" }).textContent).toContain("4");
  });

  it("is not on Book again: the next visit is one visit", async () => {
    await open({
      rebook: {
        clientId: "c1",
        clientName: "Casey",
        serviceId: "svc1",
        staffId: "stf1",
      } as FormProps["rebook"],
    });
    expect(screen.queryByRole("button", { name: "One more" })).toBeNull();
  });

  it("is not on a waitlist booking: one person asked for one time", async () => {
    await open({
      waitlist: {
        entryId: "w1",
        clientId: "c1",
        clientName: "Casey",
        serviceId: "svc1",
        staffId: "stf1",
      } as FormProps["waitlist"],
    });
    expect(screen.queryByRole("button", { name: "One more" })).toBeNull();
  });
});

describe("the times it offers", () => {
  it("🔴 asks for the times the whole run fits from, and again as the count changes", async () => {
    await open();
    await screen.findByRole("button", { name: /^4:00 PM/ });
    expect(lastSlotsCall()[5]).toBeUndefined();

    more();
    more();
    more();
    await waitFor(() => expect(lastSlotsCall()[5]).toBe(4));
    expect(lastSlotsCall()[4]).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^4:00 PM/ })).toBeNull());

    fewer();
    fewer();
    fewer();
    await waitFor(() => expect(lastSlotsCall()[5]).toBeUndefined());
    await screen.findByRole("button", { name: /^4:00 PM/ });
  });

  it("🔴 a time picked for one that the run doesn't fit from stops being the pick", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: /^4:00 PM/ }));
    more();
    more();
    more();
    await waitFor(() => expect(lastSlotsCall()[5]).toBe(4));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^4:00 PM/ })).toBeNull());
    nameIt();
    schedule();
    await screen.findByText("Pick a time.");
    expect(createRun).not.toHaveBeenCalled();
  });

  it("🔴 shows the span from the time the server listed, not from arithmetic on the menu", async () => {
    getSlots.mockImplementation(async (...a: unknown[]) => ({
      ok: true,
      // 4 x 30 is 2 hours by the menu. This hour's own length makes it 2 h 30.
      slots: a[5] ? [slot(THREE_PM, "2026-10-02T21:30:00.000Z")] : [ONE_AT_THREE],
    }));
    await open();
    await screen.findByRole("button", { name: /^3:00 PM/ });
    more();
    more();
    more();
    await waitFor(() => expect(lastSlotsCall()[5]).toBe(4));
    await pickThree();
    await waitFor(() => {
      const text = document.querySelector('[data-qa="run-summary"]')?.textContent ?? "";
      expect(text).toContain("4 × Mens Haircut");
      expect(text).toContain("3:00 PM - 5:30 PM");
    });
  });
});

describe("what Schedule sends", () => {
  async function bookFour() {
    await open();
    await screen.findByRole("button", { name: /^3:00 PM/ });
    more();
    more();
    more();
    await waitFor(() => expect(lastSlotsCall()[5]).toBe(4));
    await pickThree();
    nameIt();
    schedule();
  }

  it("🔴 one request with the count and an id, and nothing priced for one visit", async () => {
    await bookFour();
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(1));
    expect(create).not.toHaveBeenCalled();
    const sent = runArgs();
    expect(sent.count).toBe(4);
    expect(sent.startsAt).toBe(THREE_PM);
    expect(sent.serviceId).toBe("svc1");
    expect(sent.staffId).toBe("stf1");
    expect(sent.firstName).toBe("Casey");
    expect(sent.operationId).toEqual(expect.any(String));
    for (const key of ["price", "addOnIds", "offerCode", "recurrence", "targetedSlotId", "waitlistEntryId"]) {
      expect(sent).not.toHaveProperty(key);
    }
  });

  it("names the count and the span when it lands", async () => {
    await bookFour();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Booked 4 back to back: 3:00 PM - 5:00 PM", "success"),
    );
  });

  it("🔴 a count of 1 is still the ordinary booking", async () => {
    await open();
    await pickThree();
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(createRun).not.toHaveBeenCalled();
  });

  it("🔴 unticking 'tell the client' reaches the run", async () => {
    await open();
    await screen.findByRole("button", { name: /^3:00 PM/ });
    more();
    await waitFor(() => expect(lastSlotsCall()[5]).toBe(2));
    await pickThree();
    nameIt();
    fireEvent.click(screen.getByRole("checkbox", { name: /Send them a confirmation/ }));
    schedule();
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(1));
    expect(runArgs().notifyClient).toBe(false);
  });

  it("🔴 a lost answer retried sends the same id, so it cannot book the run twice", async () => {
    createRun.mockRejectedValueOnce(new Error("network"));
    await bookFour();
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole("button", { name: /Schedule appointment/ }) as HTMLButtonElement).disabled).toBe(false));
    schedule();
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(2));
    expect(runArgs(1).operationId).toBe(runArgs(0).operationId);
  });

  it("🔴 running into the buffer asks first, and the yes rides on the run", async () => {
    createRun.mockResolvedValueOnce({
      ok: false,
      answered: true,
      error: "slot_taken",
      code: "OVERLAP",
      reason: "That time overlaps what's already on your calendar:",
      message: "This runs into your buffer. Book it anyway?",
      confirmation: "confirm-token",
      bufferOnly: true,
      conflicts: ["Casey - Fade, 5:00 PM - 5:30 PM"],
    });
    await bookFour();
    const banner = await screen.findByRole("alertdialog");
    expect(banner.textContent).toContain("it isn't marked Double-booked");
    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    expect(createRun).toHaveBeenCalledTimes(1);
    fireEvent.click(await within(banner).findByRole("button", { name: "Yes, book it" }));
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(2));
    expect(runArgs(1).overlapConfirmation).toBe("confirm-token");
    expect(runArgs(1).count).toBe(4);
  });

  it("🔴 a real overlap in a run says only the ones sharing the time get the tag", async () => {
    createRun.mockResolvedValueOnce({
      ok: false,
      answered: true,
      error: "slot_taken",
      code: "OVERLAP",
      reason: "That time overlaps what's already on your calendar:",
      message: "This overlaps another booking. Book it anyway?",
      confirmation: "confirm-token",
      conflicts: ["Casey - Fade, 4:00 PM - 4:30 PM"],
    });
    await bookFour();
    const banner = await screen.findByRole("alertdialog");
    expect(banner.textContent).toContain("the ones that share the time are marked Double-booked");
    expect(banner.textContent).not.toContain("this one is marked");
  });

  it("🔴 a time the run no longer fits from says so, in the footer", async () => {
    createRun.mockResolvedValueOnce({ ok: false, answered: true, error: "invalid_slot" });
    await bookFour();
    await screen.findByText(/All 4 don't fit from that time/);
  });

  it("🔴 Acuity refusing the run says none were booked", async () => {
    createRun.mockResolvedValueOnce({
      ok: false,
      answered: true,
      error: "acuity_refused",
      reason: "Acuity wouldn't block these times on your calendar, so none of them were booked.",
    });
    await bookFour();
    await screen.findByText(/none of them were booked/);
    expect(toast).not.toHaveBeenCalled();
  });

  it("🔴 a run Acuity didn't block says so, rather than claiming it's all fine", async () => {
    createRun.mockResolvedValueOnce({
      ok: true,
      answered: true,
      id: "a1",
      startsAt: THREE_PM,
      endsAt: FIVE_PM,
      run: { count: 4 },
      mirror: "failed",
    });
    await bookFour();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("Acuity didn't block"), "error"));
  });
});

describe("what is for one visit goes when the count goes up", () => {
  it("🔴 a ticked add-on is cleared and cannot ride along back at 1", async () => {
    await open({ addOns });
    fireEvent.click(await screen.findByRole("button", { name: /Beard trim/ }));
    expect(screen.getByRole("button", { name: /Beard trim/ }).getAttribute("aria-pressed")).toBe("true");
    more();
    await screen.findByText(/Add-ons are for a single visit/);
    expect(screen.queryByRole("button", { name: /Beard trim/ })).toBeNull();
    fewer();
    expect((await screen.findByRole("button", { name: /Beard trim/ })).getAttribute("aria-pressed")).toBe("false");
  });

  it("🔴 Repeat is cleared and says why", async () => {
    await open();
    await screen.findByRole("button", { name: "One more" });
    fireEvent.click(screen.getByRole("button", { name: "Repeat appointment" }));
    expect(screen.getByLabelText("Repeat every how many weeks")).toBeTruthy();
    more();
    await screen.findByText(/These all book for this one day/);
    expect(screen.queryByLabelText("Repeat every how many weeks")).toBeNull();
    // Back at 1 it is off, not quietly on again behind the count.
    fewer();
    await screen.findByRole("button", { name: "Repeat appointment" });
    expect(screen.queryByLabelText("Repeat every how many weeks")).toBeNull();
  });

  it("🔴 picking a special puts the count back to 1: it is one time, at its own price", async () => {
    getDaySpecials.mockResolvedValue({ ok: true, specials: [SPECIAL] });
    getSlots.mockImplementation(async (...a: unknown[]) => ({
      ok: true,
      slots: a[5] ? [FOUR_AT_THREE] : [ONE_AT_THREE],
      specials: [],
    }));
    await open();
    const row = await screen.findByRole("button", { name: /Early bird/ });
    more();
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "How many back to back" }).textContent).toContain("1"),
    );
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(createRun).not.toHaveBeenCalled();
    expect((create.mock.calls[0]![0] as Record<string, unknown>).targetedSlotId).toBe("ts-am");
  });

  it("🔴 Custom time has no price field in a run, and a typed price is not sent", async () => {
    await open();
    await screen.findByRole("button", { name: /^3:00 PM/ });
    fireEvent.click(screen.getByRole("button", { name: /Custom time/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Price" }), { target: { value: "120" } });
    more();
    expect(screen.queryByRole("textbox", { name: "Price" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Custom date and time"), { target: { value: "2026-10-02T22:00" } });
    nameIt();
    schedule();
    await waitFor(() => expect(createRun).toHaveBeenCalledTimes(1));
    expect(runArgs().customTime).toBe(true);
    expect(runArgs()).not.toHaveProperty("price");
    fewer();
    expect((screen.getByRole("textbox", { name: "Price" }) as HTMLInputElement).value).toBe("");
  });
});
