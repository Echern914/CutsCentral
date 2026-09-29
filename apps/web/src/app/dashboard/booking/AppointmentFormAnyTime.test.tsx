import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";
import type { DashSlot, DaySpecial } from "./actions";

type SlotsReply = { ok: boolean; slots?: DashSlot[] };
type SpecialsReply = { ok: boolean; specials?: DaySpecial[] };
type CreateReply = { ok: boolean; error?: string };

const getSlots = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true, slots: [] }) as SlotsReply),
);
const getDaySpecials = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true, specials: [] }) as SpecialsReply),
);
const create = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as CreateReply),
);
vi.mock("./actions", () => ({
  getDashSlotsAction: getSlots,
  getDaySpecialsAction: getDaySpecials,
  createAppointmentAction: create,
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
}));

const { AppointmentForm } = await import("./AppointmentForm");

/**
 * BOOKING AFTER HOURS, AT HIS PRICE. A live shop, 2026-09-29: a client wanted
 * 10 PM, after the barber's hours. He tapped the 10 PM row and got a list
 * without 10 PM on it - "I can't book it after hours". Custom time could, but
 * it was small print, and it booked at the menu price instead of his
 * after-hours rate.
 *
 * So: an hour he TAPPED that is not an open time is offered as itself, Custom
 * time takes a price, and the lists cover the whole day whatever hour opened
 * the form (opened at 10 PM, they used to start at 10 AM).
 */
const TZ = "America/New_York";
// Friday Oct 2 2026, 10:00 PM in New York - the tapped row.
const TEN_PM = "2026-10-03T02:00:00.000Z";
const SEVEN_PM: DashSlot = { startsAt: "2026-10-02T23:00:00.000Z", endsAt: "2026-10-02T23:30:00.000Z" };
const MORNING_SPECIAL: DaySpecial = {
  id: "ts-am",
  staffId: "stf1",
  serviceIds: ["svc1"],
  startsAt: "2026-10-02T13:00:00.000Z", // 9:00 AM Oct 2 in New York
  endsAt: "2026-10-02T13:30:00.000Z",
  durationMin: 30,
  price: 60,
  label: "Early bird",
};

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
// One service and one barber: both are picked for him, as on a solo shop.
const services = [
  { id: "svc1", name: "Mens Haircut", durationMin: 30, price: 50, active: true },
] as unknown as ServiceRow[];

function open({ prefill = TEN_PM, tapped = true }: { prefill?: string; tapped?: boolean } = {}) {
  render(
    <AppointmentForm
      staff={[DEE]}
      services={services}
      timezone={TZ}
      prefillISO={prefill}
      tapped={tapped}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return screen.findByRole("dialog");
}

const bookTapped = () => screen.findByRole("button", { name: /Book this time/ });
const nameIt = () => fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const sent = () => create.mock.calls[0]![0] as Record<string, unknown>;
const price = () => screen.getByRole("textbox", { name: "Price" });

beforeEach(() => {
  getSlots.mockReset();
  getDaySpecials.mockReset();
  create.mockReset();
  getSlots.mockResolvedValue({ ok: true, slots: [SEVEN_PM] });
  getDaySpecials.mockResolvedValue({ ok: true, specials: [] });
  create.mockResolvedValue({ ok: true });
});

describe("the hour he tapped is offered when it isn't an open time", () => {
  it("🔴 tapped 10 PM, not open: shown as itself, and one tap books exactly that time", async () => {
    await open();
    const offer = await bookTapped();
    expect(offer.textContent).toContain("10:00 PM");
    expect(offer.textContent).toContain("The time you tapped");
    fireEvent.click(offer);
    // It becomes a Custom time, already on 10 PM that day.
    const input = screen.getByLabelText("Custom date and time") as HTMLInputElement;
    expect(input.value).toBe("2026-10-02T22:00");
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().startsAt).toBe(TEN_PM);
    expect(sent().customTime).toBe(true);
    expect(sent().targetedSlotId).toBeUndefined();
  });

  it("not when it IS an open time - that chip is already the pick", async () => {
    getSlots.mockResolvedValue({ ok: true, slots: [SEVEN_PM, { startsAt: TEN_PM, endsAt: "2026-10-03T02:30:00.000Z" }] });
    await open();
    await screen.findByRole("button", { name: "10:00 PM" });
    expect(screen.queryByRole("button", { name: /Book this time/ })).toBeNull();
  });

  it("not for the + New appointment button's default start - that is not a time he chose", async () => {
    await open({ tapped: false });
    await screen.findByRole("button", { name: "7:00 PM" });
    expect(screen.queryByRole("button", { name: /Book this time/ })).toBeNull();
  });
});

describe("Custom time takes his price", () => {
  it("🔴 a typed price is sent with the booking", async () => {
    await open();
    fireEvent.click(await bookTapped());
    fireEvent.change(price(), { target: { value: "$60" } });
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().price).toBe(60);
  });

  it("blank sends no price - the service's own", async () => {
    await open();
    fireEvent.click(await bookTapped());
    expect(screen.getByText(/Leave blank for the regular \$50/)).toBeTruthy();
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().price).toBeUndefined();
  });

  it("a price that isn't a number is refused before anything is sent", async () => {
    await open();
    fireEvent.click(await bookTapped());
    fireEvent.change(price(), { target: { value: "sixty" } });
    nameIt();
    schedule();
    expect(await screen.findByText("Enter a price like 45 or 45.50")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("a price with Repeat is refused - it is for one visit", async () => {
    await open();
    fireEvent.click(await bookTapped());
    fireEvent.change(price(), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    nameIt();
    schedule();
    expect(await screen.findByText(/A typed price is for one visit/)).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  it("🔴 back on the open times, a price typed earlier is NOT sent", async () => {
    await open();
    fireEvent.click(await bookTapped());
    fireEvent.change(price(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Pick from open slots" }));
    fireEvent.click(await screen.findByRole("button", { name: "7:00 PM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().customTime).toBe(false);
    expect(sent().price).toBeUndefined();
  });
});

describe("the lists cover the whole day, whatever hour opened the form", () => {
  it("🔴 opened from the 10 PM row, the day's 9 AM special is still listed", async () => {
    getDaySpecials.mockResolvedValue({ ok: true, specials: [MORNING_SPECIAL] });
    await open();
    expect(await screen.findByText("9:00 AM")).toBeTruthy();
    // Midnight Oct 2 in New York is 04:00Z: the window starts an hour before it
    // and runs 26 hours - never "10 PM minus 12 hours".
    const [, from, to] = getDaySpecials.mock.calls[0]!;
    expect(from).toBe("2026-10-02T03:00:00.000Z");
    expect(to).toBe("2026-10-03T06:00:00.000Z");
    const [, , slotsFrom, slotsTo] = getSlots.mock.calls[0]!;
    expect([slotsFrom, slotsTo]).toEqual([from, to]);
  });
});
