import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { apiGet } from "@/lib/api";
import ReferralsPage from "./page";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn() }));
vi.mock("@/lib/vocab", () => ({ getVocabulary: async () => ({ providerNoun: "barber" }) }));
vi.mock("./PartnerEarnings", () => ({ PartnerEarnings: () => <div data-testid="partner-earnings" /> }));
vi.mock("./ReferralShare", () => ({ ReferralShare: () => <div data-testid="referral-share" /> }));

/**
 * The referrals page is the partner's only earnings surface, so it must work
 * for a partner who has no business here (or only a seat in someone else's):
 * their card, and none of the owner-only share-link copy or its error.
 */
function answer(shop: { status: number; data?: unknown }, partner: { status: number; data?: unknown }) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    const r = path === "/api/partner/me" ? partner : shop;
    return { ok: r.status === 200, status: r.status, data: (r.data ?? null) as never };
  });
}

const PARTNER = { name: "Coach D", code: "COACH D" };
const SHOP = { code: "ABC", referrals: [], earnedMonths: 0, pendingCount: 0, rewardDays: 30 };

describe("referrals page", () => {
  beforeEach(() => vi.mocked(apiGet).mockReset());

  it("a partner with no business sees their earnings, a way to set one up, and no owner copy", async () => {
    answer({ status: 404 }, { status: 200, data: PARTNER });
    render(await ReferralsPage());
    expect(screen.getByTestId("partner-earnings")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your earnings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set it up" })).toHaveAttribute("href", "/onboarding");
    expect(screen.queryByText(/isn.t ready yet/)).toBeNull();
    expect(screen.queryByText(/free month/)).toBeNull();
  });

  it("a partner on a team seat (shop referrals refused) sees just their earnings", async () => {
    answer({ status: 403 }, { status: 200, data: PARTNER });
    render(await ReferralsPage());
    expect(screen.getByTestId("partner-earnings")).toBeInTheDocument();
    expect(screen.queryByText(/isn.t ready yet/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Set it up" })).toBeNull();
  });

  it("an owner who is also a partner sees both", async () => {
    answer({ status: 200, data: SHOP }, { status: 200, data: PARTNER });
    render(await ReferralsPage());
    expect(screen.getByTestId("partner-earnings")).toBeInTheDocument();
    expect(screen.getByTestId("referral-share")).toBeInTheDocument();
  });

  it("an owner who is not a partner is unchanged", async () => {
    answer({ status: 200, data: SHOP }, { status: 404 });
    render(await ReferralsPage());
    expect(screen.queryByTestId("partner-earnings")).toBeNull();
    expect(screen.getByTestId("referral-share")).toBeInTheDocument();
  });
});
