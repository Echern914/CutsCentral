import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ServiceRow, StaffRow } from "./page";
import type { DashSlot } from "./actions";

/**
 * AN OFFER CODE IN THE SHOP'S BOOKING FORM.
 *
 *  - only on a shop with Offers & codes on;
 *  - checked by the API against THIS visit, for the client being booked
 *    (that is what makes a personal offer theirs);
 *  - changing the time (or anything about the visit) clears it, so no price
 *    is shown that was worked out for another visit;
 *  - Schedule sends the code it checked; a refusal at booking is said where
 *    Schedule is, and the code is cleared.
 */
const getSlots = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const searchClients = vi.hoisted(() => vi.fn());
const quote = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getDashSlotsAction: getSlots,
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  createAppointmentAction: create,
  searchClientsAction: searchClients,
}));
vi.mock("../offers/actions", () => ({ quoteOfferAction: quote }));

const { AppointmentForm } = await import("./AppointmentForm");

const TZ = "America/New_York";
const AT_11: DashSlot = { startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" };
const AT_12: DashSlot = { startsAt: "2026-10-02T16:00:00.000Z", endsAt: "2026-10-02T16:30:00.000Z" };
const MIKEY: StaffRow = { id: "mikey", name: "Mikey", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "cut", name: "Haircut", durationMin: 30, price: 40, active: true }] as unknown as ServiceRow[];

function open(offersEnabled = true) {
  render(
    <AppointmentForm
      staff={[MIKEY]}
      services={services}
      timezone={TZ}
      prefillISO="2026-10-02T14:00:00.000Z"
      onClose={vi.fn()}
      onCreated={vi.fn()}
      toast={vi.fn()}
      offersEnabled={offersEnabled}
    />,
  );
}
async function bookJordanAt11() {
  fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
  fireEvent.change(screen.getByPlaceholderText("Search name or number…"), { target: { value: "Jordan" } });
  fireEvent.click(await screen.findByRole("button", { name: /Jordan Q/ }, { timeout: 2000 }));
}
const codeBox = () => screen.getByLabelText("Offer code");
const apply = () => fireEvent.click(screen.getByRole("button", { name: "Apply" }));

beforeEach(() => {
  getSlots.mockReset().mockResolvedValue({ ok: true, slots: [AT_11, AT_12] });
  create.mockReset().mockResolvedValue({ ok: true });
  searchClients.mockReset().mockResolvedValue({ ok: true, clients: [{ id: "jordan", name: "Jordan Q", phone: null }] });
  quote.mockReset().mockResolvedValue({
    ok: true,
    code: "MIKEYG30",
    words: "A free Haircut",
    listPriceCents: 4000,
    discountCents: 4000,
    totalCents: 0,
  });
});

describe("an offer code in the booking form", () => {
  it("isn't offered when the shop doesn't have offers", async () => {
    open(false);
    await screen.findByRole("button", { name: "11:00 AM" });
    expect(screen.queryByLabelText("Offer code")).toBeNull();
  });

  it("🔴 is checked for this visit and this client, and Schedule sends it", async () => {
    open();
    await bookJordanAt11();
    fireEvent.change(codeBox(), { target: { value: "mikeyg30" } });
    apply();
    expect(await screen.findByTestId("offer-applied")).toHaveTextContent("MIKEYG30 · A free Haircut · pays $0 (was $40)");
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({ code: "mikeyg30", clientId: "jordan", serviceId: "cut", staffId: "mikey", startsAt: AT_11.startsAt }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ offerCode: "MIKEYG30", clientId: "jordan" });
  });

  it("🔴 a different time clears it - nothing is booked at a price worked out for another visit", async () => {
    open();
    await bookJordanAt11();
    fireEvent.change(codeBox(), { target: { value: "MIKEYG30" } });
    apply();
    await screen.findByTestId("offer-applied");
    fireEvent.click(screen.getByRole("button", { name: "12:00 PM" }));
    await waitFor(() => expect(screen.queryByTestId("offer-applied")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).not.toHaveProperty("offerCode");
  });

  it("a code the API refuses is said, and not applied", async () => {
    quote.mockResolvedValue({ ok: false, message: "That offer is for a different client." });
    open();
    await bookJordanAt11();
    fireEvent.change(codeBox(), { target: { value: "MIKEYG30" } });
    apply();
    expect(await screen.findByRole("alert")).toHaveTextContent("That offer is for a different client.");
    expect(screen.queryByTestId("offer-applied")).toBeNull();
  });

  it("refused at booking (its last use just went): said where Schedule is, code cleared", async () => {
    create.mockResolvedValue({ ok: false, error: "offer_refused", message: "That offer has already been used." });
    open();
    await bookJordanAt11();
    fireEvent.change(codeBox(), { target: { value: "MIKEYG30" } });
    apply();
    await screen.findByTestId("offer-applied");
    fireEvent.click(screen.getByRole("button", { name: "Schedule appointment" }));
    expect(await screen.findByText("That offer has already been used.")).toBeInTheDocument();
    expect(screen.queryByTestId("offer-applied")).toBeNull();
  });
});
