import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";
import type { DashSlot } from "./actions";

type SlotsReply = { ok: boolean; slots?: DashSlot[] };
type CreateReply = { ok: boolean; error?: string };

const getSlots = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true, slots: [] }) as SlotsReply),
);
const create = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as CreateReply),
);
vi.mock("./actions", () => ({
  getDashSlotsAction: getSlots,
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  createAppointmentAction: create,
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
}));

const { AppointmentForm } = await import("./AppointmentForm");

/**
 * "SEND THEM A CONFIRMATION" (Eric, 2026-10-20: a client the barber books
 * must hear about it). The API tells the client by itself; the form's only
 * part is the barber's way to say no - and to say nothing about a time that
 * has passed, which the API never announces.
 */
const TZ = "UTC";
function hourFromNow(hours: number): string {
  const d = new Date(Date.now() + hours * 3_600_000);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
const FUTURE = hourFromNow(72);
const PAST = hourFromNow(-48);

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [
  { id: "svc1", name: "Mens Haircut", durationMin: 30, price: 50, active: true },
] as unknown as ServiceRow[];

function open(prefill: string) {
  render(
    <AppointmentForm
      staff={[DEE]}
      services={services}
      timezone={TZ}
      prefillISO={prefill}
      tapped
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return screen.findByRole("dialog");
}

const nameIt = () => fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const sent = () => create.mock.calls[0]![0] as Record<string, unknown>;
const box = () => screen.getByRole("checkbox", { name: /Send them a confirmation/ });

beforeEach(() => {
  getSlots.mockReset();
  create.mockReset();
  // The tapped hour is an open time, so it is already the pick.
  getSlots.mockResolvedValue({
    ok: true,
    slots: [{ startsAt: FUTURE, endsAt: new Date(Date.parse(FUTURE) + 30 * 60_000).toISOString() }],
  });
  create.mockResolvedValue({ ok: true });
});

describe("Send them a confirmation", () => {
  it("🔴 ticked by default, and a default booking leaves it to the API (no flag sent)", async () => {
    await open(FUTURE);
    expect((box() as HTMLInputElement).checked).toBe(true);
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().startsAt).toBe(FUTURE);
    expect(sent()).not.toHaveProperty("notifyClient");
  });

  it("🔴 unticked: the booking says notifyClient false", async () => {
    await open(FUTURE);
    fireEvent.click(box());
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().notifyClient).toBe(false);
  });

  it("a time that has passed says no confirmation is sent, and offers no box", async () => {
    getSlots.mockResolvedValue({ ok: true, slots: [] });
    await open(PAST);
    expect(screen.getByText("This time has passed, so no confirmation is sent.")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Send them a confirmation/ })).toBeNull();
  });
});

describe("a new client's email", () => {
  it("🔴 is sent with the booking, so the confirmation has somewhere to go", async () => {
    await open(FUTURE);
    nameIt();
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), { target: { value: " casey@example.com " } });
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().email).toBe("casey@example.com");
  });

  it("one that can't be an address is refused here, and nothing is booked", async () => {
    await open(FUTURE);
    nameIt();
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), { target: { value: "casey@" } });
    schedule();
    expect(await screen.findByText("That email doesn't look right. Fix it, or leave it blank.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });
});
