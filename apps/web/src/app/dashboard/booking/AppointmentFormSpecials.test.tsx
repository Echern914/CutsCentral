import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const { AppointmentForm, formatSpecialPrice } = await import("./AppointmentForm");

/**
 * The New appointment form's SPECIALS. A live shop, twice:
 *   "there's a targeted slot open on my website, and when I go to book
 *    somebody, the targeted slots don't show up" - and then, looking at a form
 *   with no service picked: "a way where I can book from special slots open
 *   for the day?"
 *
 * So the day's specials are listed whatever service is picked - before one is
 * picked at all - and tapping one picks its provider and service. What must
 * never happen: something booked as a special, at a special's price, that the
 * barber did not pick as one, or under a service the special is not offered as.
 */
const TZ = "America/New_York";
// Friday Oct 2 2026, 10:00 AM in New York - the tapped calendar hour.
const PREFILL = "2026-10-02T14:00:00.000Z";
const REGULAR: DashSlot = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" }; // 11 AM

const RETWIST_SPECIAL: DaySpecial = {
  id: "ts1",
  staffId: "stf1",
  serviceIds: ["svc1"],
  startsAt: "2026-10-03T00:00:00.000Z", // 8:00 PM Oct 2 in New York - after hours
  endsAt: "2026-10-03T00:45:00.000Z",
  durationMin: 45,
  price: 60,
  label: "Late night retwist",
};
const BRAIDS_SPECIAL: DaySpecial = {
  id: "ts2",
  staffId: "stf1",
  serviceIds: ["svc2"],
  startsAt: "2026-10-03T01:00:00.000Z", // 9:00 PM
  endsAt: "2026-10-03T02:00:00.000Z",
  durationMin: 60,
  price: 90,
  label: "Braids special",
};
const NEXT_DAY_SPECIAL: DaySpecial = {
  ...RETWIST_SPECIAL,
  id: "ts-next",
  startsAt: "2026-10-04T00:00:00.000Z", // 8:00 PM Oct 3 - a different shop day
  endsAt: "2026-10-04T00:45:00.000Z",
  label: "Tomorrow's special",
};

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const KAI: StaffRow = { id: "stf2", name: "Kai", bio: null, imageUrl: null, active: true, sortOrder: 1 };
// Two services, so neither is pre-selected - the screenshot's starting state.
// The form reads only these fields of a service.
const services = [
  { id: "svc1", name: "Retwist", durationMin: 30, price: 80, active: true },
  { id: "svc2", name: "Braids", durationMin: 60, price: 120, active: true },
] as unknown as ServiceRow[];

function open(staff: StaffRow[] = [DEE]) {
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

const specialsGroup = () => screen.findByRole("group", { name: "Specials" });
const tap = async (name: RegExp) =>
  fireEvent.click(within(await specialsGroup()).getByRole("button", { name }));
const pickService = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
const nameIt = () => fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const sent = () => create.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  getSlots.mockReset();
  getDaySpecials.mockReset();
  create.mockReset();
  getSlots.mockResolvedValue({ ok: true, slots: [REGULAR] });
  getDaySpecials.mockResolvedValue({
    ok: true,
    specials: [RETWIST_SPECIAL, BRAIDS_SPECIAL, NEXT_DAY_SPECIAL],
  });
  create.mockResolvedValue({ ok: true });
});

