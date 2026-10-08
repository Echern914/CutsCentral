import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";
import type { DashSlot } from "./actions";

type CreateReply = {
  ok: boolean;
  id?: string;
  startsAt?: string;
  answered?: boolean;
  error?: string;
  reason?: string;
  booked?: { id: string; startsAt: string; endsAt: string };
};

const getSlots = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true, slots: [] as DashSlot[] })),
);
const create = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>): Promise<CreateReply> => ({ ok: true })),
);
vi.mock("./actions", () => ({
  getDashSlotsAction: getSlots,
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  createAppointmentAction: create,
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
}));

const { AppointmentForm } = await import("./AppointmentForm");
type Rebook = NonNullable<Parameters<typeof AppointmentForm>[0]["rebook"]>;

/**
 * BOOK AGAIN, from an appointment's Full details: the client's next visit,
 * booked while they are still in the chair. Who and what carry over (while
 * still offered); the old time, price, payment and status never do - the form
 * starts with no time, so the barber picks the new day and time.
 */
const TZ = "America/New_York";
const PREFILL = "2026-10-02T16:00:00.000Z"; // Fri Oct 2, noon in New York
const AT_11: DashSlot = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" };
const NEXT_FRI_11: DashSlot = { startsAt: "2026-10-09T15:00:00.000Z", endsAt: "2026-10-09T15:30:00.000Z" };

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const SAM: StaffRow = { id: "stf2", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 1 };
const services = [
  { id: "svc1", name: "Haircut", durationMin: 30, price: 35, active: true },
  { id: "svc2", name: "Color", durationMin: 60, price: 80, active: true },
  { id: "svc-old", name: "Old cut", durationMin: 30, price: 20, active: false },
] as unknown as ServiceRow[];

const FROM: Rebook = {
  clientId: "c1",
  clientLabel: "Jordan Q",
  serviceId: "svc1",
  serviceName: "Haircut",
  staffId: "stf1",
  staffName: "Dee",
};

function open(rebook: Rebook = FROM, onCreated = vi.fn(), toast = vi.fn()) {
  render(
    <AppointmentForm
      staff={[DEE, SAM]}
      services={services}
      timezone={TZ}
      prefillISO={PREFILL}
      rebook={rebook}
      onClose={vi.fn()}
      onCreated={onCreated}
      toast={toast}
    />,
  );
  return { onCreated, toast };
}

const bookNext = () => fireEvent.click(screen.getByRole("button", { name: "Book next visit" }));
const sentAt = (i: number) => create.mock.calls[i]![0] as Record<string, unknown>;

beforeEach(() => {
  getSlots.mockReset();
  create.mockReset();
  getSlots.mockImplementation(async (...a: unknown[]) => {
    const from = String(a[2]);
    return { ok: true, slots: from.startsWith("2026-10-09") ? [NEXT_FRI_11] : [AT_11] };
  });
  create.mockResolvedValue({ ok: true, id: "new1" });
});

