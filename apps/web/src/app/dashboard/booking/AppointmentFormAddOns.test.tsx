import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AddOnRow, ServiceRow, StaffRow } from "./page";
import type { DashSlot, DaySpecial } from "./actions";

type SlotsReply = { ok: boolean; slots?: DashSlot[] };
type SpecialsReply = { ok: boolean; specials?: DaySpecial[] };
type CreateReply = {
  ok: boolean;
  error?: string;
  code?: string;
  reason?: string;
  conflicts?: string[];
  message?: string;
  confirmation?: string;
};

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
 * ADD-ONS IN THE BARBER'S NEW APPOINTMENT FORM. Eric: "when the barber creates
 * the appointment, the add-ons pop up when booking for a client."
 *
 *   - the picked service's add-ons appear, unticked - and only that service's;
 *   - ticking one shows the new total and length, and asks for open times
 *     WITH it, so a time that fits a haircut but not haircut + beard goes;
 *   - a new service starts with nothing ticked;
 *   - Schedule sends exactly what is ticked on screen.
 */
const TZ = "America/New_York";
const PREFILL = "2026-10-02T14:00:00.000Z"; // Fri 10:00 AM in New York
const AT_11: DashSlot = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" };
// Fits a 30-minute haircut before noon, not haircut + a 15-minute beard trim.
const AT_1130: DashSlot = { startsAt: "2026-10-02T15:30:00.000Z", endsAt: "2026-10-02T16:00:00.000Z" };

const DEE: StaffRow = { id: "stf1", name: "Dee", bio: null, imageUrl: null, active: true, sortOrder: 0 };
// Two services, so neither is pre-selected. The form reads only these fields.
const services = [
  { id: "svc1", name: "Haircut", durationMin: 30, price: 35, active: true },
  { id: "svc2", name: "Color", durationMin: 60, price: 80, active: true },
] as unknown as ServiceRow[];

const addOn = (over: Partial<AddOnRow> & Pick<AddOnRow, "id" | "name">): AddOnRow => ({
  durationMin: 0,
  price: null,
  serviceIds: [],
  active: true,
  sortOrder: 0,
  ...over,
});
const BEARD = addOn({ id: "ao-beard", name: "Beard trim", durationMin: 15, price: 10, serviceIds: ["svc1"] });
const TOWEL = addOn({ id: "ao-towel", name: "Hot towel", durationMin: 5, price: 5 }); // every service
const GLOSS = addOn({ id: "ao-gloss", name: "Gloss", durationMin: 20, price: 25, serviceIds: ["svc2"] });
const RETIRED = addOn({ id: "ao-old", name: "Retired rinse", durationMin: 10, price: 3, active: false });
const ALL = [BEARD, TOWEL, GLOSS, RETIRED];

function open(addOns: AddOnRow[] = ALL) {
  render(
    <AppointmentForm
      staff={[DEE]}
      services={services}
      addOns={addOns}
      timezone={TZ}
      prefillISO={PREFILL}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={vi.fn()}
    />,
  );
  return screen.findByRole("dialog");
}

const pickService = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
const addOnsGroup = () => screen.getByRole("group", { name: "Add-ons" });
const addOnButton = (name: string) =>
  within(addOnsGroup()).getByRole("button", { name: new RegExp(`^${name}`) });
const total = () => screen.queryByText("Total")?.closest("[data-qa='add-on-total']") ?? null;
const lastSlotsCall = () => getSlots.mock.calls.at(-1)!;
const nameIt = () => fireEvent.change(screen.getByPlaceholderText("Name"), { target: { value: "Casey" } });
const schedule = () => fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
const sent = () => create.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  getSlots.mockReset();
  getDaySpecials.mockReset();
  create.mockReset();
  // The API's answer: a beard trim makes the haircut 45 minutes, and 11:30 no
  // longer fits before the barber's noon break.
  getSlots.mockImplementation(async (...a: unknown[]) => {
    const addOnIds = (a[4] as string[] | undefined) ?? [];
    return { ok: true, slots: addOnIds.includes(BEARD.id) ? [AT_11] : [AT_11, AT_1130] };
  });
  getDaySpecials.mockResolvedValue({ ok: true, specials: [] });
  create.mockResolvedValue({ ok: true });
});

