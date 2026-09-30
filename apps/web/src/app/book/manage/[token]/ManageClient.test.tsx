import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ManageData } from "./page";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), refresh }),
  usePathname: () => "/book/manage/tok",
}));
// The card form is Stripe's; here it is a button that "saves the card".
vi.mock("../../[slug]/PaymentStep", () => ({
  PaymentStep: (p: { onPaid: () => void; intent: string }) => (
    <button type="button" onClick={p.onPaid}>
      {`stub ${p.intent} form`}
    </button>
  ),
}));
const cardSavedAction = vi.fn(async () => ({ ok: true, status: "BOOKED" }));
const bookingStatusAction = vi.fn(async () => ({ ok: true, status: "BOOKED" }));
vi.mock("../../[slug]/actions", () => ({
  cardSavedAction: (...a: unknown[]) => cardSavedAction(...(a as [])),
  bookingStatusAction: (...a: unknown[]) => bookingStatusAction(...(a as [])),
}));
const stopServiceChargesAction = vi.fn();
const removeSavedCardAction = vi.fn(async () => ({ ok: true }));
vi.mock("./actions", () => ({
  stopServiceChargesAction: (...a: unknown[]) => stopServiceChargesAction(...a),
  removeSavedCardAction: (...a: unknown[]) => removeSavedCardAction(...(a as [])),
  cancelBookingAction: vi.fn(),
  checkInAction: vi.fn(),
  nudgeReplyAction: vi.fn(),
  rescheduleBookingAction: vi.fn(),
  rescheduleOptionsAction: vi.fn(),
}));
vi.mock("@/lib/nativeReady", () => ({ useSignalNativeReady: () => {} }));
vi.mock("@/components/tour/state", () => ({ useDemoTour: () => false }));
vi.mock("@/components/tour/DemoTour", () => ({ DemoTour: () => null }));

const { ManageClient } = await import("./ManageClient");

/**
 * The manage page is what the confirmation text and email link to, and until
 * now it answered "what" and "when" but never "where" or "how long until".
 * Both are computed from the same shared helpers the emails and the app use.
 */

// A fixed "now" so the countdown is deterministic: Tuesday 11:00 New York.
const NOW = new Date("2026-09-08T15:00:00Z");

