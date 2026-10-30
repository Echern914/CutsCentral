import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AFFILIATE_POLICY } from "@chairback/config/affiliateProgram";
import {
  AffiliatesClient,
  disclosureFor,
  earningsSoFar,
  milestoneLabels,
  nextMonthProgress,
  toolkitFor,
} from "./AffiliatesClient";
import {
  applyAffiliateAction,
  getAffiliateQrAction,
  setAffiliateRewardStyleAction,
  setAffiliateStylesAction,
} from "./actions";
import type { AffiliateOverview, AffiliateStatus } from "./page";

vi.mock("./actions", () => ({
  applyAffiliateAction: vi.fn(async () => ({ ok: true })),
  setAffiliateStylesAction: vi.fn(async () => ({ ok: true })),
  setAffiliateRewardStyleAction: vi.fn(async () => ({ ok: true })),
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
const mockRewardStyle = vi.mocked(setAffiliateRewardStyleAction);

/** The text the native app can show: everything outside the web-only
 *  `data-native-hide` wrappers (HideInNativeApp), which the app hides from
 *  its first paint and unmounts once it knows it is the app. The rendered
 *  native mode itself is tested in AffiliatesClient.native.test.tsx. */
function appVisibleText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-native-hide]").forEach((el) => el.remove());
  return clone.textContent ?? "";
}

function status(over: Partial<AffiliateStatus> = {}): AffiliateStatus {
  return {
    termsVersion: "v2",
    applicationsOpen: true,
    application: null,
    account: null,
    ...over,
  };
}

const NO_CREDIT: AffiliateOverview["credit"] = {
  earnedCents: 0,
  inHoldCents: 0,
  readyCents: 0,
  appliedCents: 0,
  underReviewCents: 0,
  reversedCents: 0,
};

function overview(over: Partial<AffiliateOverview> = {}): AffiliateOverview {
  return {
    termsVersion: "v2",
    account: {
      code: "abcDEF123456",
      status: "ACTIVE",
      createdAt: "2026-08-01T00:00:00.000Z",
      promotionStyles: ["short_video", "in_the_chair"],
      stylesChosenAt: "2026-08-02T00:00:00.000Z",
      suspensionMessage: null,
      // The month-off style: these tests pin the v1 words. Account credit
      // (the default for new affiliates) has its own describe below.
      rewardStyle: "month_off",
      rewardStyleSetAt: null,
    },
    months: { earned: 2, onTheWay: 1, underReview: 0, reversed: 0, expired: 0 },
    credit: NO_CREDIT,
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
        rewardType: "subscription_credit",
        creditCents: 0,
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
        reversalMessage: "Their payment was refunded, so this reward was taken back.",
        rewardType: "subscription_credit",
        creditCents: 0,
      },
    ],
    rewards: [
      {
        id: "r1",
        label: "Business ••••1027",
        rewardType: "subscription_credit",
        amountCents: 3499,
        status: "PENDING",
        qualifiedAt: "2026-09-06T00:00:00.000Z",
        holdEndsAt: "2026-09-20T00:00:00.000Z",
        availableAt: null,
        expiresAt: null,
        reversedAt: null,
        reversalMessage: null,
      },
    ],
    // What the API echoes - built from the program's own config, so a policy
    // change moves these tests with it instead of hiding behind a stale copy.
    policy: {
      attributionWindowDays: AFFILIATE_POLICY.attribution.windowDays,
      qualifyingInvoices: AFFILIATE_POLICY.qualification.qualifyingInvoices,
      holdDays: AFFILIATE_POLICY.qualification.holdDaysAfterSecond,
      expiryMonths: AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable,
      dollarCredit: {
        signupCents: AFFILIATE_POLICY.dollarCredit.signupCents,
        monthlyCents: AFFILIATE_POLICY.dollarCredit.monthlyCents,
        expires: AFFILIATE_POLICY.dollarCredit.expires,
      },
    },
    ...over,
  };
}

