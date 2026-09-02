import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AffiliatesClient, toolkitFor } from "./AffiliatesClient";
import {
  applyAffiliateAction,
  getAffiliateQrAction,
  setAffiliateStylesAction,
} from "./actions";
import type { AffiliateOverview, AffiliateStatus } from "./page";

vi.mock("./actions", () => ({
  applyAffiliateAction: vi.fn(async () => ({ ok: true })),
  setAffiliateStylesAction: vi.fn(async () => ({ ok: true })),
  getAffiliateQrAction: vi.fn(async () => ({ ok: true, qr: { svg: "<svg/>", png: "data:image/png;base64,x", url: "" } })),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

/**
 * The four screens, each chosen from the API's view, and the two promises
 * the dashboard makes: months are the number that matters, and no dollar
 * amount ever renders (the App Store 3.1.1 rule that rejected build 32).
 */

const mockApply = vi.mocked(applyAffiliateAction);
const mockStyles = vi.mocked(setAffiliateStylesAction);
const mockQr = vi.mocked(getAffiliateQrAction);

function status(over: Partial<AffiliateStatus> = {}): AffiliateStatus {
  return {
    termsVersion: "v1",
    applicationsOpen: true,
    application: null,
    account: null,
    ...over,
  };
}

function overview(over: Partial<AffiliateOverview> = {}): AffiliateOverview {
  return {
    termsVersion: "v1",
    account: {
      code: "abcDEF123456",
      status: "ACTIVE",
      createdAt: "2026-08-01T00:00:00.000Z",
      promotionStyles: ["short_video", "in_the_chair"],
      stylesChosenAt: "2026-08-02T00:00:00.000Z",
      suspensionMessage: null,
    },
    months: { earned: 2, onTheWay: 1, underReview: 0, reversed: 0, expired: 0 },
    clicks: { last7Days: 3, last30Days: 8, allTime: 15 },
    referrals: [
      {
        id: "a1",
        label: "Business ••••1027",
        stage: "hold",
        signedUpAt: "2026-08-10T00:00:00.000Z",
        qualifyingInvoices: 2,
        holdEndsAt: "2026-09-20T00:00:00.000Z",
        availableAt: null,
        expiresAt: null,
        reversedAt: null,
        reversalMessage: null,
      },
      {
        id: "a2",
        label: "Business ••••8841",
        stage: "reversed",
        signedUpAt: "2026-07-01T00:00:00.000Z",
        qualifyingInvoices: 2,
        holdEndsAt: null,
        availableAt: null,
        expiresAt: null,
        reversedAt: "2026-08-20T00:00:00.000Z",
        reversalMessage: "Their payment was refunded, so this month was taken back.",
      },
    ],
    rewards: [
      {
        id: "r1",
        label: "Business ••••1027",
        status: "PENDING",
        qualifiedAt: "2026-09-06T00:00:00.000Z",
        holdEndsAt: "2026-09-20T00:00:00.000Z",
        availableAt: null,
        expiresAt: null,
        reversedAt: null,
        reversalMessage: null,
      },
    ],
    policy: { attributionWindowDays: 60, qualifyingInvoices: 2, holdDays: 14, expiryMonths: 12 },
    ...over,
  };
}

const APP = "https://getchairback.com";

beforeEach(() => {
  mockApply.mockClear();
  mockStyles.mockClear();
  mockQr.mockClear();
  refresh.mockClear();
  toast.mockClear();
});

describe("sign up", () => {
  it("renders the pitch and a form that only sends when every required part is filled", async () => {
    render(<AffiliatesClient status={status()} overview={null} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByText("How it works")).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send my sign-up" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Instagram" }));
    fireEvent.change(screen.getByPlaceholderText(/Clients at the chair/), {
      target: { value: "Local clients and a small following." },
    });
    fireEvent.change(screen.getByPlaceholderText(/A story when someone new/), {
      target: { value: "Link in bio and a story now and then." },
    });
    fireEvent.change(screen.getByPlaceholderText("https://instagram.com/…"), {
      target: { value: "https://instagram.com/fadelab\n\nhttps://tiktok.com/@fadelab" },
    });
    expect(send.disabled).toBe(true); // both boxes still unticked
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect(send.disabled).toBe(false);

    fireEvent.click(send);
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply).toHaveBeenCalledWith({
      promotionChannels: ["instagram"],
      audienceDescription: "Local clients and a small following.",
      links: ["https://instagram.com/fadelab", "https://tiktok.com/@fadelab"],
      promotionPlan: "Link in bio and a story now and then.",
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("says so when sign-ups are closed, and shows no form", () => {
    render(
      <AffiliatesClient status={status({ applicationsOpen: false })} overview={null} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByText("Sign-ups are closed right now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send my sign-up" })).toBeNull();
  });

  it("surfaces a stale-terms refusal instead of pretending it sent", async () => {
    mockApply.mockResolvedValueOnce({ ok: false, error: "terms_not_accepted", status: 400 });
    render(<AffiliatesClient status={status()} overview={null} appBase={APP} shopName="Fade Lab" />);
    fireEvent.click(screen.getByRole("button", { name: "In person" }));
    fireEvent.change(screen.getByPlaceholderText(/Clients at the chair/), { target: { value: "x" } });
    fireEvent.change(screen.getByPlaceholderText(/A story when someone new/), { target: { value: "y" } });
    for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Send my sign-up" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/terms changed/));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("waiting and rejected", () => {
  it("shows the review notice with the submitted date", () => {
    render(
      <AffiliatesClient
        status={status({
          application: {
            id: "app1",
            status: "PENDING",
            submittedAt: "2026-09-01T12:00:00.000Z",
            decidedAt: null,
            decisionReason: null,
            publicMessage: null,
          },
        })}
        overview={null}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByText(/reviewing your sign-up/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send my sign-up" })).toBeNull();
  });

  it("shows the fixed public message, and 'Apply again' only for the reasons that invite it", () => {
    const rejected = (reason: string, msg: string) =>
      status({
        application: {
          id: "app1",
          status: "REJECTED",
          submittedAt: "2026-09-01T12:00:00.000Z",
          decidedAt: "2026-09-02T12:00:00.000Z",
          decisionReason: reason,
          publicMessage: msg,
        },
      });
    const { unmount } = render(
      <AffiliatesClient status={rejected("incomplete_application", "We couldn't verify enough yet.")} overview={null} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByText("We couldn't verify enough yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply again" }));
    expect(screen.getByRole("button", { name: "Send my sign-up" })).toBeTruthy();
    unmount();

    render(
      <AffiliatesClient status={rejected("policy_violation", "Your application couldn't be approved.")} overview={null} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.queryByRole("button", { name: "Apply again" })).toBeNull();
  });
});

describe("choose styles", () => {
  it("is the first thing an approved affiliate sees, and needs at least one pick", async () => {
    const ov = overview({
      account: { ...overview().account, promotionStyles: [], stylesChosenAt: null },
    });
    render(
      <AffiliatesClient
        status={status({ account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" } })}
        overview={ov}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByText(/How will you get the word out/)).toBeTruthy();
    const open = screen.getByRole("button", { name: "Open my dashboard" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Short video (TikTok, Reels)" }));
    fireEvent.click(screen.getByRole("button", { name: "Flyer or QR at the shop" }));
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    await waitFor(() => expect(mockStyles).toHaveBeenCalledWith(["short_video", "flyer_qr"]));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("dashboard", () => {
  const active = status({
    account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
  });

  it("leads with months, shows the link, one toolkit card per style, and masked referrals with stages", () => {
    render(<AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByText("months earned").previousSibling?.textContent).toBe("2");
    expect(screen.getByText("on the way").previousSibling?.textContent).toBe("1");
    expect(screen.getByText(`${APP}/join?ref=abcDEF123456`)).toBeTruthy();
    expect(screen.getAllByTestId("toolkit-card")).toHaveLength(2);
    expect(screen.getByText("Short video")).toBeTruthy();
    expect(screen.getByText("In the chair")).toBeTruthy();
    expect(screen.getByText("Business ••••1027")).toBeTruthy();
    // The referral badge and the reward row both say it - one per surface.
    expect(screen.getAllByText("In the hold")).toHaveLength(2);
    expect(screen.getByText("Taken back")).toBeTruthy();
    expect(screen.getByText(/Opened 3 times this week/)).toBeTruthy();
  });

  it("🔴 never renders a dollar amount (App Store 3.1.1) and never a plan name", () => {
    const { container } = render(
      <AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />,
    );
    expect(container.textContent).not.toMatch(/\$\s?\d/);
    expect(container.textContent).not.toMatch(/\bpro_ai\b|\bPro AI\b|\$34|\$74/);
  });

  it("shows the suspension sentence when the link is paused", () => {
    const ov = overview({
      account: {
        ...overview().account,
        status: "SUSPENDED",
        suspensionMessage: "Your affiliate link is paused during a review. Your history is kept.",
      },
    });
    render(<AffiliatesClient status={active} overview={ov} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByRole("status").textContent).toMatch(/paused during a review/);
  });

  it("builds the QR on demand and lets them change styles", async () => {
    render(<AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />);
    fireEvent.click(screen.getByRole("button", { name: "QR code" }));
    await waitFor(() => expect(mockQr).toHaveBeenCalledWith(`${APP}/join?ref=abcDEF123456`));
    await waitFor(() => expect(screen.getByLabelText("QR code for your affiliate link")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Change my styles" }));
    expect(screen.getByText("Change how you promote")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Your toolkit")).toBeTruthy();
  });
});

describe("toolkit", () => {
  it("every asset carries the link or a bio pointer, and the disclosure line", () => {
    const link = "https://getchairback.com/join?ref=abc";
    for (const style of ["short_video", "posts_stories", "in_the_chair", "text_dm", "email_list", "flyer_qr", "blog_podcast", "other"] as const) {
      const card = toolkitFor(style, { link, shopName: "Fade Lab" });
      expect(card.text).toMatch(/affiliate/i);
      expect(card.text.includes(link) || /link in (my )?bio|text you my link/i.test(card.text)).toBe(true);
      expect(card.text).not.toMatch(/\$\s?\d/);
    }
  });
});
