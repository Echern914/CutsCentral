import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AffiliatesSection, type AdminAccount, type AdminApplication, type AdminReward } from "./AffiliatesSection";
import {
  approveAffiliateAction,
  rejectAffiliateAction,
  releaseAffiliateRewardAction,
  suspendAffiliateAction,
} from "./actions";

vi.mock("./actions", () => ({
  setCompAccessAction: vi.fn(async () => ({ ok: true })),
  approveAffiliateAction: vi.fn(async () => ({ ok: true })),
  rejectAffiliateAction: vi.fn(async () => ({ ok: true })),
  suspendAffiliateAction: vi.fn(async () => ({ ok: true })),
  reactivateAffiliateAction: vi.fn(async () => ({ ok: true })),
  releaseAffiliateRewardAction: vi.fn(async () => ({ ok: true })),
  reverseAffiliateRewardAction: vi.fn(async () => ({ ok: true })),
  correctAttributionAction: vi.fn(async () => ({ ok: true })),
}));
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

/**
 * The operator desk's two promises: applicant links are never clickable
 * (phishing), and every button is exactly one API transition with the
 * reason the API expects.
 */

const application: AdminApplication = {
  id: "app1",
  shopId: "shop1",
  status: "PENDING",
  promotionChannels: ["instagram", "in_person"],
  audienceDescription: "Local clients and a small following.",
  links: ["https://instagram.com/fadelab", "https://evil.example/login"],
  promotionPlan: "Story when someone new sits down.",
  createdAt: "2026-09-01T12:00:00.000Z",
  shopName: "Fade Lab",
  ownerEmail: "owner@fadelab.test",
};

const account: AdminAccount = {
  id: "acc1",
  shopId: "shop1",
  code: "abcDEF123456",
  status: "ACTIVE",
  suspensionReason: null,
  promotionStyles: ["short_video"],
  createdAt: "2026-09-02T12:00:00.000Z",
  shopName: "Fade Lab",
};

const reward: AdminReward = {
  id: "rw1",
  status: "REVIEW_REQUIRED",
  amountCents: 3499,
  currency: "usd",
  basisPlan: "pro",
  qualifiedAt: "2026-09-06T00:00:00.000Z",
  reviewReason: "rolling_year_threshold",
  affiliateShopName: "Fade Lab",
  referredShopName: "New Cuts",
};

const flags = {
  programEnabled: true,
  publicApplicationsEnabled: true,
  qualificationEnabled: false,
  creditExecutionEnabled: false,
};

beforeEach(() => {
  vi.mocked(approveAffiliateAction).mockClear();
  vi.mocked(rejectAffiliateAction).mockClear();
  vi.mocked(suspendAffiliateAction).mockClear();
  vi.mocked(releaseAffiliateRewardAction).mockClear();
  toast.mockClear();
});

function renderDesk() {
  return render(
    <AffiliatesSection
      applications={[application]}
      accounts={[account]}
      rewards={[reward]}
      liability={{
        byStatus: { REVIEW_REQUIRED: { rewards: 1, cents: 3499 } },
        outstanding: { rewards: 1, cents: 3499 },
        accounts: { active: 1, suspended: 0 },
        applicationsPending: 1,
      }}
      flags={flags}
    />,
  );
}

describe("sign-up review", () => {
  it("🔴 shows applicant links as text with a copy button, never as anchors", () => {
    const { container } = renderDesk();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("https://evil.example/login")).toBeTruthy();
    const anchors = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(anchors.some((h) => h?.includes("evil.example"))).toBe(false);
    expect(anchors.some((h) => h?.includes("instagram.com"))).toBe(false);
  });

  it("approve and reject each call their action with what the API expects", async () => {
    renderDesk();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.change(screen.getByPlaceholderText(/Internal note/), { target: { value: "looks real" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approveAffiliateAction).toHaveBeenCalledWith("app1", "looks real"));

    fireEvent.change(screen.getByLabelText("Rejection reason"), { target: { value: "not_eligible" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(rejectAffiliateAction).toHaveBeenCalledWith("app1", "not_eligible", "looks real"),
    );
  });
});

describe("accounts and rewards", () => {
  it("suspends with the chosen reason and releases a held reward", async () => {
    renderDesk();
    fireEvent.change(screen.getByLabelText("Suspension reason"), { target: { value: "suspected_abuse" } });
    fireEvent.click(screen.getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(suspendAffiliateAction).toHaveBeenCalledWith("acc1", "suspected_abuse", ""));

    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(releaseAffiliateRewardAction).toHaveBeenCalledWith("rw1"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Released", "success"));
  });

  it("reports a refused transition plainly instead of pretending", async () => {
    vi.mocked(releaseAffiliateRewardAction).mockResolvedValueOnce({ ok: false, error: "invalid_transition" });
    renderDesk();
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Already handled", "error"));
  });

  it("shows the four flags and the liability line", () => {
    renderDesk();
    expect(screen.getByText("Program: on")).toBeTruthy();
    expect(screen.getByText("Qualification: off")).toBeTruthy();
    expect(screen.getByText(/1 sign-ups waiting/)).toBeTruthy();
  });
});