describe("which add-ons appear", () => {
  it("🔴 only the picked service's, unticked - none before a service, never a switched-off one", async () => {
    await open();
    expect(screen.queryByRole("group", { name: "Add-ons" })).toBeNull();

    pickService("Haircut");
    expect(addOnButton("Beard trim")).toHaveAttribute("aria-pressed", "false");
    expect(addOnButton("Hot towel")).toHaveAttribute("aria-pressed", "false");
    expect(within(addOnsGroup()).queryByRole("button", { name: /^Gloss/ })).toBeNull();
    expect(within(addOnsGroup()).queryByRole("button", { name: /^Retired rinse/ })).toBeNull();
    // Name, then what it adds.
    expect(within(addOnButton("Beard trim")).getByText("+$10 · +15 min")).toBeInTheDocument();
    expect(total()).toBeNull();

    pickService("Color");
    expect(addOnButton("Gloss")).toHaveAttribute("aria-pressed", "false");
    expect(addOnButton("Hot towel")).toHaveAttribute("aria-pressed", "false");
    expect(within(addOnsGroup()).queryByRole("button", { name: /^Beard trim/ })).toBeNull();
  });

  it("a service with no add-ons shows no add-ons card at all", async () => {
    await open([GLOSS, RETIRED]);
    pickService("Haircut");
    expect(screen.queryByRole("group", { name: "Add-ons" })).toBeNull();
    expect(screen.queryByText("Add-ons")).toBeNull();
  });
});

describe("ticking one", () => {
  it("🔴 shows the total and length, and re-asks for times WITH it - a time that only fits without it goes", async () => {
    await open();
    pickService("Haircut");
    expect(await screen.findByRole("button", { name: "11:30 AM" })).toBeInTheDocument();
    expect(lastSlotsCall()[4]).toEqual([]);

    fireEvent.click(addOnButton("Beard trim"));
    expect(addOnButton("Beard trim")).toHaveAttribute("aria-pressed", "true");
    expect(total()).toHaveTextContent("Haircut + Beard trim");
    expect(total()).toHaveTextContent("45 min · $45");

    // Asked again, by id - the API works out the minutes - and 11:30 is gone.
    await waitFor(() => expect(lastSlotsCall()[4]).toEqual([BEARD.id]));
    expect(lastSlotsCall().slice(0, 2)).toEqual(["stf1", "svc1"]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "11:30 AM" })).toBeNull());
    expect(screen.getByRole("button", { name: "11:00 AM" })).toBeInTheDocument();

    // Two add-ons add up.
    fireEvent.click(addOnButton("Hot towel"));
    expect(total()).toHaveTextContent("Haircut + Beard trim + Hot towel");
    expect(total()).toHaveTextContent("50 min · $50");

    // Untick both: no total, and 11:30 is back.
    fireEvent.click(addOnButton("Beard trim"));
    fireEvent.click(addOnButton("Hot towel"));
    expect(total()).toBeNull();
    expect(await screen.findByRole("button", { name: "11:30 AM" })).toBeInTheDocument();
  });

  it("with no time long enough, says it is the add-ons", async () => {
    getSlots.mockImplementation(async (...a: unknown[]) => ({
      ok: true,
      slots: ((a[4] as string[] | undefined) ?? []).length > 0 ? [] : [AT_11],
    }));
    await open();
    pickService("Haircut");
    await screen.findByRole("button", { name: "11:00 AM" });
    fireEvent.click(addOnButton("Beard trim"));
    expect(
      await screen.findByText(/No open times this day long enough with the add-ons\./),
    ).toBeInTheDocument();
  });
});

