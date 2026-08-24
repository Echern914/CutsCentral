import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimOffer, type OfferView } from "./ClaimOffer";
import { claimOfferAction } from "./actions";

vi.mock("./actions", () => ({
  claimOfferAction: vi.fn(async () => ({
    ok: true,
    startsAt: "",
    shopSlug: "cuts",
    pending: false,
  })),
}));

/**
 * The claim screen's own promises: a dead link gets ONE generic card that
 * names nobody, a live one books on a single tap, and a hold that dies
 * between page load and the tap degrades into the same generic ending.
 */

const mockClaim = vi.mocked(claimOfferAction);
beforeEach(() => mockClaim.mockClear());

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
  ...over,
});

describe("dead links", () => {
  it("no offer (unknown/expired/released/claimed) = one generic card, no data", () => {
    render(<ClaimOffer token="t" offer={null} />);
    expect(screen.getByText(/this hold has ended/i)).toBeTruthy();
    expect(screen.queryByText(/Wanda|Fade Lab|Sam/)).toBeNull();
  });

  it("an offer whose clock already ran out renders the same ended card", () => {
    render(
      <ClaimOffer
        token="t"
        offer={offer({ expiresAt: new Date(Date.now() - 1000).toISOString() })}
      />,
    );
    expect(screen.getByText(/this hold has ended/i)).toBeTruthy();
  });
});

describe("a live hold", () => {
  it("shows who/what/when, prefills the email, and books on one tap", async () => {
    render(<ClaimOffer token="tok-1" offer={offer()} />);
    expect(screen.getByText(/Wanda, this/)).toBeTruthy();
    expect(screen.getByText(/Cut with Sam at Fade Lab/)).toBeTruthy();
    expect((screen.getByPlaceholderText("you@example.com") as HTMLInputElement).value).toBe(
      "w@test.local",
    );

    fireEvent.click(screen.getByText("Book this time"));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/booked/i)).toBeTruthy();
    expect(mockClaim).toHaveBeenCalledWith("tok-1", { email: "w@test.local" });
  });

  it("a hold that lapsed between load and tap collapses to the generic ending", async () => {
    mockClaim.mockResolvedValueOnce({ ok: false, reason: "expired" });
    render(<ClaimOffer token="tok-2" offer={offer()} />);
    fireEvent.click(screen.getByText("Book this time"));
    expect(await screen.findByText(/this hold has ended/i)).toBeTruthy();
  });

  it("a slot taken through an overriding path gets its own honest card", async () => {
    mockClaim.mockResolvedValueOnce({ ok: false, reason: "gone" });
    render(<ClaimOffer token="tok-3" offer={offer()} />);
    fireEvent.click(screen.getByText("Book this time"));
    expect(await screen.findByText(/just got taken/i)).toBeTruthy();
  });

  it("a deposit flipped on mid-hold explains itself and keeps them on the list", async () => {
    mockClaim.mockResolvedValueOnce({ ok: false, reason: "deposit" });
    render(<ClaimOffer token="tok-4" offer={offer()} />);
    fireEvent.click(screen.getByText("Book this time"));
    expect(await screen.findByText(/needs a deposit/i)).toBeTruthy();
    expect(screen.getByText(/still on the\s+waitlist/i)).toBeTruthy();
  });
});

describe("approval-mode shops", () => {
  it("says REQUEST throughout - never promises a booking the shop hasn't confirmed", async () => {
    mockClaim.mockResolvedValueOnce({
      ok: true,
      startsAt: "",
      shopSlug: "cuts",
      pending: true,
    });
    render(<ClaimOffer token="tok-5" offer={offer({ approvalRequired: true })} />);
    // The button and the fine print both say request.
    expect(screen.queryByText("Book this time")).toBeNull();
    expect(screen.getByText(/confirms appointment requests/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Request this time"));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/request sent/i)).toBeTruthy();
    expect(screen.getByText(/request .* was submitted/i)).toBeTruthy();
    expect(screen.queryByText(/you.?re booked/i)).toBeNull();
  });
});
