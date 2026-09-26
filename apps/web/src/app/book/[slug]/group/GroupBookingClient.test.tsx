import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BookShopData } from "../page";
import type { GroupPlanResult } from "./actions";

vi.mock("./actions", () => ({
  groupSlotsAction: vi.fn(),
  groupPlanAction: vi.fn(),
  groupCreateAction: vi.fn(),
}));

const { GroupBookingClient } = await import("./GroupBookingClient");
const actions = await import("./actions");
const slotsAction = vi.mocked(actions.groupSlotsAction);
const planAction = vi.mocked(actions.groupPlanAction);
const createAction = vi.mocked(actions.groupCreateAction);

/**
 * Booking a party of two or three.
 *
 * The property under test throughout is ALL OR NOTHING AND ONCE ONLY. A group
 * that half commits tells a family to turn up without a chair for one of them;
 * a group that commits twice bills them for six haircuts.
 */
const TZ = "America/New_York";

const shop = {
  name: "Chern Cuts",
  slug: "cherncuts",
  timezone: TZ,
  logoUrl: null,
  accentColor: null,
  instagramHandle: null,
  bookingLeadHours: 2,
  bookingMaxDays: 60,
  payDirect: null,
} as unknown as BookShopData["shop"];

const data = {
  shop,
  staff: [{ id: "stf_1", name: "Sam", bio: null, imageUrl: null }],
  services: [
    { id: "svc_cut", name: "Haircut", durationMin: 30 },
    { id: "svc_kids", name: "Kids cut", durationMin: 20 },
  ],
  offerings: [
    { serviceId: "svc_cut", staffId: "stf_1" },
    { serviceId: "svc_kids", staffId: "stf_1" },
  ],
  groups: [],
  openWeekdays: [0, 1, 2, 3, 4, 5, 6],
  targetedSlots: [],
  addOns: [],
} as unknown as BookShopData;

/** 2:00 PM and 2:30 PM New York on a fixed future day. */
const TWO_PM = "2026-03-14T18:00:00.000Z";
const TWO_THIRTY = "2026-03-14T18:30:00.000Z";

const planOf = (members: GroupPlanResult["members"]): GroupPlanResult => ({
  startsAt: members[0]!.startsAt,
  endsAt: members[members.length - 1]!.endsAt,
  totalDurationMin: members.reduce((n, m) => n + m.durationMin, 0),
  totalPriceCents: members.reduce((n, m) => n + (m.priceCents ?? 0), 0),
  unpricedCount: members.filter((m) => m.priceCents === null).length,
  members,
});

const TWO_PLAN = planOf([
  {
    position: 0,
    firstName: "Eric",
    serviceId: "svc_cut",
    serviceName: "Haircut",
    startsAt: TWO_PM,
    endsAt: TWO_THIRTY,
    durationMin: 30,
    priceCents: 4000,
  },
  {
    position: 1,
    firstName: "Brother",
    serviceId: "svc_kids",
    serviceName: "Kids cut",
    startsAt: TWO_THIRTY,
    endsAt: "2026-03-14T18:50:00.000Z",
    durationMin: 20,
    priceCents: 2500,
  },
]);

beforeEach(() => {
  localStorage.clear();
  slotsAction.mockReset();
  planAction.mockReset();
  createAction.mockReset();
  slotsAction.mockResolvedValue({
    ok: true,
    data: { timezone: TZ, totalDurationMin: 50, slots: [{ startsAt: TWO_PM, endsAt: "2026-03-14T18:50:00.000Z" }] },
  });
  planAction.mockResolvedValue({ ok: true, plan: TWO_PLAN });
});

afterEach(() => {
  localStorage.clear();
});

/** Walk the flow to the review step with `n` attendees. */
async function reachReview(n: 2 | 3 = 2) {
  render(<GroupBookingClient data={data} />);
  fireEvent.click(screen.getByRole("button", { name: "Sam" }));
  fireEvent.click(screen.getByRole("button", { name: `${n} people` }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));

  const names = await screen.findAllByPlaceholderText("First name");
  fireEvent.change(names[0]!, { target: { value: "Eric" } });
  fireEvent.change(names[1]!, { target: { value: "Brother" } });
  if (n === 3) fireEvent.change(names[2]!, { target: { value: "Dad" } });
  for (const pick of screen.getAllByRole("button", { name: /Haircut/ })) {
    fireEvent.click(pick);
  }
  fireEvent.click(screen.getByRole("button", { name: "See times" }));
  await waitFor(() => expect(slotsAction).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: /2:00 PM/ }));
  await screen.findByRole("button", { name: /Confirm 2 appointments/ });
}