describe("changing the service", () => {
  it("🔴 clears every tick - even an add-on both services offer", async () => {
    await open();
    pickService("Haircut");
    fireEvent.click(addOnButton("Beard trim"));
    fireEvent.click(addOnButton("Hot towel"));
    expect(total()).not.toBeNull();

    pickService("Color");
    expect(addOnButton("Hot towel")).toHaveAttribute("aria-pressed", "false");
    expect(total()).toBeNull();
    await waitFor(() => expect(lastSlotsCall().slice(1)).toEqual(["svc2", expect.any(String), expect.any(String), []]));

    pickService("Haircut");
    expect(addOnButton("Beard trim")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Schedule", () => {
  it("🔴 sends the ticked add-ons, for the time picked", async () => {
    await open();
    pickService("Haircut");
    fireEvent.click(addOnButton("Beard trim"));
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({
      serviceId: "svc1",
      staffId: "stf1",
      startsAt: AT_11.startsAt,
      addOnIds: [BEARD.id],
    });
    expect(sent().recurrence).toBeUndefined();
  });

  it("sends no add-ons when none are ticked", async () => {
    await open();
    pickService("Haircut");
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().addOnIds).toBeUndefined();
  });

  it("a visit with add-ons does not repeat - the Repeat card says so and no series is sent", async () => {
    await open();
    pickService("Haircut");
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    fireEvent.click(addOnButton("Beard trim"));
    expect(screen.getByText("Add-ons are for a single visit, so this one doesn't repeat.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Weekly" })).toBeNull();
    expect(screen.queryByText("appointments total")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().recurrence).toBeUndefined();
    expect(sent().addOnIds).toEqual([BEARD.id]);
  });

  it("a special carries no add-ons - it has its own length and price", async () => {
    const special: DaySpecial = {
      id: "ts1",
      staffId: "stf1",
      serviceIds: ["svc1"],
      startsAt: "2026-10-03T00:00:00.000Z", // 8:00 PM
      endsAt: "2026-10-03T00:45:00.000Z",
      durationMin: 45,
      price: 60,
      label: "Late cut",
    };
    getDaySpecials.mockResolvedValue({ ok: true, specials: [special] });
    await open();
    pickService("Haircut");
    fireEvent.click(addOnButton("Beard trim"));
    const specials = await screen.findByRole("group", { name: "Specials" });
    fireEvent.click(within(specials).getByRole("button", { name: /8:00 PM/ }));
    expect(screen.getByText("A special has its own length and price, so add-ons don't apply.")).toBeInTheDocument();
    nameIt();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(sent().targetedSlotId).toBe("ts1");
    expect(sent().addOnIds).toBeUndefined();

    // Back to a regular time: the special took the ticks with it - nothing
    // he ticked before it comes back on its own.
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    expect(addOnButton("Beard trim")).toHaveAttribute("aria-pressed", "false");
  });

  it("🔴 a slow answer for an older choice never overwrites the newer one", async () => {
    // Beard's answer is slow; Beard + towel's comes first. When Beard's
    // finally lands it must not put 11:30 back on screen.
    let releaseBeardOnly!: () => void;
    getSlots.mockImplementation(async (...a: unknown[]) => {
      const ids = (a[4] as string[] | undefined) ?? [];
      if (ids.length === 1 && ids[0] === BEARD.id) {
        await new Promise<void>((r) => (releaseBeardOnly = r));
        return { ok: true, slots: [AT_11, AT_1130] };
      }
      return { ok: true, slots: ids.length > 0 ? [AT_11] : [AT_11, AT_1130] };
    });
    await open();
    pickService("Haircut");
    await screen.findByRole("button", { name: "11:30 AM" });
    fireEvent.click(addOnButton("Beard trim"));
    fireEvent.click(addOnButton("Hot towel"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "11:30 AM" })).toBeNull());
    await waitFor(() => expect(releaseBeardOnly).toBeTypeOf("function"));
    releaseBeardOnly();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "11:30 AM" })).toBeNull();
  });

  it("🔴 Book anyway keeps the add-ons - and ticking another asks again, since the length changed", async () => {
    create.mockResolvedValueOnce({
      ok: false,
      error: "slot_taken",
      code: "OVERLAP",
      reason: "That time overlaps what's already on your calendar:",
      conflicts: ["Marcus R. - Fade, 10:30 AM - 11:00 AM"],
      message: "This overlaps Marcus R. at 10:30 AM. Book it anyway?",
      confirmation: "digest-1",
    });
    const dialog = await open();
    pickService("Haircut");
    fireEvent.click(addOnButton("Beard trim"));
    fireEvent.click(screen.getByRole("button", { name: "Custom time" }));
    nameIt();
    schedule();
    const banner = await within(dialog).findByRole("alertdialog");
    fireEvent.click(within(banner).getByRole("button", { name: "Book anyway" }));
    fireEvent.click(await within(banner).findByRole("button", { name: "Yes, book it" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toMatchObject({
      customTime: true,
      addOnIds: [BEARD.id],
      overlapConfirmation: "digest-1",
    });

    // That yes answered "this time, at THIS length". Refused again, then a
    // longer visit: the banner goes, and the old answer is not sent with it.
    create.mockResolvedValueOnce({
      ok: false,
      error: "slot_taken",
      code: "OVERLAP",
      reason: "That time overlaps what's already on your calendar:",
      message: "Book it anyway?",
      confirmation: "digest-2",
    });
    schedule();
    await within(dialog).findByRole("alertdialog");
    fireEvent.click(addOnButton("Hot towel"));
    expect(within(dialog).queryByRole("alertdialog")).toBeNull();
    schedule();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(4));
    expect(create.mock.calls[3]![0]).toMatchObject({ addOnIds: [BEARD.id, TOWEL.id] });
    expect((create.mock.calls[3]![0] as Record<string, unknown>).overlapConfirmation).toBeUndefined();
  });

  it("a time the add-ons no longer fit is refused in words about the add-ons", async () => {
    create.mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    await open();
    pickService("Haircut");
    fireEvent.click(addOnButton("Beard trim"));
    nameIt();
    schedule(); // the tapped 10:00 AM, never checked against the list
    expect(await screen.findByText(/That time is too short with the add-ons\./)).toBeInTheDocument();
  });
});