function data(
  over: Omit<Partial<ManageData>, "shop"> & { shop?: Partial<ManageData["shop"]> } = {},
): ManageData {
  const { shop, ...rest } = over;
  return {
    status: "BOOKED",
    firstName: "Wes",
    startsAt: "2026-09-11T15:00:00Z", // three calendar days on
    endsAt: "2026-09-11T15:30:00Z",
    shop: {
      name: "Chern Cuts",
      timezone: "America/New_York",
      slug: "chern-cuts",
      address: "123 Main St, Wilmington, DE 19801",
      mapsUrl:
        "https://www.google.com/maps/search/?api=1&query=123%20Main%20St%2C%20Wilmington%2C%20DE%2019801",
      ...shop,
    },
    service: { name: "Haircut", durationMin: 30 },
    staff: { name: "Dre" },
    canCancel: true,
    canReschedule: true,
    series: null,
    checkin: { open: false, status: null, etaMinutes: null, runningLate: false },
    nudges: [],
    nudgeReplied: false,
    ...rest,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => vi.useRealTimers());

describe("the manage page says where and how long", () => {
  it("shows the address as a directions link", () => {
    render(<ManageClient token="tok" data={data()} />);
    expect(screen.getByText("Where")).toBeTruthy();
    const link = screen.getByRole("link", { name: "123 Main St, Wilmington, DE 19801" });
    expect(link.getAttribute("href")).toContain("google.com/maps/search/?api=1&query=");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("counts down to the appointment in calendar days", () => {
    render(<ManageClient token="tok" data={data()} />);
    expect(screen.getByText("In 3 days")).toBeTruthy();
  });

  it("says nothing about a place the shop has not published", () => {
    render(<ManageClient token="tok" data={data({ shop: { address: null, mapsUrl: null } })} />);
    expect(screen.queryByText("Where")).toBeNull();
    // ...and still says when.
    expect(screen.getByText("In 3 days")).toBeTruthy();
  });

  it("drops the countdown once the appointment is over or gone", () => {
    render(<ManageClient token="tok" data={data({ status: "CANCELED" })} />);
    expect(screen.queryByText(/^In \d/)).toBeNull();
    // The address still shows - a canceled customer may well be rebooking.
    expect(screen.getByText("Where")).toBeTruthy();
  });
});

describe("the manage page tells the truth about status", () => {
  it("🔴 a pending request reads 'Requested', never 'Confirmed'", () => {
    render(
      <ManageClient
        token="tok"
        data={data({ status: "PENDING", requested: { reason: "approval" }, canCancel: false, canReschedule: false })}
      />,
    );
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.queryByText("Confirmed")).toBeNull();
    expect(screen.queryByText("Booked")).toBeNull();
    expect(screen.getByText("Waiting for Chern Cuts to confirm")).toBeTruthy();
  });

  it("🔴 an unfinished checkout says NOT BOOKED, not the shop's name", () => {
    render(
      <ManageClient
        token="tok"
        data={data({ status: "PENDING", requested: { reason: "payment" }, canCancel: false, canReschedule: false })}
      />,
    );
    expect(screen.getByText("Not booked yet: checkout isn't finished")).toBeTruthy();
  });

  it("still says 'Requested' when an older API sends no reason", () => {
    render(<ManageClient token="tok" data={data({ status: "PENDING", canCancel: false, canReschedule: false })} />);
    expect(screen.getByText("Requested")).toBeTruthy();
    expect(screen.queryByText("Confirmed")).toBeNull();
  });

  it("a booked appointment reads 'Booked'", () => {
    render(<ManageClient token="tok" data={data()} />);
    expect(screen.getByText("Booked")).toBeTruthy();
    expect(screen.queryByText("Confirmed")).toBeNull();
  });

  it("a no-show reads 'No-show' and is not thanked for visiting", () => {
    render(<ManageClient token="tok" data={data({ status: "NO_SHOW" })} />);
    expect(screen.getByText("No-show")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByText(/Thanks for visiting/)).toBeNull();
    expect(screen.getByText("Chern Cuts marked this appointment as a no-show.")).toBeTruthy();
  });

  it("a completed visit reads 'Completed' and is thanked", () => {
    render(<ManageClient token="tok" data={data({ status: "COMPLETED" })} />);
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Thanks for visiting Chern Cuts!")).toBeTruthy();
  });
});

describe("stopping the shop charging the saved card", () => {
  const withCard = (withdrawnAt: string | null = null) =>
    data({ serviceCharge: { card: { brand: "visa", last4: "4242" }, withdrawnAt } });

  it("offers nothing when the customer never gave the permission", () => {
    render(<ManageClient token="tok" data={data()} />);
    expect(screen.queryByText(/Stop letting the shop charge this card/)).toBeNull();
  });

  it("asks first, then stops it, and says so", async () => {
    stopServiceChargesAction.mockResolvedValue({ ok: true });
    render(<ManageClient token="tok" data={withCard()} />);
    expect(screen.getByText(/charge your Visa card ending 4242 for your service/)).toBeTruthy();

    fireEvent.click(screen.getByText("Stop letting the shop charge this card"));
    // One tap only asks - nothing is sent yet.
    expect(stopServiceChargesAction).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByText("Yes, stop charges to this card"));
    });
    expect(stopServiceChargesAction).toHaveBeenCalledWith("tok");
    expect(screen.getByText(/can no longer charge your Visa card ending 4242/)).toBeTruthy();
  });

  it("shows it as stopped, with no button, once withdrawn - even after the visit", () => {
    render(<ManageClient token="tok" data={{ ...withCard("2026-09-08T14:00:00Z"), status: "COMPLETED" }} />);
    expect(screen.getByText(/can no longer charge your Visa card ending 4242/)).toBeTruthy();
    expect(screen.queryByText(/Stop letting the shop charge this card/)).toBeNull();
  });
});