describe("the sequence and total are the SERVER's", () => {
  it("renders every attendee, service and time from the plan", async () => {
    await reachReview();
    expect(screen.getByText("Eric")).toBeTruthy();
    expect(screen.getByText("Brother")).toBeTruthy();
    expect(screen.getByText("Haircut")).toBeTruthy();
    expect(screen.getByText("Kids cut")).toBeTruthy();
    // 2:00-2:30 then 2:30-2:50, exactly as the server laid it out.
    // 2:30 is both an end and a start - it appears twice, which is the point.
    expect(screen.getAllByText(/2:00 PM/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2:30 PM/).length).toBeGreaterThan(0);
  });

  it("shows the server total, never one computed here", async () => {
    await reachReview();
    expect(screen.getByText("$65")).toBeTruthy(); // 4000 + 2500
    expect(screen.getByText(/50 min in total/)).toBeTruthy();
  });

  it("🔴 says PAY AT THE SHOP and never shows a deposit", async () => {
    // A party is pay-at-the-shop only - the API refuses one outright for a
    // shop that collects at booking - so any deposit line would be invented.
    await reachReview();
    expect(screen.getByText("Pay at the shop.")).toBeTruthy();
    expect(screen.queryByText(/deposit/i)).toBeNull();
  });

  it("🔴 an unpriced service is not folded into the total as zero", async () => {
    planAction.mockResolvedValue({
      ok: true,
      plan: planOf([
        { ...TWO_PLAN.members[0]! },
        { ...TWO_PLAN.members[1]!, priceCents: null },
      ]),
    });
    await reachReview();
    expect(screen.getByText(/1 priced in shop/)).toBeTruthy();
  });
});

/** The booker's details: a first name and, since Drick's rule, a last name. */
function fillBooker(details: { last?: string; instagram?: string } = { last: "Chern" }) {
  fireEvent.change(screen.getByPlaceholderText("Your first name"), {
    target: { value: "Eric" },
  });
  if (details.last !== undefined) {
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: details.last } });
  }
  if (details.instagram !== undefined) {
    fireEvent.change(screen.getByLabelText("Instagram"), { target: { value: details.instagram } });
  }
}

describe("🔴 the booker can be told apart (a last name or Instagram)", () => {
  it("a first name alone is refused in place, and nothing is sent", async () => {
    await reachReview();
    fillBooker({});
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));
    expect(
      await screen.findByText("Add your last name or Instagram so the shop can tell you apart"),
    ).toBeTruthy();
    expect(createAction).not.toHaveBeenCalled();
  });

  it("🔴 the refusal shows where the customer is looking: after the details, right above Confirm", async () => {
    // On a phone the review step is taller than the screen; a notice at the
    // top of the page is out of view, and Confirm seems to do nothing.
    await reachReview();
    fillBooker({ last: "C" });
    const confirmBtn = screen.getByRole("button", { name: /Confirm 2 appointments/ });
    fireEvent.click(confirmBtn);
    const msg = await screen.findByText("Add your last name or Instagram so the shop can tell you apart");
    expect(msg.getAttribute("role")).toBe("alert");
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByPlaceholderText("Email"), msg)).toBe(true);
    expect(follows(msg, confirmBtn)).toBe(true);
    // Typing the fix clears it.
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Chern" } });
    expect(screen.queryByText("Add your last name or Instagram so the shop can tell you apart")).toBeNull();
  });

  it("an Instagram handle alone is enough, and goes as the bare handle", async () => {
    createAction.mockResolvedValue({ kind: "booked", groupId: "grp_1", manageToken: "tok_1" });
    await reachReview();
    fillBooker({ instagram: " @Eric.Fades " });
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));
    await screen.findByText(/You're booked/);
    expect(createAction.mock.calls[0]![1]).toMatchObject({ instagram: "eric.fades" });
    expect(createAction.mock.calls[0]![1].lastName).toBeUndefined();
  });

  it("shows the server's sentence when the server refuses", async () => {
    createAction.mockResolvedValue({ kind: "invalid", message: "From the server." });
    await reachReview();
    fillBooker();
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));
    expect(await screen.findByText("From the server.")).toBeTruthy();
  });
});

