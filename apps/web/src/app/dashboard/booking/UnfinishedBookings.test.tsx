import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";

/**
 * "DIDN'T FINISH BOOKING", AS THE SHOP SEES IT.
 *
 * The API tests prove who is on the list. These prove the screen, and the
 * things they pin are the ones that cost a client or a booking when wrong:
 *
 *   * the time is read in the SHOP's zone, not the browser's;
 *   * Book them asks first, books exactly the time they wanted for exactly
 *     that client, and never forces anything - outside the open hours it asks
 *     again, and a time someone else has taken is never booked over;
 *   * a client who texted STOP gets no Text button, and Call stays;
 *   * a booking made here stays on screen with its Text button, because the
 *     client still has to be told.
 */
const listUnfinishedAction = vi.hoisted(() => vi.fn());
const dismissUnfinishedAction = vi.hoisted(() => vi.fn());
const inviteUnfinishedAction = vi.hoisted(() => vi.fn());
const createAppointmentAction = vi.hoisted(() => vi.fn());
vi.mock("./unfinishedActions", () => ({ listUnfinishedAction, dismissUnfinishedAction, inviteUnfinishedAction }));
vi.mock("./actions", () => ({ createAppointmentAction }));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { UnfinishedBookings } = await import("./UnfinishedBookings");

// Not the zone of the machine running this (CI runs in UTC, a laptop is often
// Eastern): a row formatted in the BROWSER's zone reads a different hour.
const TZ = "America/Los_Angeles";

const row = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  clientId: "c1",
  firstName: "Lena",
  lastName: "Ortiz",
  phone: "+13025550110",
  phoneDisplay: "(302) 555-0110",
  email: "lena@example.com",
  canText: true,
  profileName: null,
  staffId: "s1",
  staffName: "Sam",
  serviceId: "svc1",
  serviceName: "Haircut",
  addOns: [],
  // 4:30 PM in Los Angeles; 11:30 PM UTC.
  startsAt: "2026-10-09T23:30:00.000Z",
  endsAt: "2026-10-10T00:00:00.000Z",
  // 11:29 AM in Los Angeles.
  triedAt: "2026-10-04T18:29:00.000Z",
  attempts: 1,
  state: "lapsed",
  heldUntil: null,
  releasing: false,
  timeTaken: false,
  blockedElsewhere: false,
  reason: "card_not_saved",
  wantedSpecial: false,
  targetedSlotId: null,
  repeating: false,
  otherTimes: [],
  canInvite: false,
  invitedAt: null,
  ...over,
});

const listed = (rows: unknown[], more = 0) => ({ ok: true, data: { timezone: TZ, more, rows } });

let toast: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listUnfinishedAction.mockReset();
  dismissUnfinishedAction.mockReset();
  inviteUnfinishedAction.mockReset();
  createAppointmentAction.mockReset();
  listUnfinishedAction.mockResolvedValue(listed([row()]));
  dismissUnfinishedAction.mockResolvedValue({ ok: true });
  createAppointmentAction.mockResolvedValue({ ok: true });
  toast = vi.fn();
});