describe("what Book again carries over", () => {
  it("the client, service and provider - and NO time: nothing books until one is picked", async () => {
    open();
    expect(await screen.findByRole("dialog", { name: "Book again" })).toBeInTheDocument();
    expect(screen.getByText(/Next visit for/)).toHaveTextContent("Next visit for Jordan Q. Pick the day and time.");
    expect(screen.getByText("The appointment you came from stays exactly as it is.")).toBeInTheDocument();

    await screen.findByRole("button", { name: "11:00 AM" });
    bookNext();
    expect(await screen.findByText("Pick a time.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    // Answered by picking one: the question goes away rather than sitting over
    // the time just tapped as if it were refused.
    fireEvent.click(screen.getByRole("button", { name: "11:00 AM" }));
    await waitFor(() => expect(screen.queryByText("Pick a time.")).toBeNull());
  });

  it("books the picked time for the SAME client, service and provider, and hands back the new booking", async () => {
    const { onCreated, toast } = open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    bookNext();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sentAt(0)).toMatchObject({
      clientId: "c1",
      serviceId: "svc1",
      staffId: "stf1",
      startsAt: AT_11.startsAt,
    });
    // An existing client: never a second client made from a typed name.
    expect(sentAt(0).firstName).toBeUndefined();
    expect(typeof sentAt(0).operationId).toBe("string");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "new1", startsAt: AT_11.startsAt }));
    expect(toast).toHaveBeenCalledWith("Next visit booked: Fri, Oct 2 at 11:00 AM", "success");
  });

  it("a retired service and a provider who left are named, never pre-picked", async () => {
    open({ ...FROM, serviceId: "svc-old", serviceName: "Old cut", staffId: "gone", staffName: "Max" });
    expect(await screen.findByText("Old cut isn't offered any more. Pick a service below.")).toBeInTheDocument();
    expect(screen.getByText("Max isn't taking bookings now. Pick a provider below.")).toBeInTheDocument();
    // Nothing chosen, so nothing is listed and nothing can be booked yet.
    bookNext();
    expect(await screen.findByText("Pick a service.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("another day lists that day's times, and forgets a time picked on the old one", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-10-09" } });
    await waitFor(() => expect(String(getSlots.mock.calls.at(-1)![2]).startsWith("2026-10-09")).toBe(true));
    bookNext();
    expect(await screen.findByText("Pick a time.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    bookNext();
    await waitFor(() => expect(sentAt(0).startsAt).toBe(NEXT_FRI_11.startsAt));
  });
});

describe("🔴 what the screen says is the SAVED booking", () => {
  it("success names and opens the booking as saved - not the time on screen", async () => {
    // A retry's answer: the first tap's booking, saved at a different time.
    create.mockResolvedValueOnce({ ok: true, id: "saved1", startsAt: NEXT_FRI_11.startsAt } as CreateReply);
    const { onCreated, toast } = open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    bookNext();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "saved1", startsAt: NEXT_FRI_11.startsAt }));
    expect(toast).toHaveBeenCalledWith("Next visit booked: Fri, Oct 9 at 11:00 AM", "success");
  });

  it("🔴 the id already booked something ELSE: names it, books nothing, and never claims this choice", async () => {
    create.mockResolvedValueOnce({
      ok: false,
      answered: true,
      error: "operation_mismatch",
      booked: { id: "old1", startsAt: AT_11.startsAt, endsAt: AT_11.endsAt },
    } as CreateReply);
    const { onCreated, toast } = open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    bookNext();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Your first tap already booked Fri, Oct 2 at 11:00 AM. Nothing new was booked.");
    expect(onCreated).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open that booking" }));
    expect(onCreated).toHaveBeenCalledWith({ id: "old1", startsAt: AT_11.startsAt });
  });

  it("after a mismatch, tapping again is a NEW submission (the barber chose to book this one too)", async () => {
    create.mockResolvedValueOnce({
      ok: false,
      answered: true,
      error: "operation_mismatch",
      booked: { id: "old1", startsAt: AT_11.startsAt, endsAt: AT_11.endsAt },
    } as CreateReply);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    bookNext();
    await screen.findByRole("alert");
    bookNext();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(sentAt(1).operationId).not.toBe(sentAt(0).operationId);
  });

  it("🔴 still settling: says so, and the next tap asks about THE SAME booking (keeps the id)", async () => {
    create.mockResolvedValueOnce({
      ok: false,
      answered: true,
      error: "operation_in_progress",
      booked: { id: "old1", startsAt: AT_11.startsAt, endsAt: AT_11.endsAt },
    } as CreateReply);
    const { onCreated } = open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    bookNext();
    expect(await screen.findByRole("alert")).toHaveTextContent("is still being confirmed with your calendar");
    expect(onCreated).not.toHaveBeenCalled();
    bookNext();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(sentAt(1).operationId).toBe(sentAt(0).operationId);
  });
});

describe("🔴 one submission, one booking", () => {
  it("a lost answer keeps the operationId for the retry; a real refusal starts a new one", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));

    create.mockResolvedValueOnce({ ok: false, answered: false, error: "network_error" });
    bookNext();
    expect(await screen.findByText(/No answer from ChairBack/)).toBeInTheDocument();

    create.mockResolvedValueOnce({ ok: false, answered: true, error: "slot_taken" });
    bookNext();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    // The retry of a request that never got an answer IS that request.
    expect(sentAt(1).operationId).toBe(sentAt(0).operationId);

    bookNext();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    // After an answered refusal nothing was booked: the next try is a new one.
    expect(sentAt(2).operationId).not.toBe(sentAt(1).operationId);
  });
});