describe("the day's specials are listed", () => {
  it("🔴 before ANY service is picked - every service's specials, each naming its service", async () => {
    await open();
    const group = await specialsGroup();
    expect(within(group).getByText("8:00 PM")).toBeTruthy();
    expect(within(group).getByText("Late night retwist · Retwist · 45 min")).toBeTruthy();
    expect(within(group).getByText("$60")).toBeTruthy();
    expect(within(group).getByText("9:00 PM")).toBeTruthy();
    expect(within(group).getByText("Braids special · Braids · 60 min")).toBeTruthy();
    // And it asks for a service for the REST - never "no open times", which
    // is what this screen said while nothing had been asked for yet.
    expect(screen.getByText("Pick a service to see its regular times.")).toBeTruthy();
    expect(screen.queryByText(/No open times this day/)).toBeNull();
  });

  it("only the tapped day's - a special on another shop day is not offered", async () => {
    await open();
    await specialsGroup();
    expect(screen.queryByText(/Tomorrow's special/)).toBeNull();
  });

  it("with no specials and no service, it asks for a service", async () => {
    getDaySpecials.mockResolvedValue({ ok: true, specials: [] });
    await open();
    expect(await screen.findByText("Pick a service to see open times.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Specials" })).toBeNull();
  });

  it("with a service picked and nothing open, the old empty state stands", async () => {
    getDaySpecials.mockResolvedValue({ ok: true, specials: [] });
    getSlots.mockResolvedValue({ ok: true, slots: [] });
    await open();
    pickService("Retwist");
    expect(await screen.findByText(/^No open times this day/)).toBeTruthy();
  });

  it("with only specials that day, it says there are no OTHER times", async () => {
    getSlots.mockResolvedValue({ ok: true, slots: [] });
    await open();
    pickService("Retwist");
    expect(await screen.findByText(/No other open times this day/)).toBeTruthy();
  });

  it("a special's price is exact - $62.50 is never shown as $63", () => {
    expect(formatSpecialPrice(60)).toBe("$60");
    expect(formatSpecialPrice(62.5)).toBe("$62.50");
  });
});

describe("booking one", () => {
  it("🔴 tapping a special PICKS ITS SERVICE, and sends its id and time - never a forced custom time", async () => {
    await open();
    await tap(/8:00 PM/);
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({
      targetedSlotId: "ts1",
      startsAt: RETWIST_SPECIAL.startsAt,
      serviceId: "svc1",
      staffId: "stf1",
      customTime: false,
    });
    expect(sent().recurrence).toBeUndefined();
  });

  it("🔴 a special under ANOTHER service switches the service to it", async () => {
    await open();
    pickService("Retwist");
    await tap(/9:00 PM/);
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ targetedSlotId: "ts2", serviceId: "svc2" });
  });

  it("a special offered under the service already picked keeps that service", async () => {
    getDaySpecials.mockResolvedValue({
      ok: true,
      specials: [{ ...RETWIST_SPECIAL, serviceIds: ["svc1", "svc2"] }],
    });
    await open();
    pickService("Braids");
    await tap(/8:00 PM/);
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ targetedSlotId: "ts1", serviceId: "svc2" });
  });

  it("🔴 switching to a service the special is NOT offered under forgets the special", async () => {
    await open();
    await tap(/8:00 PM/); // Retwist special -> Retwist picked
    pickService("Braids");
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBeUndefined();
    expect(sent().serviceId).toBe("svc2");
  });

  it("a regular time sends no special at all", async () => {
    await open();
    pickService("Retwist");
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBeUndefined();
    expect(sent().startsAt).toBe(REGULAR.startsAt);
  });

  it("🔴 switching from a special to a regular time forgets the special", async () => {
    await open();
    await tap(/8:00 PM/);
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBeUndefined();
    expect(sent().startsAt).toBe(REGULAR.startsAt);
  });

  it("🔴 switching to Custom time forgets the special", async () => {
    await open();
    await tap(/8:00 PM/);
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
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    await tap(/8:00 PM/);
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
    await tap(/8:00 PM/);
    nameIt();
    schedule();
    expect(await screen.findByText(/That special was just booked or taken off/)).toBeTruthy();
  });
});

describe("a shop with several providers", () => {
  const KAIS: DaySpecial = { ...RETWIST_SPECIAL, id: "ts-kai", staffId: "stf2" };

  it("lists every provider's specials, named, until one is picked - and tapping one picks the provider", async () => {
    getDaySpecials.mockResolvedValue({ ok: true, specials: [KAIS] });
    await open([DEE, KAI]);
    // Asked for every provider's, since none is picked yet.
    await waitFor(() => expect(getDaySpecials).toHaveBeenCalled());
    expect(getDaySpecials.mock.calls[0]![0]).toBeNull();
    const group = await specialsGroup();
    expect(within(group).getByText(/· Kai/)).toBeTruthy();

    await tap(/8:00 PM/);
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ targetedSlotId: "ts-kai", staffId: "stf2", serviceId: "svc1" });
  });

  it("🔴 switching to a provider the special is not theirs forgets it", async () => {
    getDaySpecials.mockResolvedValue({ ok: true, specials: [KAIS] });
    await open([DEE, KAI]);
    await tap(/8:00 PM/); // Kai's
    fireEvent.click(screen.getByRole("button", { name: "Dee" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBeUndefined();
    expect(sent().staffId).toBe("stf1");
  });
});