async function shown(isNative = true) {
  const view = render(<UnfinishedBookings isNative={isNative} toast={toast} />);
  await screen.findByRole("heading", { name: /didn't finish booking/i });
  return view;
}

const card = (name: RegExp) => screen.getByText(name).closest("li") as HTMLElement;

describe("when it shows", () => {
  it("renders nothing when nobody is on the list", async () => {
    listUnfinishedAction.mockResolvedValue(listed([]));
    const { container } = render(<UnfinishedBookings isNative toast={toast} />);
    await waitFor(() => expect(listUnfinishedAction).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the list can't be read - the calendar below still works", async () => {
    listUnfinishedAction.mockResolvedValue({ ok: false, error: "network_error" });
    const { container } = render(<UnfinishedBookings isNative toast={toast} />);
    await waitFor(() => expect(listUnfinishedAction).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe("what a row says", () => {
  it("🔴 who, the time they wanted IN THE SHOP'S ZONE, why, and how to reach them", async () => {
    await shown();
    const li = card(/Lena Ortiz/);
    expect(within(li).getByText(/Wanted Fri, Oct 9, 4:30 PM/)).toBeInTheDocument();
    expect(li).toHaveTextContent("Haircut");
    expect(li).toHaveTextContent("Sam");
    expect(li).toHaveTextContent("Didn't save a card. Tried Oct 4, 11:29 AM.");
    expect(within(li).getByText("Time open")).toBeInTheDocument();
    expect(within(li).getByRole("link", { name: "(302) 555-0110" })).toHaveAttribute("href", "sms:+13025550110");
    expect(within(li).getByRole("link", { name: "lena@example.com" })).toHaveAttribute("href", "mailto:lena@example.com");
    expect(within(li).getByRole("link", { name: "Text" })).toHaveAttribute("href", "sms:+13025550110");
    expect(within(li).getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:+13025550110");
    expect(within(li).getByRole("button", { name: "Book them" })).toBeInTheDocument();
    expect(within(li).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("🔴 a time someone else has taken says so, and offers no Book", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ timeTaken: true })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(within(li).getByText("Time taken")).toBeInTheDocument();
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
    expect(within(li).getByRole("link", { name: "Text" })).toBeInTheDocument();
    expect(within(li).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("a client on the card step right now: held until when, and nothing to book or dismiss yet", async () => {
    listUnfinishedAction.mockResolvedValue(
      listed([row({ state: "live", reason: null, heldUntil: "2026-10-04T23:10:00.000Z" })]),
    );
    await shown();
    const li = card(/Lena Ortiz/);
    expect(within(li).getByText("Booking now")).toBeInTheDocument();
    expect(li).toHaveTextContent("On the card step now. Held until 4:10 PM.");
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
    expect(within(li).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(within(li).getByRole("link", { name: "Call" })).toBeInTheDocument();
  });

  it("🔴 a client who texted STOP: no Text button and the number isn't a text link, but Call stays", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ canText: false })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(within(li).queryByRole("link", { name: "Text" })).toBeNull();
    expect(within(li).queryByRole("link", { name: "(302) 555-0110" })).toBeNull();
    expect(within(li).getByText("(302) 555-0110")).toBeInTheDocument();
    expect(within(li).getByRole("link", { name: "Call" })).toHaveAttribute("href", "tel:+13025550110");
  });

  it("tries counted and other times listed", async () => {
    listUnfinishedAction.mockResolvedValue(
      listed([
        row({
          attempts: 3,
          otherTimes: [{ startsAt: "2026-10-10T16:00:00.000Z", serviceName: "Haircut" }],
        }),
      ]),
    );
    await shown();
    const li = card(/Lena Ortiz/);
    expect(li).toHaveTextContent("· 3 tries");
    expect(li).toHaveTextContent("Also tried: Sat, Oct 10, 9:00 AM");
  });

  it("🔴 someone else's profile (a shared phone): says whose, and offers no Book", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ profileName: "Maria Lopez" })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(li).toHaveTextContent(
      "Uses the same number or email as Maria Lopez, so booking them here would put it under Maria Lopez's name.",
    );
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
    expect(within(li).getByRole("link", { name: "Text" })).toBeInTheDocument();
  });

  it("🔴 a hold that only just ran out: not bookable until it's released", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ releasing: true })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(li).toHaveTextContent("Their hold just ran out. You can book them here in a few minutes.");
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
    expect(within(li).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("time blocked on the other calendar: Blocked, and no Book", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ blockedElsewhere: true })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(within(li).getByText("Blocked")).toBeInTheDocument();
    expect(li).toHaveTextContent("That time is blocked on your other calendar.");
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
  });

  it("a client still checking out on a special is not told the special is gone", async () => {
    listUnfinishedAction.mockResolvedValue(
      listed([
        row({ state: "live", reason: null, heldUntil: "2026-10-04T23:10:00.000Z", wantedSpecial: true, targetedSlotId: null }),
      ]),
    );
    await shown();
    const li = card(/Lena Ortiz/);
    expect(within(li).getByText("Booking now")).toBeInTheDocument();
    expect(li).not.toHaveTextContent("isn't on offer");
  });

  it("🔴 a special that's no longer on offer is never booked as the plain service", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ wantedSpecial: true, targetedSlotId: null })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(li).toHaveTextContent("They wanted one of your specials, which isn't on offer at that time now.");
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
  });

  it("a repeating booking can't be booked from here", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ repeating: true })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(li).toHaveTextContent("repeating booking");
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
  });

  it("not on ChairBack booking: nothing to book here, still Text and Call", async () => {
    await shown(false);
    const li = card(/Lena Ortiz/);
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
    expect(within(li).getByRole("link", { name: "Text" })).toBeInTheDocument();
  });

  it("shows three, then all of them on request", async () => {
    listUnfinishedAction.mockResolvedValue(
      listed(
        ["a", "b", "c", "d", "e"].map((id, i) =>
          row({ id, firstName: `Person${i}`, startsAt: `2026-10-1${i}T15:00:00.000Z` }),
        ),
      ),
    );
    await shown();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show all 5" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("fits a phone: the row and its name can shrink and wrap", async () => {
    await shown();
    const li = card(/Lena Ortiz/);
    expect(li.className).toContain("min-w-0");
    expect(screen.getByText("Lena Ortiz").className).toContain("[overflow-wrap:anywhere]");
  });
});

