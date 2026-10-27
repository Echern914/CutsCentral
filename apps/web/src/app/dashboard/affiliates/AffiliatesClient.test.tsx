import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AFFILIATE_POLICY,
  bpsToPercent,
  commissionCents,
  formatUsdCents,
} from "@chairback/config/affiliateProgram";
import { PLANS } from "@chairback/config/constants";
import {
  AffiliatesClient,
  businessCounts,
  earningsSoFar,
  milestoneLabels,
  nextBusinessProgress,
  toolkitFor,
} from "./AffiliatesClient";
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
 * The four screens, each chosen from the API's view, and the promises the
 * dashboard makes: the commission program with numbers read from the policy,
 * dollars and percentages on the WEB only (inside the iOS app - App Store
 * 3.1.1, the rule that rejected build 32 - none render), and no invented
 * earnings total.
 */

/** Render as if inside the native shell: the bridge useIsNativeApp reads. */
function inTheApp() {
  (window as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: () => {} };
}
afterEach(() => {
  delete (window as { ReactNativeWebView?: unknown }).ReactNativeWebView;
});

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
    // What the API echoes - built from the program's own config, so a policy
    // change moves these tests with it instead of hiding behind a stale copy.
    policy: {
      attributionWindowDays: AFFILIATE_POLICY.attribution.windowDays,
      qualifyingInvoices: AFFILIATE_POLICY.qualification.qualifyingInvoices,
      holdDays: AFFILIATE_POLICY.qualification.holdDaysAfterSecond,
      expiryMonths: AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable,
    },
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

  it("leads with the commission, shows the link, one toolkit card per style, masked referrals, and earlier month-off credits", () => {
    render(<AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByRole("heading", { name: "Get paid for every business you bring in" })).toBeTruthy();
    // Month-off credits earned under the earlier program are honoured, so still shown:
    // 2 applied + 1 in the hold (the fixture's one PENDING reward).
    const credits = screen.getByTestId("month-off-credits");
    expect(credits.textContent).toMatch(/Your month-off credits/);
    expect(credits.textContent).toMatch(/earlier program, and kept/);
    expect(screen.getByText("months off so far").previousSibling?.textContent).toBe("3");
    expect(screen.getByText("used on your bill").previousSibling?.textContent).toBe("2");
    expect(screen.getByText("ready to use").previousSibling?.textContent).toBe("0");
    expect(screen.getByText("waiting out the hold").previousSibling?.textContent).toBe("1");
    expect(screen.getByText(`${APP}/join?ref=abcDEF123456`)).toBeTruthy();
    expect(screen.getAllByTestId("toolkit-card")).toHaveLength(2);
    expect(screen.getByText("Short video")).toBeTruthy();
    expect(screen.getByText("In the workspace")).toBeTruthy();
    expect(screen.getByText("Business ••••1027")).toBeTruthy();
    // A v1 reward's badge says what it is: a month off, not a commission.
    expect(screen.getByText("Month off in the hold")).toBeTruthy();
    expect(screen.getByText("In the hold")).toBeTruthy(); // the reward row
    expect(screen.getByText("Taken back")).toBeTruthy();
    expect(screen.getByText(/Opened 3 times this week/)).toBeTruthy();
  });

  it("🔴 inside the iOS app: no dollar amount, no percentage, no plan price - and a pointer to the web", async () => {
    inTheApp();
    const { container } = render(
      <AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("earn-example").textContent).toMatch(/getchairback\.com in your web browser/),
    );
    expect(container.textContent).not.toMatch(/\$\s?\d/);
    expect(container.textContent).not.toMatch(/\d\s?%/);
    expect(container.textContent).not.toMatch(/\bpro_ai\b|\bPro AI\b|\$34|\$74/);
    // The promise itself still reads, without numbers.
    expect(screen.getByTestId("earn-terms").textContent).toMatch(/a share of what they pay for their plan/);
    expect(container.textContent).not.toMatch(/never cash/i);
  });

  it("inside the iOS app the sign-up pitch carries no money either", async () => {
    inTheApp();
    const { container } = render(
      <AffiliatesClient status={status()} overview={null} appBase={APP} shopName="Fade Lab" />,
    );
    await waitFor(() => expect(container.textContent).toMatch(/a share of what they pay/));
    expect(container.textContent).not.toMatch(/\$\s?\d|\d\s?%/);
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

describe("what you earn, and the bar toward your next business", () => {
  const active = status({
    account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
  });
  const Q = AFFILIATE_POLICY.qualification.qualifyingInvoices;
  const C = AFFILIATE_POLICY.commission;
  const MAX = Q + 1; // signed up, then each qualifying payment

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
      ...over,
    };
  }

  function bar() {
    const el = screen.getByRole("progressbar", { name: "Progress of your next business" });
    return {
      min: el.getAttribute("aria-valuemin"),
      now: el.getAttribute("aria-valuenow"),
      max: el.getAttribute("aria-valuemax"),
      text: el.getAttribute("aria-valuetext") ?? "",
    };
  }

  const empty = {
    referrals: [],
    rewards: [],
    months: { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
  };

  it("on the web: the commission rates, window and hold, all from AFFILIATE_POLICY.commission - and never 'never cash'", () => {
    const { container } = render(
      <AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />,
    );
    const terms = screen.getByTestId("earn-terms").textContent ?? "";
    expect(terms).toContain(`${bpsToPercent(C.cashBps)}% of what they pay for their plan`);
    expect(terms).toContain(`${bpsToPercent(C.creditBps)}% as ChairBack credit`);
    expect(terms).toContain("for their first year");
    expect(terms).toContain(`held ${C.holdDays} days`);
    expect(terms).toMatch(/2nd payment/);
    expect(terms).toMatch(/No cap/);
    expect(container.textContent).not.toMatch(/never cash/i);
    expect(container.textContent).not.toMatch(/month off your (ChairBack )?plan/i);
    expect(screen.getByTestId("earn-choice").textContent).toMatch(/Credit is the default/);
  });

  it("🔴 the worked example is commissionCents on the real Premium price, not typed numbers", () => {
    render(<AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />);
    const planCents = Math.round(PLANS.pro.priceMonthlyUsd * 100);
    const cash = commissionCents(planCents, "cash");
    const credit = commissionCents(planCents, "credit");
    const text = (screen.getByTestId("earn-example").textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain(`a business on ${PLANS.pro.name} at ${formatUsdCents(planCents)} a month`);
    expect(text).toContain(`earns you ${formatUsdCents(cash)} a month in cash or ${formatUsdCents(credit)} in credit`);
    expect(text).toContain(
      `up to ${formatUsdCents(cash * C.months)} or ${formatUsdCents(credit * C.months)} over its first year`,
    );
    // The payout minimum, also from the policy, on the web only.
    expect(screen.getByTestId("how-it-works").textContent).toContain(
      `${formatUsdCents(C.minimumCashPayoutCents)} or more`,
    );
  });

  it("🔴 nothing is typed by hand: a different rate in the policy moves every number on the tab", () => {
    // The policy object is plain at runtime; bend it for this one render.
    const policy = AFFILIATE_POLICY.commission as { cashBps: number; creditBps: number; minimumCashPayoutCents: number };
    const saved = { ...policy };
    try {
      policy.cashBps = 2500;
      policy.creditBps = 3700;
      policy.minimumCashPayoutCents = 4000;
      const { container } = render(
        <AffiliatesClient status={active} overview={overview()} appBase={APP} shopName="Fade Lab" />,
      );
      const text = (container.textContent ?? "").replace(/\s+/g, " ");
      const planCents = Math.round(PLANS.pro.priceMonthlyUsd * 100);
      expect(text).toContain("25% of what they pay");
      expect(text).toContain("37% as ChairBack credit");
      expect(text).toContain(`earns you ${formatUsdCents(Math.floor((planCents * 2500) / 10_000))} a month in cash`);
      expect(text).toContain(`${formatUsdCents(Math.floor((planCents * 3700) / 10_000))} in credit`);
      expect(text).toContain("$40 or more");
      expect(text).not.toMatch(/\b20%|\b30%|\$25\b/);
    } finally {
      Object.assign(policy, saved);
    }
  });

  it("shows no invented earnings total - counts of businesses and a plain note instead", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          ...empty,
          referrals: [
            ref({ id: "a", stage: "signed_up" }),
            ref({ id: "b", stage: "first_payment", qualifyingInvoices: 1 }),
            ref({ id: "c", stage: "second_payment", qualifyingInvoices: Q }),
            ref({ id: "d", stage: "reversed", qualifyingInvoices: Q }),
          ],
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByText("signed up through your link").previousSibling?.textContent).toBe("4");
    expect(screen.getByText("paying").previousSibling?.textContent).toBe("2");
    expect(screen.getByText(`made ${Q} payments`).previousSibling?.textContent).toBe("1");
    expect(screen.getByTestId("earnings-note").textContent).toMatch(/aren.t shown on this page yet/);
    // No earlier-program history = no month-off card at all.
    expect(screen.queryByTestId("month-off-credits")).toBeNull();
  });

  it("an empty bar at 0 for a referral that has not started, and for nobody at all", () => {
    expect(nextBusinessProgress({ referrals: [], policy: overview().policy })).toMatchObject({
      state: "empty",
      value: 0,
      max: MAX,
    });
    // Only finished-badly rows (taken back / expired) leave nothing on the road.
    const p = nextBusinessProgress({
      referrals: [ref({ stage: "reversed" }), ref({ stage: "expired" })],
      policy: overview().policy,
    });
    expect(p).toMatchObject({ state: "empty", value: 0 });
    expect(p.text).toMatch(/bring in your next business/);
  });

  it("partial: a step per milestone, from the furthest business along", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          ...empty,
          referrals: [
            ref({ id: "s", label: "Business ••••1111", stage: "signed_up" }),
            ref({ id: "p", label: "Business ••••2222", stage: "first_payment", qualifyingInvoices: 1 }),
          ],
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    const b = bar();
    expect(b).toMatchObject({ min: "0", now: "2", max: String(MAX) });
    expect(b.text).toBe(`Business ••••2222: 1 of ${Q} payments made`);
    expect(screen.getByTestId("next-business-caption").textContent).toBe(b.text);
    expect(screen.getByText("1 more business is on the way too.")).toBeTruthy();

    const at = (r: Ref) => nextBusinessProgress({ referrals: [r], policy: overview().policy }).value;
    expect(at(ref({ stage: "signed_up" }))).toBe(1);
    expect(at(ref({ stage: "first_payment", qualifyingInvoices: 1 }))).toBe(2);
  });

  it("full: a business past its qualifying payments says its commissions are payable as each hold ends", () => {
    render(
      <AffiliatesClient
        status={active}
        overview={overview({
          ...empty,
          referrals: [ref({ stage: "second_payment", label: "Business ••••3333", qualifyingInvoices: Q })],
        })}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    const b = bar();
    expect(b).toMatchObject({ now: String(MAX), max: String(MAX) });
    expect(b.text).toBe(
      `Business ••••3333: ${Q} of ${Q} payments made, so each commission is payable once its ${C.holdDays}-day hold ends`,
    );
  });

  it("a business that earned a month off under the earlier program is not on the commission bar", () => {
    const p = nextBusinessProgress({
      referrals: [ref({ stage: "month_off", qualifyingInvoices: Q }), ref({ stage: "hold", qualifyingInvoices: Q })],
      policy: overview().policy,
    });
    expect(p.state).toBe("empty");
    expect(p.text).not.toMatch(/month off/i);
  });

  it("empty state: a brand-new affiliate sees the promise, the link and code, and a bar at 0 - never a blank page", () => {
    render(<AffiliatesClient status={active} overview={overview(empty)} appBase={APP} shopName="Fade Lab" />);
    expect(screen.getByRole("heading", { name: "Get paid for every business you bring in" })).toBeTruthy();
    expect(screen.getByText(`${APP}/join?ref=abcDEF123456`)).toBeTruthy();
    expect(screen.getByText("abcDEF123456")).toBeTruthy();
    const b = bar();
    expect(b).toMatchObject({ min: "0", now: "0", max: String(MAX) });
    expect(b.text).toMatch(/^Nobody on the way yet/);
    expect(screen.getByText("signed up through your link").previousSibling?.textContent).toBe("0");
    expect(screen.getByText(/Nobody yet\. Businesses that sign up/)).toBeTruthy();
  });

  it("milestones, counts and earlier-program totals come from the policy and the ledgers", () => {
    expect(milestoneLabels(2)).toEqual(["Signed up", "Payment 1", "Payment 2"]);
    expect(milestoneLabels(Q)).toHaveLength(MAX);
    expect(
      businessCounts({
        referrals: [
          ref({ qualifyingInvoices: 0 }),
          ref({ stage: "first_payment", qualifyingInvoices: 1 }),
          ref({ stage: "second_payment", qualifyingInvoices: Q }),
          ref({ stage: "expired", qualifyingInvoices: Q }),
        ],
        policy: overview().policy,
      }),
    ).toEqual({ signedUp: 4, paying: 2, qualified: 1 });
    const r = (status: string) => ({ ...overview().rewards[0]!, status });
    expect(
      earningsSoFar({
        months: { earned: 1, onTheWay: 3, underReview: 1, reversed: 1, expired: 0 },
        rewards: [r("APPLIED"), r("AVAILABLE"), r("RESERVED"), r("PENDING"), r("REVIEW_REQUIRED"), r("REVERSED")],
      }),
    ).toEqual({ total: 4, used: 1, ready: 2, inHold: 1, underReview: 1 });
  });

  it("the sign-up screen pitches the commission with the policy's numbers, and never 'never cash'", () => {
    const { container } = render(
      <AffiliatesClient status={status()} overview={null} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByTestId("affiliates-tagline").textContent).toMatch(/^Get paid for every business/);
    const text = container.textContent ?? "";
    expect(text).toContain(`${bpsToPercent(C.cashBps)}% of what they pay`);
    expect(text).toContain(`${bpsToPercent(C.creditBps)}% as ChairBack credit`);
    expect(screen.getByTestId("pitch-rules").textContent).toContain(
      `${formatUsdCents(C.minimumCashPayoutCents)} or more`,
    );
    expect(text).not.toMatch(/never cash/i);
    expect(text).not.toMatch(/month off/i);
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
});
