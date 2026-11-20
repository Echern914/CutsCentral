import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";

/**
 * Booking a client from a team member's own calendar.
 *
 * Pinned: the form never sends WHOSE calendar (the server decides that from
 * the login); a tap that got no answer is retried as the SAME submission, so
 * it cannot book twice; and the outcome is read in the dialog's footer.
 */

const calendar = vi.hoisted(() => ({
  bookOwnAction: vi.fn(),
  getOwnServicesAction: vi.fn(),
  getOwnSlotsAction: vi.fn(),
}));
const clients = vi.hoisted(() => ({ getBarberClientsAction: vi.fn() }));
vi.mock("./barberCalendarActions", () => calendar);
vi.mock("./barberClientActions", () => clients);
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { BarberBookSheet } = await import("./BarberBookSheet");

const DAY = "2026-11-24";
const TEN = `${DAY}T10:00:00.000Z`;

const person = (id: string, name: string) => ({
  id,
  name,
  maskedPhone: "··· 4567",
  lastSeen: null,
  visits: 2,
  textable: true,
  reason: null,
});

function open(list = [person("c1", "Jordan P")]) {
  clients.getBarberClientsAction.mockResolvedValue({
    ok: true,
    data: { chair: { staffId: "s1" }, clients: list, reason: null },
  });
  const onBooked = vi.fn();
  const onClose = vi.fn();
  render(
    <BarberBookSheet timezone="UTC" startDay={DAY} today="2026-11-20" onClose={onClose} onBooked={onBooked} />,
  );
  return { onBooked, onClose };
}

beforeEach(() => {
  for (const fn of [...Object.values(calendar), ...Object.values(clients)]) fn.mockReset();
  calendar.getOwnServicesAction.mockResolvedValue({
    ok: true,
    data: { services: [{ id: "svc1", name: "Trim", durationMin: 30, price: 40 }] },
  });
  calendar.getOwnSlotsAction.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      slots: [
        { startsAt: TEN, endsAt: `${DAY}T10:30:00.000Z` },
        { startsAt: `${DAY}T11:00:00.000Z`, endsAt: `${DAY}T11:30:00.000Z` },
      ],
    },
  });
  calendar.bookOwnAction.mockResolvedValue({ ok: true });
});

describe("Book a client", () => {
  it("cannot be sent until there is a person, a service and a time", async () => {
    open();
    await screen.findByRole("button", { name: "10:00 AM" });
    const book = screen.getByRole("button", { name: "Book" });
    expect((book as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(await screen.findByRole("button", { name: /Jordan P/ }));
    expect((screen.getByRole("button", { name: "Book" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    expect((screen.getByRole("button", { name: "Book 10:00 AM" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("books one of their own clients, and says so in the dialog", async () => {
    const { onBooked } = open();
    fireEvent.click(await screen.findByRole("button", { name: /Jordan P/ }));
    fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Jordan P is booked for Tue, Nov 24 at 10:00 AM.");
    expect(onBooked).toHaveBeenCalledWith(DAY);

    const sent = calendar.bookOwnAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ serviceId: "svc1", startsAt: TEN, clientId: "c1" });
    // 🔴 Whose calendar is the server's to decide. Nothing here names a person
    // to book with, and nothing sets a price or forces a time.
    expect(Object.keys(sent).sort()).toEqual(["clientId", "operationId", "serviceId", "startsAt"]);
    expect(String(sent.operationId)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("opens on a new person when their list is empty, and books by name", async () => {
    open([]);
    const first = await screen.findByLabelText("First name");
    fireEvent.change(first, { target: { value: "  Sam " } });
    fireEvent.change(screen.getByLabelText("Mobile (optional)"), { target: { value: "5551234567" } });
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 11:00 AM" }));

    await screen.findByRole("status");
    const sent = calendar.bookOwnAction.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ firstName: "Sam", phone: "5551234567" });
    expect(sent).not.toHaveProperty("clientId");
    expect(sent).not.toHaveProperty("lastName");
  });

  it("asks for open times for the picked service and day", async () => {
    open();
    await screen.findByRole("button", { name: "10:00 AM" });
    expect(calendar.getOwnSlotsAction).toHaveBeenCalledWith({ date: DAY, serviceId: "svc1" });

    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2026-11-25" } });
    await waitFor(() =>
      expect(calendar.getOwnSlotsAction).toHaveBeenLastCalledWith({ date: "2026-11-25", serviceId: "svc1" }),
    );
  });

  it("🔴 a time that was just taken is said in the dialog, and the list is read again", async () => {
    calendar.bookOwnAction.mockResolvedValueOnce({ ok: false, error: "slot_taken" });
    const { onBooked } = open();
    fireEvent.click(await screen.findByRole("button", { name: /Jordan P/ }));
    fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That time was just taken. Pick another one.");
    expect(screen.queryByRole("status")).toBeNull();
    expect(onBooked).not.toHaveBeenCalled();
    await waitFor(() => expect(calendar.getOwnSlotsAction).toHaveBeenCalledTimes(2));
  });

  it("🔴 a tap that got no answer is retried as the same submission; a refusal starts a new one", async () => {
    calendar.bookOwnAction
      .mockResolvedValueOnce({ ok: false, error: "network_error" })
      .mockResolvedValueOnce({ ok: false, error: "client_not_found" })
      .mockResolvedValueOnce({ ok: true });
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Jordan P/ }));
    fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));

    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    expect((await screen.findByRole("alert")).textContent).toContain("it will not book twice");
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    await waitFor(() => expect(calendar.bookOwnAction).toHaveBeenCalledTimes(2));
    await screen.findByText(/Couldn't find that person/);
    fireEvent.click(screen.getByRole("button", { name: "Book 10:00 AM" }));
    await screen.findByRole("status");

    const ids = calendar.bookOwnAction.mock.calls.map((c) => (c[0] as { operationId: string }).operationId);
    expect(ids[1]).toBe(ids[0]); // no answer: the same submission again
    expect(ids[2]).not.toBe(ids[1]); // answered with a refusal: a new one
  });

  it("says so when nothing is set up for them to offer", async () => {
    calendar.getOwnServicesAction.mockResolvedValue({ ok: true, data: { services: [] } });
    open();
    expect(await screen.findByText(/Ask the shop owner to add you to the menu/)).toBeTruthy();
    expect(calendar.getOwnSlotsAction).not.toHaveBeenCalled();
  });
});