describe("Book them", () => {
  it("🔴 asks first, then books exactly that time for that client - and nothing forced", async () => {
    createAppointmentAction.mockResolvedValue({ ok: true, clientConfirmation: "email" });
    await shown();
    // The re-read after booking no longer lists them: they're booked.
    listUnfinishedAction.mockResolvedValue(listed([]));
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    expect(createAppointmentAction).not.toHaveBeenCalled();
    expect(li).toHaveTextContent(
      "Book Lena for Fri, Oct 9, 4:30 PM? ChairBack emails them a confirmation if it has an email for them.",
    );
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(createAppointmentAction).toHaveBeenCalledTimes(1));
    expect(createAppointmentAction).toHaveBeenCalledWith({
      staffId: "s1",
      serviceId: "svc1",
      startsAt: "2026-10-09T23:30:00.000Z",
      clientId: "c1",
      // 🔴 They tried to book online and may think they are: tell them.
      confirmClient: true,
      // What they typed, so the reminders reach them.
      phone: "+13025550110",
      email: "lena@example.com",
    });
    await waitFor(() =>
      expect(li).toHaveTextContent("Booked for Fri, Oct 9, 4:30 PM. ChairBack emailed Lena a confirmation."),
    );
    expect(toast).toHaveBeenCalledWith("Booked Lena", "success");
    await waitFor(() => expect(listUnfinishedAction).toHaveBeenCalledTimes(2));
    // Still here after that re-read, with the button the client needs next.
    expect(screen.getByText("Lena Ortiz")).toBeInTheDocument();
    expect(within(li).getByRole("link", { name: "Text" })).toBeInTheDocument();
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
    fireEvent.click(within(li).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("Lena Ortiz")).toBeNull());
  });

  it("Cancel books nothing", async () => {
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Cancel" }));
    expect(createAppointmentAction).not.toHaveBeenCalled();
    expect(within(li).getByRole("button", { name: "Book them" })).toBeInTheDocument();
  });

  it("🔴 outside the open hours now: asks again, and only then books it anyway", async () => {
    createAppointmentAction.mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await within(li).findByText(
      "That time isn't open on your calendar now (for example it's outside your hours, blocked off, too soon, or the day is full). Book it anyway?",
    );
    expect(createAppointmentAction).toHaveBeenCalledTimes(1);
    expect(createAppointmentAction.mock.calls[0]![0]).not.toHaveProperty("customTime");
    fireEvent.click(within(li).getByRole("button", { name: "Book anyway" }));
    await waitFor(() => expect(createAppointmentAction).toHaveBeenCalledTimes(2));
    expect(createAppointmentAction.mock.calls[1]![0]).toMatchObject({ customTime: true, clientId: "c1" });
    await waitFor(() => expect(li).toHaveTextContent("Booked for Fri, Oct 9, 4:30 PM."));
  });

  it("🔴 a time taken in the meantime is never booked over", async () => {
    createAppointmentAction.mockResolvedValueOnce({
      ok: false,
      error: "slot_taken",
      code: "OVERLAP",
      confirmation: "digest",
      message: "This overlaps someone. Book it anyway?",
    });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await within(li).findByText("That time was just taken. Text them to pick another.");
    expect(within(li).getByText("Time taken")).toBeInTheDocument();
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
    expect(within(li).queryByRole("button", { name: /anyway/i })).toBeNull();
    expect(createAppointmentAction).toHaveBeenCalledTimes(1);
  });

  it("an email the dashboard's check refuses: books once more without it, never twice", async () => {
    createAppointmentAction.mockResolvedValueOnce({ ok: false, error: "invalid_input" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(createAppointmentAction).toHaveBeenCalledTimes(2));
    expect(createAppointmentAction.mock.calls[0]![0]).toHaveProperty("email", "lena@example.com");
    expect(createAppointmentAction.mock.calls[1]![0]).not.toHaveProperty("email");
    await waitFor(() => expect(li).toHaveTextContent("Booked for Fri, Oct 9, 4:30 PM."));
  });

  it("🔴 a refusal lasts only until fresh data: a time that frees up can be booked again", async () => {
    createAppointmentAction.mockResolvedValueOnce({ ok: false, error: "slot_taken", code: "HELD" });
    listUnfinishedAction.mockResolvedValue(
      listed([row(), row({ id: "a2", firstName: "Omar", lastName: "Said", clientId: "c2" })]),
    );
    await shown();
    const lena = card(/Lena Ortiz/);
    fireEvent.click(within(lena).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(lena).getByRole("button", { name: "Book" }));
    await within(lena).findByText(
      "Someone is on the card step for that time right now. It may be them. Check again in a few minutes.",
    );
    expect(within(lena).getByText("Time taken")).toBeInTheDocument();
    // Booking someone else re-reads the list; the server now says Lena's time is free.
    const omar = card(/Omar Said/);
    fireEvent.click(within(omar).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(omar).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(listUnfinishedAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(lena).getByText("Time open")).toBeInTheDocument());
    expect(within(lena).queryByText(/on the card step for that time/)).toBeNull();
    expect(within(lena).getByRole("button", { name: "Book them" })).toBeInTheDocument();
  });

  it("🔴 a refusal the list can't see (buffer, a special) stays after a fresh read - no Book them loop", async () => {
    createAppointmentAction.mockResolvedValueOnce({ ok: false, error: "slot_taken", code: "OVERLAP", confirmation: "d" });
    listUnfinishedAction.mockResolvedValue(
      listed([row(), row({ id: "a2", firstName: "Omar", lastName: "Said", clientId: "c2" })]),
    );
    await shown();
    const lena = card(/Lena Ortiz/);
    fireEvent.click(within(lena).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(lena).getByRole("button", { name: "Book" }));
    await within(lena).findByText("That time was just taken. Text them to pick another.");
    // A fresh read still says "open" (the read can't see what refused it).
    const omar = card(/Omar Said/);
    fireEvent.click(within(omar).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(omar).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(listUnfinishedAction).toHaveBeenCalledTimes(2));
    expect(within(lena).getByText("Time taken")).toBeInTheDocument();
    expect(within(lena).getByText("That time was just taken. Text them to pick another.")).toBeInTheDocument();
    expect(within(lena).queryByRole("button", { name: "Book them" })).toBeNull();
  });

  it("time blocked on the other calendar says so - never 'just taken'", async () => {
    createAppointmentAction.mockResolvedValueOnce({ ok: false, error: "external_block", confirmation: "d" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await within(li).findByText("That time is blocked on your other calendar.");
    expect(within(li).getByText("Blocked")).toBeInTheDocument();
    expect(within(li).queryByText(/just taken/)).toBeNull();
    expect(within(li).queryByRole("button", { name: "Book them" })).toBeNull();
  });

  it("refused even as a custom time: says the service or provider isn't available", async () => {
    createAppointmentAction
      .mockResolvedValueOnce({ ok: false, error: "invalid_slot" })
      .mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    fireEvent.click(await within(li).findByRole("button", { name: "Book anyway" }));
    await within(li).findByText("That service or provider isn't available at that time anymore.");
  });

  it("someone on the card step for that time right now - which may be them", async () => {
    createAppointmentAction.mockResolvedValueOnce({ ok: false, error: "slot_taken", code: "HELD" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await within(li).findByText(
      "Someone is on the card step for that time right now. It may be them. Check again in a few minutes.",
    );
    expect(within(li).queryByText(/pick another/)).toBeNull();
  });

  it("the add-ons they picked come with the time", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ addOns: [{ id: "ad1", name: "Beard" }] })]));
    await shown();
    const li = card(/Lena Ortiz/);
    expect(li).toHaveTextContent("Haircut + Beard");
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(createAppointmentAction).toHaveBeenCalledTimes(1));
    expect(createAppointmentAction.mock.calls[0]![0]).toMatchObject({ addOnIds: ["ad1"] });
  });

  it("a special they tried for is booked as that special, never as the plain service", async () => {
    listUnfinishedAction.mockResolvedValue(
      listed([row({ targetedSlotId: "ts1", addOns: [{ id: "ad1", name: "Beard" }] })]),
    );
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(createAppointmentAction).toHaveBeenCalledTimes(1));
    const sent = createAppointmentAction.mock.calls[0]![0];
    expect(sent).toMatchObject({ targetedSlotId: "ts1" });
    expect(sent).not.toHaveProperty("addOnIds");
  });

  it("an add-on that's gone says so, and books nothing", async () => {
    createAppointmentAction.mockResolvedValueOnce({ ok: false, error: "invalid_add_on" });
    listUnfinishedAction.mockResolvedValue(listed([row({ addOns: [{ id: "ad1", name: "Beard" }] })]));
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await within(li).findByText(/add-on they picked isn't offered anymore/);
    expect(createAppointmentAction).toHaveBeenCalledTimes(1);
  });
});