const APP = "https://getchairback.com";

beforeEach(() => {
  mockApply.mockClear();
  mockStyles.mockClear();
  mockQr.mockClear();
  mockRewardStyle.mockClear();
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
    // 2 applied + 1 in the hold (the fixture's one PENDING reward).
    expect(screen.getByText("months off so far").previousSibling?.textContent).toBe("3");
    expect(screen.getByText("used on your bill").previousSibling?.textContent).toBe("2");
    expect(screen.getByText("ready to use").previousSibling?.textContent).toBe("0");
    expect(screen.getByText("waiting out the hold").previousSibling?.textContent).toBe("1");
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

  it("🔴 a month-off dashboard has no dollar amount the app could show (App Store 3.1.1), and never a plan name", () => {
    const { container } = render(
      <AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />,
    );
    expect(appVisibleText(container)).not.toMatch(/\$/);
    // On the web the one figure is the reward-style chooser's label.
    expect(screen.getByRole("button", { name: "Account credit ($10 + $5/month)" })).toBeTruthy();
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

describe("what you earn, and the bar toward the next month off", () => {
  const active = status({
    account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
  });
  const Q = AFFILIATE_POLICY.qualification.qualifyingInvoices;
  const MAX = Q + 2; // signed up, each payment, the month itself

  type Ref = AffiliateOverview["referrals"][number];
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

  function bar() {
    const el = screen.getByRole("progressbar", { name: "Progress to your next month off" });
    return {
      min: el.getAttribute("aria-valuemin"),
      now: el.getAttribute("aria-valuenow"),
      max: el.getAttribute("aria-valuemax"),
      text: el.getAttribute("aria-valuetext") ?? "",
    };
  }

  it("says what every business brings in, with the program's real numbers and never cash", () => {
    const { container } = render(
      <AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByText("For every business you bring in")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A month off your ChairBack plan" })).toBeTruthy();
    const terms = screen.getByTestId("earn-terms").textContent ?? "";
    expect(terms).toContain(`paid for ${Q} months`);
    expect(terms).toContain(`${AFFILIATE_POLICY.qualification.holdDaysAfterSecond}-day hold`);
    expect(terms).toMatch(/no cap/);
    expect(terms).toMatch(/never cash/);
    expect(appVisibleText(container)).not.toMatch(/\$/);
  });

  it("an empty bar at 0 for a referral that has not started, and for nobody at all", () => {
    expect(nextMonthProgress({ referrals: [], policy: overview().policy })).toMatchObject({
      state: "empty",
      value: 0,
      max: MAX,
    });
    // Only finished-badly rows (taken back / expired) leave nothing on the road.
    const p = nextMonthProgress({
      referrals: [ref({ stage: "reversed" }), ref({ stage: "expired" })],
      policy: overview().policy,
    });
    expect(p).toMatchObject({ state: "empty", value: 0 });
  });

  it("partial: a step per milestone, from the furthest business along", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          referrals: [
            ref({ id: "s", label: "Business ••••1111", stage: "signed_up" }),
            ref({ id: "p", label: "Business ••••2222", stage: "first_payment", qualifyingInvoices: 1 }),
          ],
          rewards: [],
          months: { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    const b = bar();
    expect(b).toMatchObject({ min: "0", now: "2", max: String(MAX) });
    expect(b.text).toBe(`Business ••••2222: 1 of ${Q} payments made`);
    expect(screen.getByTestId("next-month-caption").textContent).toBe(b.text);
    expect(screen.getByText("1 more business is on the way too.")).toBeTruthy();

    // Each in-progress stage sits on its own step.
    const at = (r: Ref) => nextMonthProgress({ referrals: [r], policy: overview().policy }).value;
    expect(at(ref({ stage: "signed_up" }))).toBe(1);
    expect(at(ref({ stage: "first_payment", qualifyingInvoices: 1 }))).toBe(2);
    expect(at(ref({ stage: "hold", qualifyingInvoices: Q }))).toBe(Q + 1);
  });

  it("the hold says how long it is", () => {
    render(<AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />);
    const b = bar();
    expect(b.now).toBe(String(Q + 1));
    expect(b.text).toContain(`Business ••••1027: paid ${Q} of ${Q}, now in the ${AFFILIATE_POLICY.qualification.holdDaysAfterSecond}-day hold, ready `);
  });

  it("complete: a month off that is ready fills the bar", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          referrals: [
            ref({ stage: "month_off", label: "Business ••••3333", qualifyingInvoices: Q, availableAt: "2026-10-01T00:00:00.000Z" }),
          ],
          rewards: [
            {
              id: "r9",
              label: "Business ••••3333",
              rewardType: "subscription_credit",
              amountCents: 3499,
              status: "AVAILABLE",
              qualifiedAt: "2026-09-10T00:00:00.000Z",
              holdEndsAt: "2026-09-24T00:00:00.000Z",
              availableAt: "2026-10-01T00:00:00.000Z",
              expiresAt: "2027-10-01T00:00:00.000Z",
              reversedAt: null,
              reversalMessage: null,
            },
          ],
          months: { earned: 0, onTheWay: 1, underReview: 0, reversed: 0, expired: 0 },
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    const b = bar();
    expect(b).toMatchObject({ now: String(MAX), max: String(MAX) });
    expect(b.text).toMatch(/Business ••••3333: your month off is ready/);
    expect(screen.getByText("month off so far").previousSibling?.textContent).toBe("1");
    expect(screen.getByText("ready to use").previousSibling?.textContent).toBe("1");
  });

  it("empty state: a brand-new affiliate sees the promise, the link and code, and a bar at 0 - never a blank page", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          referrals: [],
          rewards: [],
          months: { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByRole("heading", { name: "A month off your ChairBack plan" })).toBeTruthy();
    expect(screen.getByText(`${APP}/join?ref=abcDEF123456`)).toBeTruthy();
    expect(screen.getByText("abcDEF123456")).toBeTruthy();
    const b = bar();
    expect(b).toMatchObject({ min: "0", now: "0", max: String(MAX) });
    expect(b.text).toMatch(/^Nobody on the way yet/);
    expect(screen.getByText("months off so far").previousSibling?.textContent).toBe("0");
    expect(screen.getByText(/Nobody yet\. Businesses that sign up/)).toBeTruthy();
  });

  it("milestones and totals come from the policy and the reward ledger", () => {
    expect(milestoneLabels(2)).toEqual(["Signed up", "Payment 1", "Payment 2", "Month off"]);
    expect(milestoneLabels(Q)).toHaveLength(MAX);
    const r = (status: string) => ({ ...overview().rewards[0]!, status });
    expect(
      earningsSoFar({
        months: { earned: 1, onTheWay: 3, underReview: 1, reversed: 1, expired: 0 },
        rewards: [r("APPLIED"), r("AVAILABLE"), r("RESERVED"), r("PENDING"), r("REVIEW_REQUIRED"), r("REVERSED")],
      }),
    ).toEqual({ total: 4, used: 1, ready: 2, inHold: 1, underReview: 1 });
  });
});

describe("toolkit", () => {
  it("🔴 speaks the shop's own words - a nail tech's templates mention no chairs", () => {
    const nails = { stationNoun: "station", businessNoun: "studio", clientNounPlural: "guests" };
    for (const style of ["short_video", "posts_stories", "in_the_chair", "flyer_qr", "blog_podcast"] as const) {
      const card = toolkitFor(style, { link: "https://x.test/join?ref=a", shopName: "Polish", vocab: nails });
      expect(`${card.title} ${card.blurb} ${card.text}`).not.toMatch(/chairs?/i);
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

  it("the disclosure names the affiliate's own kind of reward, never an amount", () => {
    const link = "https://getchairback.com/join?ref=abc";
    for (const style of ["short_video", "in_the_chair", "text_dm", "other"] as const) {
      const credit = toolkitFor(style, { link, shopName: "Fade Lab", rewardStyle: "dollar_credit" });
      expect(credit.text).toMatch(/account credit on my plan/);
      expect(credit.text).not.toMatch(/month off|\$/);
      const months = toolkitFor(style, { link, shopName: "Fade Lab", rewardStyle: "month_off" });
      expect(months.text).toMatch(/a month off my plan/);
    }
    // A new affiliate's default is account credit.
    expect(toolkitFor("other", { link, shopName: "Fade Lab" }).text).toBe(
      `${link}\n${disclosureFor("dollar_credit")}`,
    );
  });
});

describe("account credit (the default reward style)", () => {
  const active = status({
    account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
  });
  const SIGNUP = AFFILIATE_POLICY.dollarCredit.signupCents;
  const MONTHLY = AFFILIATE_POLICY.dollarCredit.monthlyCents;

  function creditOverview(over: Partial<AffiliateOverview> = {}): AffiliateOverview {
    const base = overview();
    return {
      ...base,
      account: { ...base.account, rewardStyle: "dollar_credit" },
      months: { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
      credit: {
        earnedCents: SIGNUP + 2 * MONTHLY,
        inHoldCents: MONTHLY,
        readyCents: MONTHLY,
        appliedCents: SIGNUP,
        underReviewCents: 0,
        reversedCents: 0,
      },
      referrals: [
        {
          ...base.referrals[0]!,
          label: "Business ••••4410",
          stage: "applied",
          qualifyingInvoices: 3,
          rewardType: "signup_credit",
          creditCents: SIGNUP + 2 * MONTHLY,
        },
      ],
      rewards: [
        { ...base.rewards[0]!, id: "c1", label: "Business ••••4410", rewardType: "signup_credit", amountCents: SIGNUP, status: "APPLIED" },
        { ...base.rewards[0]!, id: "c2", label: "Business ••••4410", rewardType: "monthly_credit", amountCents: MONTHLY, status: "AVAILABLE" },
        { ...base.rewards[0]!, id: "c3", label: "Business ••••4410", rewardType: "monthly_credit", amountCents: MONTHLY, status: "PENDING" },
      ],
      ...over,
    };
  }

  it("sign-up: the intro and the pitch give the amounts on the web, and offer a month off instead", () => {
    render(<AffiliatesClient status={status()} overview={null} appBase={APP} shopName="Fade Lab" />);
    const intro = screen.getByTestId("affiliate-intro").textContent ?? "";
    expect(intro).toContain("$10 when it pays its first month, then $5 for every month it keeps paying");
    const pitch = screen.getByTestId("pitch-earn").textContent ?? "";
    expect(pitch).toContain("$10 in account credit is yours after a 14-day hold, then $5 more");
    expect(screen.getByText(/Prefer a month off per business\?/)).toBeTruthy();
    expect(screen.getByText(/never cash, no cash value, not transferable/)).toBeTruthy();
  });

  it("dashboard: the credit promise, the totals in dollars, and per-reward rows", () => {
    render(<AffiliatesClient status={active} overview={creditOverview()} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByRole("heading", { name: "Account credit on your ChairBack plan" })).toBeTruthy();
    const terms = screen.getByTestId("earn-terms").textContent ?? "";
    expect(terms).toContain("$10 when a business that signed up through your link pays its first month, then $5");
    expect(terms).toMatch(/14-day hold/);
    expect(terms).toMatch(/no expiry, never cash/);
    // No "next month off" bar for a credit affiliate.
    expect(screen.queryByRole("progressbar")).toBeNull();

    expect(screen.getByText("earned so far").previousSibling?.textContent).toBe("$20");
    expect(screen.getByText("applied to your bill").previousSibling?.textContent).toBe("$10");
    expect(screen.getByText("ready to use").previousSibling?.textContent).toBe("$5");
    expect(screen.getByText("waiting out the hold").previousSibling?.textContent).toBe("$5");

    expect(screen.getByText("Credit applied")).toBeTruthy();
    expect(screen.getByText(/\$20 credit earned/)).toBeTruthy();
    expect(screen.getByText("Your rewards")).toBeTruthy();
    expect(screen.getByText(/\$10 credit/, { selector: "span" })).toBeTruthy();
    expect(screen.getAllByText(/\$5 credit/, { selector: "span" })).toHaveLength(2);
    expect(screen.getByText("Comes off your next ChairBack bill")).toBeTruthy();
    expect(screen.getByText("How your credit works")).toBeTruthy();
    expect(screen.getByTestId("how-it-works").textContent).toMatch(
      /refunded or disputed before the credit is applied/,
    );
  });

  it("🔴 every dollar figure sits inside a web-only wrapper the app never shows", () => {
    const { container } = render(
      <AffiliatesClient status={active} overview={creditOverview()} appBase={APP} shopName="Fade Lab" />,
    );
    expect(container.textContent).toMatch(/\$10/); // the web does show them
    expect(appVisibleText(container)).not.toMatch(/\$/);
  });

  it("a month-off affiliate with credit from before still sees it, and months from before show under credit", () => {
    const { unmount } = render(
      <AffiliatesClient
        status={active}
        overview={creditOverview({ account: { ...overview().account, rewardStyle: "month_off" } })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByRole("heading", { name: "A month off your ChairBack plan" })).toBeTruthy();
    expect(screen.getByText("earned so far").previousSibling?.textContent).toBe("$20");
    unmount();

    render(
      <AffiliatesClient
        status={active}
        overview={creditOverview({
          months: { earned: 1, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
          rewards: [{ ...overview().rewards[0]!, status: "APPLIED" }],
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByText("Months off from before")).toBeTruthy();
    expect(screen.getByText("month off so far").previousSibling?.textContent).toBe("1");
  });
});

describe("the reward-style chooser", () => {
  const active = status({
    account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
  });
  const credit = (): AffiliateOverview => ({
    ...overview(),
    account: { ...overview().account, rewardStyle: "dollar_credit" },
  });

  it("shows both styles, marks the current one, and saves a switch forward-only", async () => {
    render(<AffiliatesClient status={active} overview={credit()} appBase={APP} shopName="Fade Lab" />);
    const dollars = screen.getByRole("button", { name: "Account credit ($10 + $5/month)" });
    const months = screen.getByRole("button", { name: "A month off per business" });
    expect(dollars.getAttribute("aria-pressed")).toBe("true");
    expect(months.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(/anything you.ve already earned keeps the reward it was earned under/)).toBeTruthy();
    // Nothing to save until it changes.
    expect(screen.queryByRole("button", { name: "Save reward style" })).toBeNull();

    fireEvent.click(months);
    expect(months.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save reward style" }));
    await waitFor(() => expect(mockRewardStyle).toHaveBeenCalledWith("month_off"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).toMatch(/rewards you earn from now on/);
  });

  it("a paused account can't switch, and a 409 says why", async () => {
    const { unmount } = render(
      <AffiliatesClient
        status={active}
        overview={{
          ...credit(),
          account: { ...credit().account, status: "SUSPENDED", suspensionMessage: "Paused." },
        }}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(
      (screen.getByRole("button", { name: "A month off per business" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    unmount();

    mockRewardStyle.mockResolvedValueOnce({ ok: false, error: "not_active", status: 409 });
    render(<AffiliatesClient status={active} overview={credit()} appBase={APP} shopName="Fade Lab" />);
    fireEvent.click(screen.getByRole("button", { name: "A month off per business" }));
    fireEvent.click(screen.getByRole("button", { name: "Save reward style" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/paused/));
    expect(refresh).not.toHaveBeenCalled();
  });
});
