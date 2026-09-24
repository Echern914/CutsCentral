import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";
import type { DashSlot, DashSpecial } from "./actions";

type SlotsReply = { ok: boolean; slots?: DashSlot[]; specials?: DashSpecial[] };
type CreateReply = { ok: boolean; error?: string };

const getSlots = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]) => ({ ok: true, slots: [], specials: [] }) as SlotsReply),
);
const create = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ ok: true }) as CreateReply),
);
vi.mock("./actions", () => ({
  getDashSlotsAction: getSlots,
  createAppointmentAction: create,
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
}));

const { AppointmentForm, formatSpecialPrice } = await import("./AppointmentForm");

/**
 * The New appointment form's SPECIALS. A live shop: "there's a targeted slot
 * open on my website, and when I go to book somebody, the targeted slots don't
 * show up." The grid subtracts specials on purpose and Custom time is refused
 * over one, so the form needs its own list - and it must never book something
 * as a special, at a special's price, that the barber did not pick as one.
 */
const TZ = "America/New_York";
// Friday Oct 2 2026, 10:00 AM in New York - the tapped calendar hour.
const PREFILL = "2026-10-02T14:00:00.000Z";
const REGULAR: DashSlot = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" }; // 11 AM
const SPECIAL: DashSpecial = {
  id: "ts1",
  startsAt: "2026-10-03T00:00:00.000Z", // 8:00 PM Oct 2 in New York - after hours
  endsAt: "2026-10-03T00:45:00.000Z",
  durationMin: 45,
  price: 60,
  label: "Late night retwist",
};
const NEXT_DAY_SPECIAL: DashSpecial = {
  ...SPECIAL,
  id: "ts-next",
  startsAt: "2026-10-04T00:00:00.000Z", // 8:00 PM Oct 3 - a different shop day
  endsAt: "2026-10-04T00:45:00.000Z",
  label: "Tomorrow's special",
};

const staff: StaffRow[] = [
  { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 },
];
// The form reads only these fields of a service.
const services = [
  { id: "svc1", name: "Retwist", durationMin: 30, price: 80, active: true },
] as unknown as ServiceRow[];

function open() {
  render(
    <AppointmentForm
      staff={staff}
      services={services}
      timezone={TZ}
      prefillISO={PREFILL}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return screen.findByRole("dialog");
}

const specialsGroup = () => screen.getByRole("group", { name: "Specials" });
const nameIt = () => fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const sent = () => create.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  getSlots.mockReset();
  create.mockReset();
  getSlots.mockResolvedValue({ ok: true, slots: [REGULAR], specials: [SPECIAL, NEXT_DAY_SPECIAL] });
  create.mockResolvedValue({ ok: true });
});

describe("the day's specials are listed", () => {
  it("above the regular times, with their own label, length and price", async () => {
    await open();
    const group = await screen.findByRole("group", { name: "Specials" });
    expect(within(group).getByText("8:00 PM")).toBeTruthy();
    expect(within(group).getByText("Late night retwist · 45 min")).toBeTruthy();
    expect(within(group).getByText("$60")).toBeTruthy();
    // The regular grid is still there.
    expect(screen.getByRole("button", { name: "11:00 AM" })).toBeTruthy();
  });

  it("only the tapped day's - a special on another shop day is not offered", async () => {
    await open();
    await screen.findByRole("group", { name: "Specials" });
    expect(screen.queryByText(/Tomorrow's special/)).toBeNull();
  });

  it("with only specials that day, it says there are no OTHER times - not 'no open times'", async () => {
    getSlots.mockResolvedValue({ ok: true, slots: [], specials: [SPECIAL] });
    await open();
    await screen.findByRole("group", { name: "Specials" });
    expect(screen.getByText(/No other open times this day/)).toBeTruthy();
    expect(screen.queryByText(/^No open times this day/)).toBeNull();
  });

  it("with neither, the old empty state stands", async () => {
    getSlots.mockResolvedValue({ ok: true, slots: [], specials: [] });
    await open();
    expect(await screen.findByText(/No open times this day/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Specials" })).toBeNull();
  });

  it("a special's price is exact - $62.50 is never shown as $63", () => {
    expect(formatSpecialPrice(60)).toBe("$60");
    expect(formatSpecialPrice(62.5)).toBe("$62.50");
  });
});

describe("booking one", () => {
  it("🔴 picking a special sends ITS id and time - never a forced custom time", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: /8:00 PM/ }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({
      targetedSlotId: "ts1",
      startsAt: SPECIAL.startsAt,
      customTime: false,
      staffId: "stf1",
      serviceId: "svc1",
    });
    expect(sent().recurrence).toBeUndefined();
  });

  it("a regular time sends no special at all", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBeUndefined();
    expect(sent().startsAt).toBe(REGULAR.startsAt);
  });

  it("🔴 switching from a special to a regular time forgets the special", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: /8:00 PM/ }));
    fireEvent.click(screen.getByRole("button", { name: "11:00 AM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBeUndefined();
    expect(sent().startsAt).toBe(REGULAR.startsAt);
  });

  it("🔴 switching to Custom time forgets the special", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: /8:00 PM/ }));
    fireEvent.click(screen.getByRole("button", { name: "Custom time" }));
    fireEvent.change(screen.getByLabelText("Custom date and time"), {
      target: { value: "2026-10-02T19:00" },
    });
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBeUndefined();
    expect(sent().customTime).toBe(true);
  });

  it("a special does not repeat - Weekly is replaced by a sentence, and nothing recurring is sent", async () => {
    await open();
    // Weekly first, then the special.
    fireEvent.click(await screen.findByRole("button", { name: "Weekly" }));
    fireEvent.click(within(specialsGroup()).getByRole("button", { name: /8:00 PM/ }));
    expect(screen.getByText(/A special is a one-off time/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Weekly" })).toBeNull();
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().recurrence).toBeUndefined();
  });

  it("a special taken in the meantime says so, in words about the special", async () => {
    create.mockResolvedValue({ ok: false, error: "slot_taken" });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: /8:00 PM/ }));
    nameIt();
    schedule();
    expect(await screen.findByText(/That special was just booked or taken off/)).toBeTruthy();
  });
});