describe("Dismiss", () => {
  it("takes them off the list", async () => {
    await shown();
    fireEvent.click(within(card(/Lena Ortiz/)).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Lena Ortiz")).toBeNull());
    expect(dismissUnfinishedAction).toHaveBeenCalledWith("a1");
    expect(toast).toHaveBeenCalledWith("Taken off the list", "success");
  });

  it("puts them back if it didn't work", async () => {
    dismissUnfinishedAction.mockResolvedValueOnce({ ok: false, error: "failed" });
    listUnfinishedAction.mockResolvedValue(listed([row(), row({ id: "a2", firstName: "Omar", lastName: "Said" })]));
    await shown();
    fireEvent.click(within(card(/Lena Ortiz/)).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't take them off the list", "error"));
    expect(screen.getByText("Lena Ortiz")).toBeInTheDocument();
  });
});

/**
 * TELLING THEM. The barber can't text everyone; these clients may think
 * they're booked. Booking one emails them the confirmation and the row says
 * whether it really went; a time someone else took offers one email to pick
 * another time.
 */
describe("telling the client", () => {
  it("🔴 no email could go out: it says so, and the Text button is the way", async () => {
    createAppointmentAction.mockResolvedValue({ ok: true, clientConfirmation: "none" });
    await shown();
    listUnfinishedAction.mockResolvedValue(listed([]));
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await waitFor(() =>
      expect(li).toHaveTextContent(
        "Booked for Fri, Oct 9, 4:30 PM. ChairBack couldn't email Lena a confirmation, so text them it's set.",
      ),
    );
    expect(within(li).getByRole("link", { name: "Text" })).toBeInTheDocument();
  });

  it("an API that predates the confirmation still books them - the old way, keeping the email they typed", async () => {
    createAppointmentAction
      .mockResolvedValueOnce({ ok: false, error: "invalid_input" })
      .mockResolvedValueOnce({ ok: false, error: "invalid_input" })
      .mockResolvedValueOnce({ ok: true });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(createAppointmentAction).toHaveBeenCalledTimes(3));
    expect(createAppointmentAction.mock.calls[2]![0]).not.toHaveProperty("confirmClient");
    expect(createAppointmentAction.mock.calls[2]![0]).toMatchObject({ email: "lena@example.com" });
    await waitFor(() =>
      expect(li).toHaveTextContent("Booked for Fri, Oct 9, 4:30 PM. ChairBack doesn't send a confirmation"),
    );
  });

  it("🔴 the confirmation outcome survives the card leaving the collapsed list and coming back", async () => {
    createAppointmentAction.mockResolvedValue({ ok: true, clientConfirmation: "email" });
    const rows = ["a", "b", "c"].map((k, i) =>
      row({ id: `r${k}`, firstName: `P${k}`, lastName: "Row", startsAt: `2026-10-0${7 + i}T23:30:00.000Z` }),
    );
    // The read after booking brings a newer try that sorts ahead, pushing the
    // booked card out of the first three.
    listUnfinishedAction
      .mockResolvedValueOnce(listed(rows))
      .mockResolvedValue(
        listed([row({ id: "r0", firstName: "Early", lastName: "Bird", startsAt: "2026-10-06T23:30:00.000Z" }), ...rows]),
      );
    await shown();
    const li = card(/Pc Row/);
    fireEvent.click(within(li).getByRole("button", { name: "Book them" }));
    fireEvent.click(within(li).getByRole("button", { name: "Book" }));
    await waitFor(() => expect(screen.getByText("Early Bird")).toBeInTheDocument());
    expect(screen.queryByText("Pc Row")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(card(/Pc Row/)).toHaveTextContent("ChairBack emailed Pc a confirmation.");
  });

  it("🔴 a time someone else booked: 'Email them to pick a new time', once, and the row says when", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ timeTaken: true, canInvite: true })]));
    inviteUnfinishedAction.mockResolvedValue({ ok: true, invitedAt: "2026-10-05T18:00:00.000Z" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Email them to pick a new time" }));
    await waitFor(() => expect(inviteUnfinishedAction).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect(li).toHaveTextContent("Emailed Lena to pick a new time (Oct 5, 11:00 AM)."));
    expect(within(li).queryByRole("button", { name: "Email them to pick a new time" })).toBeNull();
  });

  it("🔴 never offered unless the server says so: a time only held, someone who can't be emailed, someone invited", async () => {
    listUnfinishedAction.mockResolvedValue(
      listed([
        row(),
        // Taken - but only by a card step in progress: the server says no.
        row({ id: "a2", firstName: "Mia", lastName: "Park", timeTaken: true, canInvite: false }),
        row({
          id: "a3",
          firstName: "Noa",
          lastName: "Reed",
          timeTaken: true,
          canInvite: true,
          invitedAt: "2026-10-05T18:00:00.000Z",
        }),
      ]),
    );
    await shown();
    for (const name of [/Lena Ortiz/, /Mia Park/, /Noa Reed/]) {
      expect(within(card(name)).queryByRole("button", { name: "Email them to pick a new time" })).toBeNull();
    }
    expect(card(/Noa Reed/)).toHaveTextContent("Emailed Noa to pick a new time (Oct 5, 11:00 AM).");
  });

  it("an invite that can't go out says why", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ timeTaken: true, canInvite: true })]));
    inviteUnfinishedAction.mockResolvedValue({ ok: false, error: "unsubscribed" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Email them to pick a new time" }));
    await waitFor(() =>
      expect(li).toHaveTextContent("Lena unsubscribed from your emails. Text or call them instead."),
    );
  });

  it("already sent from another phone: says so, never invents a time", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ timeTaken: true, canInvite: true })]));
    inviteUnfinishedAction.mockResolvedValue({ ok: false, error: "already_invited" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Email them to pick a new time" }));
    await waitFor(() => expect(li).toHaveTextContent("Emailed Lena to pick a new time."));
    expect(li).not.toHaveTextContent(/pick a new time \(/);
    expect(within(li).queryByRole("button", { name: "Email them to pick a new time" })).toBeNull();
  });

  it("🔴 an answer that never came: may have gone out - not offered again, and never 'nothing was sent'", async () => {
    listUnfinishedAction.mockResolvedValue(listed([row({ timeTaken: true, canInvite: true })]));
    inviteUnfinishedAction.mockResolvedValue({ ok: false, error: "unknown" });
    await shown();
    const li = card(/Lena Ortiz/);
    fireEvent.click(within(li).getByRole("button", { name: "Email them to pick a new time" }));
    await waitFor(() => expect(li).toHaveTextContent(/It may have gone out/));
    expect(li).not.toHaveTextContent(/Nothing was sent/);
    expect(within(li).queryByRole("button", { name: "Email them to pick a new time" })).toBeNull();
  });
});
