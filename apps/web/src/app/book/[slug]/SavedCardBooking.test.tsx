import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BookShopData } from "./page";
import { SAVED_CARD_KEY } from "./savedCardDevice";

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

// Stripe's card form stands in as a button that "saves the card".
vi.mock("./PaymentStep", () => ({
  PaymentStep: (p: { onPaid: () => void }) => (
    <button type="button" onClick={p.onPaid}>
      stub card form
    </button>
  ),
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const cardSaved = vi.mocked(actions.cardSavedAction);
const bookingStatus = vi.mocked(actions.bookingStatusAction);
const requestCode = vi.mocked(actions.requestSavedCardCodeAction);
const verifyCode = vi.mocked(actions.verifySavedCardCodeAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * THE CLIENT'S SAVED CARD on the booking page. A barber: "save a universal
 * card so appointments go straight through after they select time... they can
 * choose from saved cards." Pinned: keeping a card is only ever the client's
 * own tick; a device holding the key pays with it by default and books with no
 * card step; "Use a different card" is one tap away; a key the shop refuses is
 * forgotten; a new phone unlocks the card with a texted code.
 */

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;
const DEVICE_KEY = { token: "k".repeat(43), brand: "visa", last4: "4242" };

function shopData(slug = "sample-studio"): BookShopData {
  return {
    shop: {
      name: "Sample Studio",
      slug,
      timezone: "UTC",
      logoUrl: null,
      accentColor: null,
      instagramHandle: null,
      bookingLeadHours: 1,
      bookingMaxDays: 60,
      payDirect: null,
      payment: {
        collects: "card",
        mode: "card_on_file",
        depositAmountCents: null,
        sentence: "A card is kept on file - no charge at booking.",
      },
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
  cardSaved.mockReset();
  bookingStatus.mockReset();
  requestCode.mockReset();
  verifyCode.mockReset();
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

async function reachLastStep(data: BookShopData = shopData()) {
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), { target: { value: "Casey" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "3025550142" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
  return screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
}

const saveBox = () => screen.queryByRole("checkbox", { name: /Save this card for my future appointments/ });

describe("keeping a card for next time", () => {
  it("🔴 the box starts EMPTY, and unticked nothing asks to keep the card", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    const confirm = await reachLastStep();
    expect((saveBox() as HTMLInputElement).checked).toBe(false);
    await act(async () => fireEvent.click(confirm));
    await waitFor(() => expect(bookAction).toHaveBeenCalled());
    expect(bookAction.mock.calls[0]![1].saveCard).toBeUndefined();
    expect(bookAction.mock.calls[0]![1].savedCardToken).toBeUndefined();
  });

  it("ticked, it asks to keep it - and once saved, this browser holds the key for next time", async () => {
    bookAction.mockResolvedValue({
      ok: true,
      manageToken: "tok",
      paymentClientSecret: "seti_secret",
      paymentKind: "setup",
      paymentAmountCents: 0,
      paymentIsDeposit: false,
      paymentBalanceDueCents: 4000,
      paymentHoldMinutes: 10,
      paymentExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      pending: false,
    });
    cardSaved.mockResolvedValue({ ok: true, status: "BOOKED", savedCard: DEVICE_KEY });
    bookingStatus.mockResolvedValue({ ok: true, status: "BOOKED" });
    const confirm = await reachLastStep();
    fireEvent.click(saveBox()!);
    await act(async () => fireEvent.click(confirm));
    expect(bookAction.mock.calls[0]![1].saveCard).toBe(true);
    await act(async () => fireEvent.click(await screen.findByText("stub card form")));
    await waitFor(() => expect(localStorage.getItem(SAVED_CARD_KEY)).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(SAVED_CARD_KEY)!)["sample-studio"]).toEqual(DEVICE_KEY);
  });
});

describe("paying with the saved card", () => {
  beforeEach(() => {
    localStorage.setItem(SAVED_CARD_KEY, JSON.stringify({ "sample-studio": DEVICE_KEY }));
  });

  it("🔴 is chosen for them and books straight through - no card step", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok", savedCard: { brand: "visa", last4: "4242" } });
    const confirm = await reachLastStep();
    expect((screen.getByRole("radio", { name: /Pay with Visa •••• 4242/ }) as HTMLInputElement).checked).toBe(true);
    // Keeping a card they already keep is not asked.
    expect(saveBox()).toBeNull();
    await act(async () => fireEvent.click(confirm));
    expect(bookAction.mock.calls[0]![1].savedCardToken).toBe(DEVICE_KEY.token);
    expect(await screen.findByText("You're booked!")).toBeTruthy();
    expect(screen.queryByText("stub card form")).toBeNull();
  });

  it("'Use a different card' is one tap away - no key sent, and the save box returns", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    const confirm = await reachLastStep();
    fireEvent.click(screen.getByRole("radio", { name: "Use a different card" }));
    expect(saveBox()).not.toBeNull();
    await act(async () => fireEvent.click(confirm));
    expect(bookAction.mock.calls[0]![1].savedCardToken).toBeUndefined();
  });

  it("🔴 a key the shop refuses is forgotten here, and the card step follows", async () => {
    bookAction.mockResolvedValue({
      ok: true,
      manageToken: "tok",
      savedCardRefused: true,
      paymentClientSecret: "seti_secret",
      paymentKind: "setup",
      paymentAmountCents: 0,
      paymentIsDeposit: false,
      paymentBalanceDueCents: 4000,
      paymentHoldMinutes: 10,
      paymentExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      pending: false,
    });
    const confirm = await reachLastStep();
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText("stub card form")).toBeTruthy();
    expect(localStorage.getItem(SAVED_CARD_KEY)).toBeNull();
  });

  it("the public demo shop never offers a saved card", async () => {
    await reachLastStep(shopData("demo"));
    expect(screen.queryByRole("radio", { name: /Pay with/ })).toBeNull();
  });
});

describe("a new phone", () => {
  it("🔴 a code texted to the number on file unlocks the card on this phone", async () => {
    requestCode.mockResolvedValue({ ok: true });
    verifyCode.mockResolvedValue({ ok: true, savedCard: DEVICE_KEY });
    await reachLastStep();
    fireEvent.click(screen.getByRole("button", { name: "Saved a card here before? Use it" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Text me a code" })));
    expect(requestCode).toHaveBeenCalledWith("sample-studio", "3025550142");
    expect(screen.getByText(/If you have a card saved here, we just texted a code/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Code from the text"), { target: { value: "123456" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use my card" })));
    expect(verifyCode).toHaveBeenCalledWith("sample-studio", "3025550142", "123456");
    expect(screen.getByRole("radio", { name: /Pay with Visa •••• 4242/ })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(SAVED_CARD_KEY)!)["sample-studio"]).toEqual(DEVICE_KEY);
  });

  it("a wrong code unlocks nothing", async () => {
    requestCode.mockResolvedValue({ ok: true });
    verifyCode.mockResolvedValue({ ok: false });
    await reachLastStep();
    fireEvent.click(screen.getByRole("button", { name: "Saved a card here before? Use it" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Text me a code" })));
    fireEvent.change(screen.getByLabelText("Code from the text"), { target: { value: "000000" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use my card" })));
    expect(screen.getByText(/That code didn't work/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Pay with/ })).toBeNull();
    expect(localStorage.getItem(SAVED_CARD_KEY)).toBeNull();
  });
});
