import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AFFILIATE_POLICY } from "@chairback/config/affiliateProgram";
import { AffiliatesClient, DISCLOSURE, earningsSoFar, toolkitFor } from "./AffiliatesClient";
import { applyAffiliateAction, getAffiliateQrAction, setAffiliateStylesAction } from "./actions";
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
 * The four screens, each chosen from the API's view, and the one promise the
 * tab makes (the owner, 2026-11-02: "Stop saying they get a month off. They
 * get paid."): get paid through the ChairBack affiliate program, in dollars,
 * on the web and in the app alike. A month off earned before that change
 * still shows, as history.
 */

const mockApply = vi.mocked(applyAffiliateAction);
const mockStyles = vi.mocked(setAffiliateStylesAction);
const mockQr = vi.mocked(getAffiliateQrAction);

const SIGNUP = AFFILIATE_POLICY.dollarCredit.signupCents;
const MONTHLY = AFFILIATE_POLICY.dollarCredit.monthlyCents;
const HOLD = AFFILIATE_POLICY.qualification.holdDaysAfterSecond;
const usd = (cents: number) => `$${cents / 100}`;

function status(over: Partial<AffiliateStatus> = {}): AffiliateStatus {
  return {
    termsVersion: "v3",
    applicationsOpen: true,
    application: null,
    account: null,
    ...over,
  };
}

type Ref = AffiliateOverview["referrals"][number];
type Reward = AffiliateOverview["rewards"][number];

function ref(over: Partial<Ref>): Ref {
  return {
    id: "x",
    label: "Business ••••0001",
    stage: "signed_up",
    signedUpAt: "2026-09-01T00:00:00.000Z",
    qualifyingInvoices: 0,
    holdEndsAt: null,
    availableAt: null,
    expiresAt: null,
    reversedAt: null,
    reversalMessage: null,
    rewardType: null,
    creditCents: 0,
    ...over,
  };
}

function reward(over: Partial<Reward>): Reward {
  return {
    id: "r",
    label: "Business ••••1027",
    rewardType: "signup_credit",
    amountCents: SIGNUP,
    status: "PENDING",
    qualifiedAt: "2026-09-06T00:00:00.000Z",
    holdEndsAt: "2026-09-20T00:00:00.000Z",
    availableAt: null,
    expiresAt: null,
    reversedAt: null,
    reversalMessage: null,
    ...over,
  };
}

function overview(over: Partial<AffiliateOverview> = {}): AffiliateOverview {
  return {
    termsVersion: "v3",
    account: {
      code: "abcDEF123456",
      status: "ACTIVE",
      createdAt: "2026-08-01T00:00:00.000Z",
      promotionStyles: ["short_video", "in_the_chair"],
      stylesChosenAt: "2026-08-02T00:00:00.000Z",
      suspensionMessage: null,
      rewardStyle: "dollar_credit",
      rewardStyleSetAt: null,
    },
    months: { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
    credit: {
      earnedCents: SIGNUP,
      inHoldCents: SIGNUP,
      readyCents: 0,
      appliedCents: 0,
      underReviewCents: 0,
      reversedCents: 0,
    },
    clicks: { last7Days: 3, last30Days: 8, allTime: 15 },
    referrals: [
      ref({
        id: "a1",
        label: "Business ••••1027",
        stage: "hold",
        signedUpAt: "2026-08-10T00:00:00.000Z",
        qualifyingInvoices: 1,
        holdEndsAt: "2026-09-20T00:00:00.000Z",
        rewardType: "signup_credit",
        creditCents: SIGNUP,
      }),
      ref({
        id: "a2",
        label: "Business ••••8841",
        stage: "reversed",
        signedUpAt: "2026-07-01T00:00:00.000Z",
        qualifyingInvoices: 1,
        reversedAt: "2026-08-20T00:00:00.000Z",
        reversalMessage: "Their payment was refunded, so this reward was taken back.",
        rewardType: "signup_credit",
      }),
    ],
    rewards: [reward({ id: "r1" })],
    // What the API echoes - built from the program's own config, so a policy
    // change moves these tests with it instead of hiding behind a stale copy.
    policy: {
      attributionWindowDays: AFFILIATE_POLICY.attribution.windowDays,
      qualifyingInvoices: AFFILIATE_POLICY.qualification.qualifyingInvoices,
      holdDays: HOLD,
      expiryMonths: AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable,
      dollarCredit: {
        signupCents: SIGNUP,
        monthlyCents: MONTHLY,
        expires: AFFILIATE_POLICY.dollarCredit.expires,
      },
    },
    ...over,
  };
}

const APP = "https://getchairback.com";
const active = status({
  account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
});

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
    fireEvent.change(screen.getByPlaceholderText(/at the workspace/), {
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

  it("🔴 says they get paid through the affiliate program, in dollars - never a month off", () => {
    const { container } = render(
      <AffiliatesClient status={status()} overview={null} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByTestId("affiliate-intro").textContent).toContain(
      `Get paid through the ChairBack affiliate program: ${usd(SIGNUP)} when a business you bring on pays its first month, then ${usd(MONTHLY)} for every month it keeps paying`,
    );
    const pitch = screen.getByTestId("pitch-earn").textContent ?? "";
    expect(pitch).toContain(`You get paid: ${usd(SIGNUP)} when they pay their first month, then ${usd(MONTHLY)}`);
    expect(pitch).toContain(`${HOLD}-day hold`);
    expect(container.textContent).not.toMatch(/month off|months off|never cash/i);
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
    fireEvent.change(screen.getByPlaceholderText(/at the workspace/), { target: { value: "x" } });
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
    render(<AffiliatesClient status={active} overview={ov} appBase={APP} shopName="Fade Lab" />);
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
  it("🔴 shows the short code to say out loud, while the link keeps its long code", () => {
    const ov = overview({ account: { ...overview().account, shortCode: "FADEL482" } as never });
    render(<AffiliatesClient status={active} overview={ov} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByText("FADEL482")).toBeTruthy();
    expect(screen.getByText(`${APP}/join?ref=abcDEF123456`)).toBeTruthy();
    expect(screen.getByText(/type it when they set up their business/)).toBeTruthy();
  });

  it("leads with what they've made in dollars, shows the link, one toolkit card per style, and masked referrals with stages", () => {
    render(<AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByText("earned so far").previousSibling?.textContent).toBe(usd(SIGNUP));
    expect(screen.getByText("waiting out the hold").previousSibling?.textContent).toBe(usd(SIGNUP));
    expect(screen.getByText("paid to your bill").previousSibling?.textContent).toBe("$0");
    expect(screen.getByText(`${APP}/join?ref=abcDEF123456`)).toBeTruthy();
    expect(screen.getAllByTestId("toolkit-card")).toHaveLength(2);
    expect(screen.getByText("Short video")).toBeTruthy();
    expect(screen.getByText("In the workspace")).toBeTruthy();
    expect(screen.getByText("Business ••••1027")).toBeTruthy();
    // The referral badge and the reward row both say it - one per surface.
    expect(screen.getAllByText("In the hold")).toHaveLength(2);
    expect(screen.getByText("Taken back")).toBeTruthy();
    expect(screen.getByText(/Opened 3 times this week/)).toBeTruthy();
  });

  it("🔴 says get paid through the affiliate program, with the program's real numbers, and no month off anywhere", () => {
    const { container } = render(
      <AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByText("For every business you bring in")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Get paid through the ChairBack affiliate program" }),
    ).toBeTruthy();
    const terms = screen.getByTestId("earn-terms").textContent ?? "";
    expect(terms).toContain(
      `${usd(SIGNUP)} when a business that signed up through your link pays its first month, then ${usd(MONTHLY)} for every month it keeps paying`,
    );
    expect(terms).toContain(`${HOLD}-day hold`);
    expect(terms).toMatch(/No cap/);
    expect(terms).toMatch(/For now you.re paid as credit on your own ChairBack bill/);
    expect(container.textContent).not.toMatch(/month off|months off|never cash/i);
    // The month-off choice is gone, and so is its progress bar.
    expect(screen.queryByRole("button", { name: /month off/i })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.textContent).not.toMatch(/\bpro_ai\b|\bPro AI\b|\$34|\$74/);
  });

  it("totals, per-business badges and payment rows all in dollars", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          credit: {
            earnedCents: SIGNUP + 2 * MONTHLY,
            inHoldCents: MONTHLY,
            readyCents: MONTHLY,
            appliedCents: SIGNUP,
            underReviewCents: 0,
            reversedCents: 0,
          },
          referrals: [
            ref({
              id: "a1",
              label: "Business ••••4410",
              stage: "applied",
              qualifyingInvoices: 3,
              rewardType: "signup_credit",
              creditCents: SIGNUP + 2 * MONTHLY,
            }),
            ref({ id: "a2", label: "Business ••••5520", stage: "first_payment", qualifyingInvoices: 1, rewardType: "signup_credit" }),
          ],
          rewards: [
            reward({ id: "c1", label: "Business ••••4410", status: "APPLIED" }),
            reward({ id: "c2", label: "Business ••••4410", rewardType: "monthly_credit", amountCents: MONTHLY, status: "AVAILABLE" }),
            reward({ id: "c3", label: "Business ••••4410", rewardType: "monthly_credit", amountCents: MONTHLY, status: "PENDING" }),
          ],
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByText("earned so far").previousSibling?.textContent).toBe(usd(SIGNUP + 2 * MONTHLY));
    expect(screen.getByText("paid to your bill").previousSibling?.textContent).toBe(usd(SIGNUP));
    expect(screen.getByText("ready").previousSibling?.textContent).toBe(usd(MONTHLY));
    expect(screen.getByText("waiting out the hold").previousSibling?.textContent).toBe(usd(MONTHLY));

    expect(screen.getByText("Paid to your bill")).toBeTruthy();
    expect(screen.getByText("Paid")).toBeTruthy();
    expect(screen.getByText(new RegExp(`\\${usd(SIGNUP + 2 * MONTHLY)} earned`))).toBeTruthy();
    expect(screen.getByText("Your payments")).toBeTruthy();
    expect(screen.getByText(`${usd(SIGNUP)} · Business ••••4410`)).toBeTruthy();
    expect(screen.getAllByText(`${usd(MONTHLY)} · Business ••••4410`)).toHaveLength(2);
    expect(screen.getByText("Comes off your next ChairBack bill")).toBeTruthy();
    expect(screen.getByText("How you get paid")).toBeTruthy();
    expect(screen.getByTestId("how-it-works").textContent).toMatch(
      /refunded or disputed before it.s paid to you/,
    );
  });

  it("empty state: a brand-new affiliate sees the promise, the link and code, and $0 - never a blank page", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          referrals: [],
          rewards: [],
          credit: { earnedCents: 0, inHoldCents: 0, readyCents: 0, appliedCents: 0, underReviewCents: 0, reversedCents: 0 },
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Get paid through the ChairBack affiliate program" }),
    ).toBeTruthy();
    expect(screen.getByText(`${APP}/join?ref=abcDEF123456`)).toBeTruthy();
    expect(screen.getByText("abcDEF123456")).toBeTruthy();
    expect(screen.getByText("earned so far").previousSibling?.textContent).toBe("$0");
    expect(screen.getByText(/Nobody yet\. Businesses that sign up/)).toBeTruthy();
    expect(screen.queryByText("Your payments")).toBeNull();
  });

  it("a month off earned before the change still shows, in the words it was earned under", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          months: { earned: 1, onTheWay: 1, underReview: 0, reversed: 0, expired: 0 },
          referrals: [
            ref({
              id: "m",
              label: "Business ••••3333",
              stage: "month_off",
              qualifyingInvoices: 2,
              availableAt: "2026-10-01T00:00:00.000Z",
              expiresAt: "2027-10-01T00:00:00.000Z",
              rewardType: "subscription_credit",
            }),
          ],
          rewards: [
            reward({
              id: "r9",
              label: "Business ••••3333",
              rewardType: "subscription_credit",
              amountCents: 3499,
              status: "AVAILABLE",
              availableAt: "2026-10-01T00:00:00.000Z",
              expiresAt: "2027-10-01T00:00:00.000Z",
            }),
          ],
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    // The program still leads: they get paid from here on.
    expect(
      screen.getByRole("heading", { name: "Get paid through the ChairBack affiliate program" }),
    ).toBeTruthy();
    expect(screen.getByText("Months off from before")).toBeTruthy();
    expect(screen.getByText("months off so far").previousSibling?.textContent).toBe("2");
    expect(screen.getByText("Month off ready")).toBeTruthy();
    expect(screen.getByText("1 month off · Business ••••3333")).toBeTruthy();
    expect(screen.getByText(/^Use by /)).toBeTruthy();
  });

  it("totals come from the reward ledger", () => {
    const r = (status: string) => reward({ status, rewardType: "subscription_credit" });
    expect(
      earningsSoFar({
        months: { earned: 1, onTheWay: 3, underReview: 1, reversed: 1, expired: 0 },
        rewards: [r("APPLIED"), r("AVAILABLE"), r("RESERVED"), r("PENDING"), r("REVIEW_REQUIRED"), r("REVERSED")],
      }),
    ).toEqual({ total: 4, used: 1, ready: 2, inHold: 1, underReview: 1 });
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
  it("🔴 speaks the shop's own words - a nail tech's templates mention no chairs", () => {
    const nails = { stationNoun: "station", businessNoun: "studio", clientNounPlural: "guests" };
    for (const style of ["short_video", "posts_stories", "in_the_chair", "flyer_qr", "blog_podcast"] as const) {
      const card = toolkitFor(style, { link: "https://x.test/join?ref=a", shopName: "Polish", vocab: nails });
      // Word boundaries: "ChairBack" is the product's name, not a chair. (This
      // line once held raw backspace bytes where \b belonged, and could never fail.)
      expect(`${card.title} ${card.blurb} ${card.text}`).not.toMatch(/\bchairs?\b/i);
    }
  });

  it("every asset carries the link or a bio pointer, and the disclosure line", () => {
    const link = "https://getchairback.com/join?ref=abc";
    for (const style of ["short_video", "posts_stories", "in_the_chair", "text_dm", "email_list", "flyer_qr", "blog_podcast", "other"] as const) {
      const card = toolkitFor(style, {
        link,
        shopName: "Fade Lab",
        vocab: { stationNoun: "chair", businessNoun: "barbershop", clientNounPlural: "clients" },
      });
      expect(card.text).toMatch(/affiliate/i);
      expect(card.text.includes(link) || /link in (my )?bio|text you my link/i.test(card.text)).toBe(true);
      expect(card.text).not.toMatch(/\$\s?\d/);
    }
  });

  it("the disclosure says the affiliate gets paid - never a month off, never an amount", () => {
    const link = "https://getchairback.com/join?ref=abc";
    for (const style of ["short_video", "in_the_chair", "text_dm", "other"] as const) {
      const card = toolkitFor(style, { link, shopName: "Fade Lab" });
      expect(card.text).toMatch(/get paid when/);
      expect(card.text).not.toMatch(/month off|account credit|\$/);
    }
    expect(toolkitFor("other", { link, shopName: "Fade Lab" }).text).toBe(`${link}\n${DISCLOSURE}`);
  });
});
