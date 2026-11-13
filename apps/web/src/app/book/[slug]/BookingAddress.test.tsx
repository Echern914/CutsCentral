import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BookingPageLocation } from "@chairback/config/shopAddress";
import type { BookShopData } from "./page";

/**
 * THE ADDRESS WHILE BOOKING.
 *
 * Clients kept asking their barber where the shop was: the address first
 * appeared in the confirmation email. It now shows under the shop name, as a
 * maps link, and again once they are booked. A shop that keeps its street
 * private shows its town and says the booking brings the rest - which the
 * appointment page keeps, because it reads the stored address.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/book/sample-studio",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./actions", () => ({
  bookAction: vi.fn(),
  bookingStatusAction: vi.fn(),
  cardSavedAction: vi.fn(),
  getDayBundlesAction: vi.fn(),
  getMergedSlotsAction: vi.fn(),
  getOpenDaysAction: vi.fn(),
  getUpgradesAction: vi.fn(),
  joinWaitlistAction: vi.fn(),
  resumeCheckoutAction: vi.fn(),
  requestSavedCardCodeAction: vi.fn(),
  verifySavedCardCodeAction: vi.fn(),
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;
const MAPS = "https://www.google.com/maps/search/?api=1&query=123%20Main%20St";

const PUBLISHED: BookingPageLocation = {
  address: "123 Main St, Brooklyn, NY 11201",
  mapsUrl: MAPS,
  locality: "Brooklyn, NY",
  sentAfterBooking: false,
};
const PRIVATE: BookingPageLocation = { address: null, mapsUrl: null, locality: "Brooklyn, NY", sentAfterBooking: true };
const NONE: BookingPageLocation = { address: null, mapsUrl: null, locality: null, sentAfterBooking: false };

function shopData(location?: BookingPageLocation): BookShopData {
  return {
    shop: {
      name: "Sample Studio",
      slug: "sample-studio",
      timezone: "UTC",
      logoUrl: null,
      accentColor: null,
      instagramHandle: null,
      ...(location ? { location } : {}),
      bookingLeadHours: 1,
      bookingMaxDays: 60,
      payDirect: null,
      payment: { collects: "none", mode: "off", depositAmountCents: null, nonRefundable: false, sentence: "" },
    },
    staff: [{ id: "stf_1", name: "Sam", bio: null, imageUrl: null }],
    services: [
      {
        id: "svc_1",
        name: "Standard visit",
        description: null,
        imageUrl: null,
        color: null,
        durationMin: 30,
        price: 45,
        priceOverrides: {},
        priceRange: { min: 45, max: 45 },
        durationOverrides: {},
        durationRange: { min: 30, max: 30 },
        timeOverrides: [],
        serviceGroupId: null,
        groupSortOrder: 0,
      },
    ],
    groups: [],
    openWeekdays: [0, 1, 2, 3, 4, 5, 6],
    offerings: [{ serviceId: "svc_1", staffId: "stf_1" }],
    targetedSlots: [],
    addOns: [],
    questions: [],
  } as unknown as BookShopData;
}

beforeEach(() => {
  bookAction.mockReset();
  openDays.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      scanDays: 60,
      openDays: [DAY],
      soonest: { date: DAY, startsAt: SLOT, serviceId: "svc_1", staffIds: ["stf_1"] },
    },
  });
  dayBundles.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      date: DAY,
      bundles: [],
      ungrouped: [
        {
          id: "svc_1",
          name: "Standard visit",
          description: null,
          imageUrl: null,
          color: null,
          durationMin: 30,
          price: 45,
          slots: [{ startsAt: SLOT, staffIds: ["stf_1"] }],
        },
      ],
    },
  });
  upgrades.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const header = () => screen.getByRole("heading", { level: 1, name: "Book at Sample Studio" }).closest("header")!;
const addressIn = (el: Element) => el.querySelector('[data-qa="shop-address"]');

async function book(data: BookShopData) {
  bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), { target: { value: "Casey" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "3025550142" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
  const confirm = await screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
  await act(async () => fireEvent.click(confirm));
  await screen.findByText("You're booked!");
}

describe("under the shop name", () => {
  it("a published address is a link to directions", () => {
    render(<BookingClient data={shopData(PUBLISHED)} />);
    const link = addressIn(header()) as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.textContent).toBe("123 Main St, Brooklyn, NY 11201");
    expect(link.getAttribute("href")).toBe(MAPS);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("a private street shows the town, and that the booking brings the rest", () => {
    render(<BookingClient data={shopData(PRIVATE)} />);
    const line = addressIn(header())!;
    expect(line.tagName).not.toBe("A");
    expect(line.textContent).toBe("Brooklyn, NYThe exact address comes with your booking.");
  });

  it("a town with no street on file makes no promise", () => {
    render(<BookingClient data={shopData({ ...PRIVATE, sentAfterBooking: false })} />);
    expect(addressIn(header())!.textContent).toBe("Brooklyn, NY");
  });

  it("no address, or an API older than the field, shows nothing", () => {
    render(<BookingClient data={shopData(NONE)} />);
    expect(addressIn(header())).toBeNull();
    cleanup();
    render(<BookingClient data={shopData()} />);
    expect(addressIn(header())).toBeNull();
  });
});

describe("once booked", () => {
  it("says where, as a link to directions", async () => {
    await book(shopData(PUBLISHED));
    const where = document.querySelector('[data-qa="booked-address"]')!;
    expect(where.textContent).toBe("Where: 123 Main St, Brooklyn, NY 11201");
    expect(where.querySelector("a")!.getAttribute("href")).toBe(MAPS);
  });

  it("a private street points to the appointment page, which has it", async () => {
    await book(shopData(PRIVATE));
    expect(document.querySelector('[data-qa="booked-address"]')!.textContent).toBe(
      "The exact address is on your appointment page.",
    );
    expect(screen.getByRole("link", { name: "View / change my appointment" }).getAttribute("href")).toBe(
      "/book/manage/tok",
    );
  });

  it("no address says nothing", async () => {
    await book(shopData(NONE));
    expect(document.querySelector('[data-qa="booked-address"]')).toBeNull();
  });
});
