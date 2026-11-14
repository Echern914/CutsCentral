import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimOffer, CLAIM_POLICY_HINT, type OfferView } from "./ClaimOffer";
import { claimOfferAction } from "./actions";
import { POLICY_CHANGED_MESSAGE } from "@/app/book/[slug]/BookingPolicy";

vi.mock("./actions", () => ({
  claimOfferAction: vi.fn(async () => ({
    ok: true,
    startsAt: "",
    shopSlug: "cuts",
    pending: false,
  })),
  declineOfferAction: vi.fn(async (_token: string, leave: boolean) => ({ ok: true, left: leave })),
}));

/**
 * A waitlist claim books, so it asks what the booking page asks: the shop's
 * "Before you book", every box unticked, and the button off until all are
 * ticked. Before this, a client who took an opening from the waitlist email
 * was booked without ever seeing the shop's policies.
 */

const mockClaim = vi.mocked(claimOfferAction);
beforeEach(() => {
  mockClaim.mockClear();
});

const POLICY = {
  text: "Be on time. 15 minutes late and the visit is cancelled.",
  checklist: ["I will arrive on time", "No extra guests"],
  version: "v1v1v1v1v1v1v1v1",
};

const offer = (over: Partial<OfferView> = {}): OfferView => ({
  shopName: "Fade Lab",
  timezone: "America/New_York",
  serviceName: "Cut",
  staffName: "Sam",
  startsAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  firstName: "Wanda",
  email: "w@test.local",
  approvalRequired: false,
  bookingPolicy: POLICY,
  ...over,
});

const bookButton = () => screen.getByRole("button", { name: "Book this time" }) as HTMLButtonElement;
const boxes = () => screen.getAllByRole("checkbox") as HTMLInputElement[];

describe("the shop's policies on the claim card", () => {
  it("shows the words and every line, all unticked, and the button waits", () => {
    render(<ClaimOffer token="t" offer={offer()} />);
    expect(screen.getByText("Before you book")).toBeTruthy();
    expect(screen.getByText(POLICY.text)).toBeTruthy();
    expect(screen.getByLabelText("I will arrive on time")).toBeTruthy();
    expect(screen.getByLabelText("No extra guests")).toBeTruthy();
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(bookButton().disabled).toBe(true);
    expect(screen.getByText(CLAIM_POLICY_HINT)).toBeTruthy();
  });

  it("🔴 one line ticked is not enough; all ticked books, sending the version", async () => {
    render(<ClaimOffer token="tok-p" offer={offer()} />);
    fireEvent.click(screen.getByLabelText("I will arrive on time"));
    expect(bookButton().disabled).toBe(true);
    fireEvent.click(bookButton());
    expect(mockClaim).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("No extra guests"));
    expect(bookButton().disabled).toBe(false);
    expect(screen.queryByText(CLAIM_POLICY_HINT)).toBeNull();
    fireEvent.click(bookButton());
    expect(await screen.findByText(/booked/i)).toBeTruthy();
    expect(mockClaim).toHaveBeenCalledWith("tok-p", {
      email: "w@test.local",
      policyVersion: POLICY.version,
    });
  });

  it("the words changed mid-claim: the new lines show, every tick clears, and it says why", async () => {
    const next = { ...POLICY, checklist: [...POLICY.checklist, "Cash only"], version: "v2v2v2v2v2v2v2v2" };
    mockClaim.mockResolvedValueOnce({ ok: false, reason: "policy", policy: next });
    render(<ClaimOffer token="tok-c" offer={offer()} />);
    fireEvent.click(screen.getByLabelText("I will arrive on time"));
    fireEvent.click(screen.getByLabelText("No extra guests"));
    fireEvent.click(bookButton());

    expect(await screen.findByText(POLICY_CHANGED_MESSAGE)).toBeTruthy();
    expect(screen.getByLabelText("Cash only")).toBeTruthy();
    expect(boxes()).toHaveLength(3);
    expect(boxes().every((b) => !b.checked)).toBe(true);
    expect(bookButton().disabled).toBe(true);

    for (const b of boxes()) fireEvent.click(b);
    fireEvent.click(bookButton());
    expect(await screen.findByText(/booked/i)).toBeTruthy();
    expect(mockClaim).toHaveBeenLastCalledWith("tok-c", {
      email: "w@test.local",
      policyVersion: next.version,
    });
  });

  it("a refusal with no readable policy is an ordinary error, never a silent booking", async () => {
    mockClaim.mockResolvedValueOnce({ ok: false, reason: "policy", policy: null });
    render(<ClaimOffer token="tok-e" offer={offer()} />);
    for (const b of boxes()) fireEvent.click(b);
    fireEvent.click(bookButton());
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
  });

  it("a request-mode shop asks the same way", () => {
    render(<ClaimOffer token="t" offer={offer({ approvalRequired: true })} />);
    expect(screen.getByText("Before you book")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Request this time" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("no policy, or an older API: nothing to tick, the button works as before", () => {
    for (const bookingPolicy of [null, undefined]) {
      const { unmount } = render(<ClaimOffer token="t" offer={offer({ bookingPolicy })} />);
      expect(screen.queryByText("Before you book")).toBeNull();
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
      expect(bookButton().disabled).toBe(false);
      expect(screen.queryByText(CLAIM_POLICY_HINT)).toBeNull();
      unmount();
    }
  });

  it("text with no lines to tick is shown, and the button works", () => {
    render(<ClaimOffer token="t" offer={offer({ bookingPolicy: { ...POLICY, checklist: [] } })} />);
    expect(screen.getByText(POLICY.text)).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(bookButton().disabled).toBe(false);
  });
});
