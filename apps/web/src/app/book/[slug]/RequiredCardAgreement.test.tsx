import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BookShopData } from "./page";

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
}));

const { BookingClient } = await import("./BookingClient");
const { readPaymentTerms } = await import("./depositTerms");
const {
  SERVICE_CHARGE_REQUIRED_HINT,
  SERVICE_CHARGE_REQUIRED_MESSAGE,
  serviceChargeBlocksConfirm,
  serviceChargeRequiredNote,
  serviceChargeTickRequired,
} = await import("./serviceChargeRule");
const { POLICY_HINT } = await import("./BookingPolicy");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * A SHOP THAT WILL NOT BOOK ONLINE WITHOUT THE CLIENT'S OK TO CHARGE THEIR
 * SAVED CARD FOR THE SERVICE.
 *
 * The API refuses a booking without the tick; this pins the half only the page
 * can get wrong: the box is never ticked for them, it says the shop requires
 * it, Confirm waits and says why, a shop that does not require it is exactly
 * as before, and a shop that switched the rule on while the page was open gets
 * the box turned required - still unticked - with nothing booked.
 */

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;

type Payment = NonNullable<BookShopData["shop"]["payment"]>;

const cardTerms = (over: Partial<Payment> = {}): Payment => ({
  collects: "card",
  mode: "card_on_file",
  depositAmountCents: null,
  sentence: "no charge at booking; a card is kept on file",
  cardOptional: false,
  cardFee: null,
  serviceChargeConsentRequired: true,
  ...over,
});

function shopData(payment: Payment, checklist: string[] = []): BookShopData {
  return {
    shop: {
      name: "Sample Studio",
      slug: "sample-studio",
      timezone: "UTC",
      logoUrl: null,
      accentColor: null,
      instagramHandle: null,
      bookingLeadHours: 1,
      bookingMaxDays: 60,
      payDirect: null,
      payment,
      bookingPolicy: checklist.length ? { text: null, checklist, version: "v1v1v1v1v1v1v1v1" } : null,
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
        price: 40,
        priceOverrides: {},
        priceRange: { min: 40, max: 40 },
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
          price: 40,
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

async function reachLastStep(data: BookShopData) {
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), {
    target: { value: "Casey" },
  });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
  await screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
}

const confirmButton = () => screen.getByRole("button", { name: "Confirm booking" }) as HTMLButtonElement;
const consentBox = () => document.querySelector('[data-qa="service-charge-consent"]') as HTMLInputElement;
const requiredNote = () => document.querySelector('[data-qa="service-charge-required"]');

describe("a shop that requires the card agreement to book", () => {
  it("🔴 the box starts UNTICKED, says the shop requires it, and Confirm waits, saying why", async () => {
    await reachLastStep(shopData(cardTerms()));
    expect(consentBox().checked).toBe(false);
    expect(consentBox().getAttribute("aria-required")).toBe("true");
    expect(requiredNote()!.textContent).toBe(serviceChargeRequiredNote("Sample Studio"));
    expect(requiredNote()!.textContent).toMatch(/You can still pay another way in person/);
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText(SERVICE_CHARGE_REQUIRED_HINT)).toBeTruthy();
    expect(confirmButton().getAttribute("aria-describedby")).toBe("service-charge-hint");

    fireEvent.click(consentBox());
    expect(confirmButton().disabled).toBe(false);
    expect(screen.queryByText(SERVICE_CHARGE_REQUIRED_HINT)).toBeNull();
    // Taking the tick back takes Confirm back.
    fireEvent.click(consentBox());
    expect(confirmButton().disabled).toBe(true);
  });

  it("🔴 sends the client's own tick with the booking", async () => {
    bookAction.mockResolvedValue({ ok: false, code: "RATE_LIMITED" } as never);
    await reachLastStep(shopData(cardTerms()));
    fireEvent.click(consentBox());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(bookAction).toHaveBeenCalledTimes(1));
    expect(bookAction.mock.calls[0]![1].serviceChargeConsent).toBe(true);
  });

  it("the shop's own checklist is asked for first, then the card agreement", async () => {
    await reachLastStep(shopData(cardTerms(), ["I'll arrive 5 minutes early"]));
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText(POLICY_HINT)).toBeTruthy();
    expect(screen.queryByText(SERVICE_CHARGE_REQUIRED_HINT)).toBeNull();
    fireEvent.click(screen.getByText("I'll arrive 5 minutes early"));
    // One reason at a time: the checklist is done, the card agreement is not.
    expect(confirmButton().disabled).toBe(true);
    expect(screen.queryByText(POLICY_HINT)).toBeNull();
    expect(screen.getByText(SERVICE_CHARGE_REQUIRED_HINT)).toBeTruthy();
    fireEvent.click(consentBox());
    expect(confirmButton().disabled).toBe(false);
  });
});