describe("a booking left at its card step, from its own link", () => {
  // 15:00Z is 11:00 AM in New York; the hold runs to 11:08 AM.
  const finish = {
    kind: "setup" as const,
    clientSecret: "seti_live_secret",
    amountCents: 0,
    isDeposit: false,
    balanceDueCents: 3500,
    expiresAt: "2026-09-08T15:08:00Z",
    serviceChargeConsent: false,
  };
  const held = () =>
    data({
      status: "PENDING",
      requested: { reason: "payment" },
      canCancel: false,
      canReschedule: false,
      finish,
    });

  it("🔴 says it is NOT booked, until when, and offers the card step to finish it", () => {
    render(<ManageClient token="tok" data={held()} />);
    expect(screen.getByText("Not booked yet: finish checkout by 11:08 AM")).toBeTruthy();
    expect(screen.getByText("Save a card to book this time")).toBeTruthy();
    expect(screen.getByText("stub setup form")).toBeTruthy();
    expect(screen.queryByText("Booked")).toBeNull();
  });

  it("saving the card there asks the server to check, then shows the real booking", async () => {
    vi.useRealTimers();
    cardSavedAction.mockClear();
    refresh.mockClear();
    render(<ManageClient token="tok" data={held()} />);
    await act(async () => {
      fireEvent.click(screen.getByText("stub setup form"));
    });
    expect(cardSavedAction).toHaveBeenCalledWith("tok");
    expect(refresh).toHaveBeenCalled();
  });

  it("repeats what they agreed to on the booking page - never less", () => {
    render(<ManageClient token="tok" data={{ ...held(), finish: { ...finish, serviceChargeConsent: true } }} />);
    expect(screen.getByText(/As you agreed, Chern Cuts can charge this card for your service/)).toBeTruthy();
  });

  it("🔴 a hold that ran out reads 'Not booked', never 'Canceled'", () => {
    render(
      <ManageClient
        token="tok"
        data={data({ status: "CANCELED", neverBooked: true, canCancel: false, canReschedule: false })}
      />,
    );
    expect(screen.getByText("Not booked")).toBeTruthy();
    expect(screen.queryByText("Canceled")).toBeNull();
    expect(screen.getByText(/wasn't booked: the checkout wasn't finished before the hold ran out/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Book a new time" })).toBeTruthy();
  });

  it("a real cancellation still reads 'Canceled'", () => {
    render(<ManageClient token="tok" data={data({ status: "CANCELED", neverBooked: false })} />);
    expect(screen.getByText("Canceled")).toBeTruthy();
  });
});

describe("the saved card on the appointment link", () => {
  it("shows the card the shop keeps for them, and takes it off in two taps", async () => {
    removeSavedCardAction.mockClear();
    render(<ManageClient token="tok" data={data({ savedCard: { brand: "visa", last4: "4242" } })} />);
    expect(screen.getByText("Saved card: Visa •••• 4242")).toBeTruthy();
    fireEvent.click(screen.getByText("Remove this card from Chern Cuts"));
    // One tap only asks.
    expect(removeSavedCardAction).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByText("Yes, remove it"));
    });
    expect(removeSavedCardAction).toHaveBeenCalledWith("tok");
    expect(screen.getByText(/Visa •••• 4242 is no longer saved at Chern Cuts/)).toBeTruthy();
  });

  it("says nothing when no card is saved", () => {
    render(<ManageClient token="tok" data={data({ savedCard: null })} />);
    expect(screen.queryByText(/Saved card:/)).toBeNull();
  });
});
