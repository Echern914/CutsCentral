import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { BookShopData, BookingPolicyData } from "./page";

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

const {
  BookingPolicyPanel,
  moneyTermsLines,
  readBookingPolicy,
  useBookingPolicy,
  POLICY_HINT,
  POLICY_CHANGED_MESSAGE,
} = await import("./BookingPolicy");
const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * "BEFORE YOU BOOK" on the customer's booking page.
 *
 * The API refuses a booking that skips the checklist; this pins the half only
 * the page can get wrong - the boxes start empty, Confirm waits for every one,
 * the page says why, a shop that wrote nothing sees nothing, and a newer
 * policy from the server replaces the old one and clears the ticks.
 */

const POLICY: BookingPolicyData = {
  text: "Deposits are non-refundable.",
  checklist: ["I'll arrive 5 minutes early", "More than 15 minutes late counts as a no-show"],
  version: "v1v1v1v1v1v1v1v1",
};

// A successful booking now remembers the booker on this "device" - wipe it, or
// one test's customer would be filled into the next test's form.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the panel", () => {
  function Harness({ policy }: { policy: BookingPolicyData }) {
    const p = useBookingPolicy(policy);
    return (
      <>
        {p.policy && (
          <BookingPolicyPanel policy={p.policy} ticked={p.ticked} onToggle={p.toggle} />
        )}
        <button type="button" disabled={!p.complete}>
          Confirm booking
        </button>
      </>
    );
  }

  it("🔴 every box starts UNTICKED", () => {
    render(<Harness policy={POLICY} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b.checked).toBe(false);
    expect(screen.getByText("Before you book")).toBeTruthy();
    expect(screen.getByText(POLICY.text!)).toBeTruthy();
  });

  it("🔴 Confirm stays disabled until EVERY line is ticked", () => {
    render(<Harness policy={POLICY} />);
    const confirm = screen.getByRole("button", { name: "Confirm booking" }) as HTMLButtonElement;
    const [first, second] = screen.getAllByRole("checkbox");
    expect(confirm.disabled).toBe(true);
    fireEvent.click(first!);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(second!);
    expect(confirm.disabled).toBe(false);
    // Unticking one takes it away again.
    fireEvent.click(first!);
    expect(confirm.disabled).toBe(true);
  });

  it("tapping the LINE ticks the box - the row is the tap target", () => {
    render(<Harness policy={POLICY} />);
    fireEvent.click(screen.getByText(POLICY.checklist[0]!));
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });

  it("a long policy starts folded and opens in place", () => {
    const long = { ...POLICY, text: "Please read. ".repeat(60) };
    render(<Harness policy={long} />);
    const toggle = screen.getByRole("button", { name: "Read the full policy" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("a short policy has nothing to fold", () => {
    render(<Harness policy={POLICY} />);
    expect(screen.queryByRole("button", { name: "Read the full policy" })).toBeNull();
  });

  it("🔴 a newer policy replaces the old one and CLEARS every tick", () => {
    const { result } = renderHook(() => useBookingPolicy(POLICY));
    act(() => {
      result.current.toggle(0);
      result.current.toggle(1);
    });
    expect(result.current.complete).toBe(true);
    act(() => result.current.replace({ ...POLICY, checklist: ["New line"], version: "v2" }));
    expect(result.current.ticked).toEqual([false]);
    expect(result.current.complete).toBe(false);
    expect(result.current.acceptedVersion).toBe("v2");
  });

  it("no checklist is already complete, and sends no version", () => {
    const { result } = renderHook(() => useBookingPolicy({ ...POLICY, checklist: [] }));
    expect(result.current.complete).toBe(true);
    expect(result.current.acceptedVersion).toBeUndefined();
    const none = renderHook(() => useBookingPolicy(null));
    expect(none.result.current.complete).toBe(true);
    expect(none.result.current.policy).toBeNull();
  });

  it("reads only a well-formed policy out of a 409", () => {
    expect(readBookingPolicy(null)).toBeNull();
    expect(readBookingPolicy({ checklist: "x" })).toBeNull();
    expect(readBookingPolicy({ checklist: ["a", 3], version: "v", text: 5 })).toEqual({
      checklist: ["a"],
      version: "v",
      text: null,
    });
  });

  it("money terms show only when a payment is taken at booking", () => {
    expect(moneyTermsLines(null)).toEqual([]);
    expect(moneyTermsLines({ collects: null, sentence: "none - pay at the shop" })).toEqual([]);
    expect(
      moneyTermsLines({ collects: "card", sentence: "no charge at booking", cancellation: null }),
    ).toEqual([]);
    expect(
      moneyTermsLines({
        collects: "payment",
        sentence: "full payment collected at booking time",
        cancellation: "free up to 24h before",
      }),
    ).toEqual([
      "Payment: Full payment collected at booking time.",
      "Cancelling: Free up to 24h before.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The real booking page, driven to its last step.
// ---------------------------------------------------------------------------

/** A shop-local (UTC) day a few days out - never a literal date. */
const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;

function shopData(bookingPolicy: BookingPolicyData | null | undefined): BookShopData {
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
      payment: { collects: null, mode: "off", depositAmountCents: null, sentence: "none - pay at the shop" },
      ...(bookingPolicy !== undefined ? { bookingPolicy } : {}),
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

/** Land on the last step: "Soonest available" binds the one open time. */
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

const confirmButton = () =>
  screen.getByRole("button", { name: "Confirm booking" }) as HTMLButtonElement;

describe("the booking page's last step", () => {
  it("🔴 shows the checklist UNTICKED and keeps Confirm disabled, saying why", async () => {
    await reachLastStep(shopData(POLICY));
    expect(screen.getByText("Before you book")).toBeTruthy();
    const boxes = screen
      .getAllByRole("checkbox")
      .filter((b) => POLICY.checklist.some((l) => b.closest("label")?.textContent?.includes(l)));
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect((b as HTMLInputElement).checked).toBe(false);
    expect(confirmButton().disabled).toBe(true);
    expect(screen.getByText(POLICY_HINT)).toBeTruthy();

    fireEvent.click(screen.getByText(POLICY.checklist[0]!));
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(screen.getByText(POLICY.checklist[1]!));
    expect(confirmButton().disabled).toBe(false);
    expect(screen.queryByText(POLICY_HINT)).toBeNull();
  });

  it("🔴 sends the version the customer ticked", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    await reachLastStep(shopData(POLICY));
    fireEvent.click(screen.getByText(POLICY.checklist[0]!));
    fireEvent.click(screen.getByText(POLICY.checklist[1]!));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(bookAction).toHaveBeenCalled());
    expect(bookAction.mock.calls[0]![1].policyVersion).toBe(POLICY.version);
  });

  it("🔴 a 409 with a newer policy shows it, clears the ticks, and books nothing", async () => {
    bookAction.mockResolvedValue({
      ok: false,
      code: "POLICY_CHANGED",
      error: "policy_changed",
      policy: { text: null, checklist: ["Cash only"], version: "v2v2v2v2v2v2v2v2" },
    });
    await reachLastStep(shopData(POLICY));
    fireEvent.click(screen.getByText(POLICY.checklist[0]!));
    fireEvent.click(screen.getByText(POLICY.checklist[1]!));
    fireEvent.click(confirmButton());
    expect(await screen.findByText(POLICY_CHANGED_MESSAGE)).toBeTruthy();
    expect(screen.getByText("Cash only")).toBeTruthy();
    expect(screen.queryByText(POLICY.checklist[0]!)).toBeNull();
    expect(confirmButton().disabled).toBe(true);
  });

  it("🔴 a shop that wrote nothing sees NOTHING, and Confirm is not held back", async () => {
    await reachLastStep(shopData(null));
    expect(screen.queryByText("Before you book")).toBeNull();
    expect(screen.queryByText(POLICY_HINT)).toBeNull();
    expect(confirmButton().disabled).toBe(false);
  });

  it("an older API that sends no policy field at all behaves the same", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    await reachLastStep(shopData(undefined));
    expect(screen.queryByText("Before you book")).toBeNull();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(bookAction).toHaveBeenCalled());
    expect(bookAction.mock.calls[0]![1].policyVersion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A RETURNING CLIENT (rememberedBooker.ts): details filled in from this device,
// and a policy they already agreed to here not asked again.
// ---------------------------------------------------------------------------

const KEY = "chairback:booker:v1";
const FIRST = "2026-09-01T15:30:00.000Z";
const CASEY = { firstName: "Casey", lastName: "Tester", phone: "3025550142", email: "casey@example.com" };

function rememberOnThisDevice(agreements: Record<string, unknown> = {}) {
  localStorage.setItem(KEY, JSON.stringify({ contact: CASEY, agreements }));
}

/**
 * The last step, WITHOUT typing - whatever is in the form was filled in.
 *
 * Confirm used to read "Booking…" while the add-on offers loaded (every
 * transition on the page shared one pending flag), and a slow CI runner caught
 * it twice. It now reads "Booking…" only while a booking is in flight - see
 * "the Confirm button" below.
 */
async function reachLastStepReturning(data: BookShopData) {
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  await screen.findByLabelText("First name", {}, { timeout: 3000 });
  await screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
}

const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const checklistBoxes = () =>
  screen
    .queryAllByRole("checkbox")
    .filter((b) => POLICY.checklist.some((l) => b.closest("label")?.textContent?.includes(l)));

describe("a returning client", () => {
  it("has their details filled in, and 'Not you?' clears the form and forgets them", async () => {
    rememberOnThisDevice();
    await reachLastStepReturning(shopData(null));
    expect(value("First name")).toBe("Casey");
    expect(value("Last name")).toBe("Tester");
    expect(value("Mobile number")).toBe("3025550142");
    expect(value("Email")).toBe("casey@example.com");
    expect(screen.getByText(/Welcome back, Casey\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Not you?" }));
    expect(value("First name")).toBe("");
    expect(value("Mobile number")).toBe("");
    expect(value("Email")).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByText(/Welcome back/)).toBeNull();
  });

  it("🔴 is never ticked into a consent - the text-me box starts EMPTY for them too", async () => {
    rememberOnThisDevice();
    await reachLastStepReturning(shopData(null));
    const textMe = screen
      .getAllByRole("checkbox")
      .find((b) => b.closest("label")?.textContent?.includes("Text me appointment confirmations"));
    expect((textMe as HTMLInputElement).checked).toBe(false);
  });

  it("🔴 is not asked to tick a policy they already agreed to here - and the booking says so", async () => {
    rememberOnThisDevice({
      "sample-studio": { version: POLICY.version, agreedAt: FIRST, who: "tel:3025550142" },
    });
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    await reachLastStepReturning(shopData(POLICY));
    expect(checklistBoxes()).toHaveLength(0);
    expect(screen.getByText(/You agreed to these policies when you booked on/)).toBeTruthy();
    expect(screen.queryByText(POLICY_HINT)).toBeNull();
    // The words are one tap away.
    fireEvent.click(screen.getByRole("button", { name: "Read them again" }));
    expect(screen.getByText(POLICY.checklist[0]!)).toBeTruthy();

    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(bookAction).toHaveBeenCalled());
    expect(bookAction.mock.calls[0]![1]).toMatchObject({
      policyVersion: POLICY.version,
      policyAgreedAt: FIRST,
    });
  });

  it("🔴 someone else's number on this phone brings the boxes back, unticked", async () => {
    rememberOnThisDevice({
      "sample-studio": { version: POLICY.version, agreedAt: FIRST, who: "tel:3025550142" },
    });
    await reachLastStepReturning(shopData(POLICY));
    expect(checklistBoxes()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "2125550199" } });
    const boxes = checklistBoxes();
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect((b as HTMLInputElement).checked).toBe(false);
    expect(confirmButton().disabled).toBe(true);
  });

  it("🔴 changed words are asked again, like anyone new", async () => {
    rememberOnThisDevice({
      "sample-studio": { version: "an-older-version", agreedAt: FIRST, who: "tel:3025550142" },
    });
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    await reachLastStepReturning(shopData(POLICY));
    expect(checklistBoxes()).toHaveLength(2);
    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(screen.getByText(POLICY.checklist[0]!));
    fireEvent.click(screen.getByText(POLICY.checklist[1]!));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(bookAction).toHaveBeenCalled());
    // Ticked on THIS booking, so no earlier date is claimed.
    expect(bookAction.mock.calls[0]![1].policyAgreedAt).toBeUndefined();
  });

  it("a first booking remembers the details and the agreement, dated now", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    await reachLastStep(shopData(POLICY));
    fireEvent.click(screen.getByText(POLICY.checklist[0]!));
    fireEvent.click(screen.getByText(POLICY.checklist[1]!));
    const before = Date.now();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(localStorage.getItem(KEY)).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.contact).toEqual({ firstName: "Casey", lastName: "Tester", phone: "", email: "casey@example.com" });
    expect(stored.agreements["sample-studio"]).toMatchObject({
      version: POLICY.version,
      who: "mail:casey@example.com",
    });
    expect(Date.parse(stored.agreements["sample-studio"].agreedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("unticking 'Remember my details' forgets them when they book", async () => {
    rememberOnThisDevice();
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    await reachLastStepReturning(shopData(null));
    fireEvent.click(screen.getByRole("checkbox", { name: /Remember my details on this device/ }));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(bookAction).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
  });

  it("🔴 the public demo shop never fills in a real person from this device", async () => {
    rememberOnThisDevice();
    const demo = shopData(null);
    demo.shop.slug = "demo";
    await reachLastStepReturning(demo);
    expect(value("First name")).toBe("");
    expect(screen.queryByText(/Welcome back/)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Remember my details/ })).toBeNull();
  });

  it("a refused booking remembers nothing", async () => {
    bookAction.mockResolvedValue({ ok: false, code: "BOOKING_FAILED", error: "failed" });
    await reachLastStep(shopData(null));
    fireEvent.click(confirmButton());
    await screen.findByText("Something went wrong. Please try again.");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CONFIRM WHILE A BOOKING IS IN FLIGHT. The button used the page's transition
// flag, which (React 18) ends when the request is SENT, not answered: it came
// back to life mid-booking, so a double tap sent two.
// ---------------------------------------------------------------------------

describe("the Confirm button", () => {
  /** bookAction held open until the test answers it. */
  function holdTheAnswer() {
    let answer: (v: unknown) => void = () => {};
    bookAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
    );
    return (v: unknown) => act(async () => answer(v));
  }

  it("🔴 a double tap sends ONE booking - Confirm reads Booking… and stays off until the answer is back", async () => {
    const answer = holdTheAnswer();
    await reachLastStep(shopData(null));
    const confirm = confirmButton();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(bookAction).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole("button", { name: "Booking…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await answer({ ok: true, manageToken: "tok" });
    expect(await screen.findByText("You're booked!")).toBeTruthy();
  });

  it("🔴 a refused booking gives Confirm back, so they can fix it and try again", async () => {
    const answer = holdTheAnswer();
    await reachLastStep(shopData(null));
    fireEvent.click(confirmButton());
    await answer({ ok: false, code: "BOOKING_FAILED", error: "failed" });
    await screen.findByText("Something went wrong. Please try again.");
    expect(confirmButton().disabled).toBe(false);
  });
});