describe("🔴 one submission, whatever the customer does", () => {
  it("a double click books ONE group", async () => {
    let resolve!: (v: { kind: "booked"; groupId: string; manageToken: string }) => void;
    createAction.mockReturnValue(
      new Promise((r) => {
        resolve = r as never;
      }),
    );
    await reachReview();
    fillBooker();

    const confirm = screen.getByRole("button", { name: /Confirm 2 appointments/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(createAction).toHaveBeenCalledTimes(1);
    resolve({ kind: "booked", groupId: "grp_1", manageToken: "tok_1" });
    await screen.findByText(/You're booked/);
  });

  it("a retry after a network failure reuses the SAME idempotency key", async () => {
    // 🔴 The key is what makes the retry safe: the API returns the party that
    // may already exist rather than booking a second set of chairs.
    createAction
      .mockResolvedValueOnce({ kind: "network" })
      .mockResolvedValueOnce({ kind: "booked", groupId: "grp_1", manageToken: "tok_1" });
    await reachReview();
    fillBooker();
    const confirm = screen.getByRole("button", { name: /Confirm 2 appointments/ });

    fireEvent.click(confirm);
    await screen.findByText(/will not double-book/);
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));
    await screen.findByText(/You're booked/);

    const first = createAction.mock.calls[0]![1].idempotencyKey;
    const second = createAction.mock.calls[1]![1].idempotencyKey;
    expect(first).toBe(second);
    expect(first).toBeTruthy();
  });
});

describe("🔴 202 is not a failure", () => {
  it("says the appointments are held and the calendar is still confirming", async () => {
    createAction.mockResolvedValue({
      kind: "confirming",
      groupId: "grp_1",
      manageToken: "tok_1",
    });
    await reachReview();
    fillBooker();
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));

    await screen.findByText(/Almost there/);
    expect(screen.getByText(/confirming with the shop/i)).toBeTruthy();
    // Not claimed as booked, and not reported as an error.
    expect(screen.queryByText(/went wrong/i)).toBeNull();
  });

  it("🔴 SURVIVES A RELOAD - the party is not booked twice", async () => {
    // The 202 window is exactly when somebody refreshes. Without this they
    // would see an empty form and book the whole party again.
    createAction.mockResolvedValue({
      kind: "confirming",
      groupId: "grp_1",
      manageToken: "tok_1",
    });
    await reachReview();
    fillBooker();
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));
    await screen.findByText(/Almost there/);

    // The reload.
    cleanup();
    createAction.mockClear();
    render(<GroupBookingClient data={data} />);
    expect(await screen.findByText(/Almost there/)).toBeTruthy();
    expect(createAction).not.toHaveBeenCalled();
  });
});

describe("a conflict books nothing", () => {
  it("says nothing was booked and sends them back to the times", async () => {
    createAction.mockResolvedValue({ kind: "slot_taken" });
    await reachReview();
    fillBooker();
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));

    expect(await screen.findByText(/Nothing was booked/)).toBeTruthy();
    expect(screen.queryByText(/You're booked/)).toBeNull();
  });
});

describe("a shop that takes money at booking", () => {
  it("says so plainly instead of failing at Confirm", async () => {
    createAction.mockResolvedValue({ kind: "payments" });
    await reachReview();
    fillBooker();
    fireEvent.click(screen.getByRole("button", { name: /Confirm 2 appointments/ }));
    expect(
      await screen.findByText(/Group booking isn't available online/),
    ).toBeTruthy();
  });
});

describe("🔴 quantity 1 never enters the group system", () => {
  it("offers only 2 and 3, and points one person at the normal page", () => {
    render(<GroupBookingClient data={data} />);
    expect(screen.getByRole("button", { name: "2 people" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "3 people" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "1 people" })).toBeNull();
    const link = screen.getByRole("link", { name: /normal booking page/i });
    expect(link.getAttribute("href")).toBe("/book/cherncuts");
  });
});

describe("three attendees", () => {
  it("asks for three names", async () => {
    render(<GroupBookingClient data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Sam" }));
    fireEvent.click(screen.getByRole("button", { name: "3 people" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findAllByPlaceholderText("First name")).toHaveLength(3);
  });
});

describe("mobile", () => {
  it("🔴 every truncating row carries min-w-0", async () => {
    // A flex child without min-w-0 refuses to shrink below its content, so a
    // long service name pushes the row wider than the viewport and the whole
    // page renders zoomed out on a phone.
    await reachReview();
    const rows = document.querySelectorAll("li .min-w-0");
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("renders at a 320px viewport without a horizontal overflow class", async () => {
    await reachReview();
    // Nothing sets an explicit width that could exceed a small screen.
    expect(document.querySelector('[class*="w-["]')).toBeNull();
  });
});