describe("a card shop that does not require it", () => {
  it("🔴 is exactly as before: the box is theirs to leave, and Confirm does not wait for it", async () => {
    bookAction.mockResolvedValue({ ok: false, code: "RATE_LIMITED" } as never);
    await reachLastStep(shopData(cardTerms({ serviceChargeConsentRequired: false })));
    expect(consentBox().checked).toBe(false);
    expect(consentBox().getAttribute("aria-required")).toBeNull();
    expect(requiredNote()).toBeNull();
    expect(confirmButton().disabled).toBe(false);
    expect(screen.queryByText(SERVICE_CHARGE_REQUIRED_HINT)).toBeNull();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(bookAction).toHaveBeenCalledTimes(1));
    // Unticked means not sent: never `true`, never invented.
    expect(bookAction.mock.calls[0]![1].serviceChargeConsent).toBeUndefined();
  });

  it("an older API that says nothing about it never requires it", async () => {
    const { serviceChargeConsentRequired: _dropped, ...older } = cardTerms();
    await reachLastStep(shopData(older as Payment));
    expect(requiredNote()).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });
});

describe("the shop switches the rule on while the page is open", () => {
  it("🔴 the refusal turns the box required, still UNTICKED, and nothing is booked", async () => {
    bookAction.mockResolvedValue({
      ok: false,
      code: "SERVICE_CHARGE_CONSENT_REQUIRED",
      payment: cardTerms(),
    } as never);
    await reachLastStep(shopData(cardTerms({ serviceChargeConsentRequired: false })));
    expect(requiredNote()).toBeNull();
    fireEvent.click(confirmButton());

    expect((await screen.findByRole("alert")).textContent).toBe(SERVICE_CHARGE_REQUIRED_MESSAGE);
    expect(requiredNote()).not.toBeNull();
    // Never ticked on their behalf.
    expect(consentBox().checked).toBe(false);
    expect(confirmButton().disabled).toBe(true);
    // Still on the booking form: no confirmation, no card step.
    expect(screen.queryByText(/You.re booked/i)).toBeNull();
    expect(bookAction).toHaveBeenCalledTimes(1);
  });

  it("a refusal with an unreadable body still turns the box required", async () => {
    bookAction.mockResolvedValue({ ok: false, code: "SERVICE_CHARGE_CONSENT_REQUIRED", payment: "nonsense" } as never);
    await reachLastStep(shopData(cardTerms({ serviceChargeConsentRequired: false })));
    fireEvent.click(confirmButton());
    await screen.findByRole("alert");
    expect(requiredNote()).not.toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });
});

describe("the rule and the terms it reads", () => {
  it("is required only for a shop that saves a card AND says so", () => {
    expect(serviceChargeTickRequired(cardTerms())).toBe(true);
    expect(serviceChargeTickRequired(cardTerms({ serviceChargeConsentRequired: false }))).toBe(false);
    expect(serviceChargeTickRequired({ collects: "payment", serviceChargeConsentRequired: true })).toBe(false);
    expect(serviceChargeTickRequired({ collects: null, serviceChargeConsentRequired: true })).toBe(false);
    expect(serviceChargeTickRequired({ collects: "card" })).toBe(false);
    expect(serviceChargeTickRequired(null)).toBe(false);
    expect(serviceChargeBlocksConfirm(cardTerms(), false)).toBe(true);
    expect(serviceChargeBlocksConfirm(cardTerms(), true)).toBe(false);
    expect(serviceChargeBlocksConfirm(cardTerms({ serviceChargeConsentRequired: false }), false)).toBe(false);
  });

  it("reads the card half of the terms out of a refusal, and only a literal true as required", () => {
    const read = readPaymentTerms({
      collects: "card",
      mode: "card_on_file",
      sentence: "no charge at booking",
      cardOptional: false,
      cardFee: "$25",
      serviceChargeConsentRequired: true,
    });
    expect(read).toMatchObject({ cardOptional: false, cardFee: "$25", serviceChargeConsentRequired: true });
    expect(
      readPaymentTerms({ collects: "card", mode: "card_on_file", sentence: "x", serviceChargeConsentRequired: "yes" })!
        .serviceChargeConsentRequired,
    ).toBe(false);
    expect(readPaymentTerms("nonsense")).toBeNull();
  });
});
