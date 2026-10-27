"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
// 🔴 SUBPATH IMPORT, NOT THE BARREL: the barrel re-exports crypto.ts, which
// drags node:crypto into the browser bundle and kills `next build`.
import {
  AFFILIATE_POLICY,
  AFFILIATE_PROMOTION_CHANNELS,
  AFFILIATE_PROMOTION_STYLES,
  AFFILIATE_PROMOTION_STYLE_LABELS,
  bpsToPercent,
  commissionExample,
  commissionPeriodPhrase,
  formatUsdCents,
  ordinal,
  type AffiliatePromotionStyle,
} from "@chairback/config/affiliateProgram";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
import { Card } from "@/components/ui/Card";
import { cap, useVocab } from "@/components/VocabProvider";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  applyAffiliateAction,
  getAffiliateQrAction,
  setAffiliateStylesAction,
} from "./actions";
import type { AffiliateOverview, AffiliateStatus, ReferralStage } from "./page";

/**
 * The Affiliates tab: sign up -> waiting -> choose styles -> dashboard.
 *
 * THE COMMISSION PROGRAM (terms v2): a share of what each referred business
 * pays for its plan, every month for its first year, as cash or as bill
 * credit. Every number is read from AFFILIATE_POLICY.commission (and the worked
 * example from PLANS via commissionExample) - none is typed here.
 *
 * DOLLARS AND PERCENTAGES ON THE WEB ONLY. Inside the iOS app they sit in
 * HideInNativeApp and ShowInNativeApp says the same thing without them plus
 * "see getchairback.com" - the pattern the billing page uses, and what keeps
 * the WebView clean of the pricing UI App Store Guideline 3.1.1 rejected a
 * build over. Tests render both and assert the app view has no $ or %.
 *
 * NO EARNINGS NUMBERS YET. Commission lines are recorded server-side but no
 * endpoint returns them, so this tab shows the program, a worked example and
 * counts of businesses - never an invented total. Month-off credits earned
 * under the earlier (v1) program are still shown, because they are honoured.
 *
 * WHO THEY BROUGHT ON is masked by the API ("Business ••••1027"); this file
 * never sees a referred business's name and has nothing to leak.
 */

type Screen = "signup" | "waiting" | "rejected" | "styles" | "dashboard" | "unavailable";

const REAPPLY_REASONS = new Set(["incomplete_application", "not_eligible"]);

function screenFor(status: AffiliateStatus, overview: AffiliateOverview | null): Screen {
  if (!status.account) {
    if (status.application?.status === "PENDING") return "waiting";
    if (status.application?.status === "REJECTED") return "rejected";
    return "signup";
  }
  if (!overview) return "unavailable";
  if (overview.account.status === "ACTIVE" && overview.account.promotionStyles.length === 0) {
    return "styles";
  }
  return "dashboard";
}

const CHANNEL_LABELS: Record<(typeof AFFILIATE_PROMOTION_CHANNELS)[number], string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
  blog: "Blog",
  podcast: "Podcast",
  email_list: "Email list",
  in_person: "In person",
  other: "Other",
};

const COMMISSION = AFFILIATE_POLICY.commission;
const QUALIFYING = AFFILIATE_POLICY.qualification.qualifyingInvoices;
const PERIOD = commissionPeriodPhrase(COMMISSION.months);

/**
 * The stage badge. The first three are the commission road; `hold` through
 * `applied` exist only for a business that earned a month off under the
 * earlier (v1) program, so they say "month off" - that credit is real.
 */
const STAGE_COPY: Record<ReferralStage, string> = {
  signed_up: "Signed up",
  first_payment: `1 of ${QUALIFYING} payments`,
  second_payment: `${QUALIFYING} of ${QUALIFYING} payments`,
  hold: "Month off in the hold",
  month_off: "Month off ready",
  applied: "Month off applied",
  reversed: "Taken back",
  expired: "Expired",
  under_review: "Under review",
};

/** Index on the commission road; null = a badge on its own instead. */
const STAGE_STEP: Record<ReferralStage, number | null> = {
  signed_up: 0,
  first_payment: 1,
  second_payment: QUALIFYING,
  hold: null,
  month_off: null,
  applied: null,
  reversed: null,
  expired: null,
  under_review: null,
};

const STEPS = ["Signed up", ...Array.from({ length: QUALIFYING }, (_, i) => `${ordinal(i + 1)} payment`)];

const REWARD_STATUS_COPY: Record<string, string> = {
  PENDING: "In the hold",
  AVAILABLE: "Ready",
  RESERVED: "Being applied",
  APPLIED: "Applied",
  REVERSED: "Taken back",
  EXPIRED: "Expired",
  REVIEW_REQUIRED: "Under review",
};

const DISCLOSURE =
  "I'm a ChairBack affiliate and earn a commission when a business signs up through my link.";

/**
 * What you earn, in one clause that follows "You earn". Web: the real rates.
 * App: the same promise with no percentage (3.1.1). Pre-hydration the web copy
 * renders inside data-native-hide, which the app shell hides from first paint.
 */
function RateClause() {
  return (
    <>
      <HideInNativeApp>
        {bpsToPercent(COMMISSION.cashBps)}% of what they pay for their plan every month for
        their {PERIOD}, as cash, or {bpsToPercent(COMMISSION.creditBps)}% as ChairBack credit.
      </HideInNativeApp>
      <ShowInNativeApp>
        a share of what they pay for their plan every month for their {PERIOD}, as cash or as
        ChairBack credit.
      </ShowInNativeApp>
    </>
  );
}

/** The held-and-qualified rule, which carries no money and reads the same everywhere. */
const PAYABLE_RULE = `Each commission is held ${COMMISSION.holdDays} days, and nothing is paid out until the business has made its ${ordinal(QUALIFYING)} payment.`;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const INPUT =
  "w-full rounded-xl border border-subtle bg-charcoal-800 px-3 py-2.5 text-base text-offwhite placeholder:text-muted focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold";

const PRIMARY =
  "rounded-full bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
  "rounded-full border border-subtle px-4 py-2 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite";

function chip(selected: boolean): string {
  return cn(
    "rounded-full border px-3.5 py-2 text-sm transition-colors duration-150 ease-out",
    selected
      ? "border-gold bg-gold/15 text-offwhite"
      : "border-subtle text-muted hover:bg-charcoal-700 hover:text-offwhite",
  );
}

export function AffiliatesClient({
  status,
  overview,
  appBase,
  shopName,
}: {
  status: AffiliateStatus;
  overview: AffiliateOverview | null;
  /** APP_BASE_URL; empty when unset (the browser's origin fills in). */
  appBase: string;
  shopName: string;
}) {
  const base = screenFor(status, overview);
  // Local overrides: "apply again" after a rejection, "change my styles" from
  // the dashboard. Everything else comes from the API's view.
  const [reapply, setReapply] = useState(false);
  const [editingStyles, setEditingStyles] = useState(false);
  const screen: Screen =
    base === "rejected" && reapply ? "signup" : base === "dashboard" && editingStyles ? "styles" : base;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <Link
        href="/dashboard"
        className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
      >
        ← Dashboard
      </Link>
      <h1 className="mb-1 mt-1 font-display text-3xl tracking-tight">Affiliates</h1>
      {/* The dashboard leads with its own "what you earn" card; every other
          screen keeps the one-line version of the same promise. */}
      {screen === "dashboard" ? (
        <div className="mb-6" />
      ) : (
        <p className="mb-6 text-sm text-muted" data-testid="affiliates-tagline">
          Get paid for every business you bring onto ChairBack. You earn <RateClause /> No cap.
        </p>
      )}

      {screen === "signup" && <SignUp status={status} />}
      {screen === "waiting" && <Waiting status={status} />}
      {screen === "rejected" && <Rejected status={status} onReapply={() => setReapply(true)} />}
      {screen === "styles" && overview && (
        <ChooseStyles
          initial={overview.account.promotionStyles as AffiliatePromotionStyle[]}
          canCancel={editingStyles}
          onDone={() => setEditingStyles(false)}
        />
      )}
      {screen === "dashboard" && overview && (
        <Dashboard
          overview={overview}
          appBase={appBase}
          shopName={shopName}
          onChangeStyles={() => setEditingStyles(true)}
        />
      )}
      {screen === "unavailable" && (
        <Card className="px-5 py-6 text-sm text-muted">
          Couldn&rsquo;t load your affiliate dashboard right now. Try again in a moment.
        </Card>
      )}
    </main>
  );
}

//  Screen 1: sign up

function Pitch() {
  const p = AFFILIATE_POLICY;
  return (
    <Card className="px-5 py-5">
      <h2 className="font-display text-lg">How it works</h2>
      <ol className="mt-3 space-y-2 text-sm text-offwhite">
        <li>
          <span className="mr-2 text-gold">1</span>Share your link with a business that
          should be on ChairBack.
        </li>
        <li>
          <span className="mr-2 text-gold">2</span>They sign up through it and start
          paying for ChairBack.
        </li>
        <li>
          <span className="mr-2 text-gold">3</span>You earn <RateClause />
        </li>
      </ol>
      <p className="mt-4 text-xs leading-relaxed text-muted" data-testid="pitch-rules">
        {PAYABLE_RULE} Credit is the default.{" "}
        <HideInNativeApp>
          Cash is paid through Stripe once you have{" "}
          {formatUsdCents(p.commission.minimumCashPayoutCents)} or more; less rolls over.{" "}
        </HideInNativeApp>
        No cap on businesses. Your link counts for {p.attribution.windowDays} days after
        someone opens it. Full rules:{" "}
        <Link href="/affiliate-terms" className="underline">
          affiliate terms
        </Link>
        .
      </p>
    </Card>
  );
}

function SignUp({ status }: { status: AffiliateStatus }) {
  const vocab = useVocab();
  const router = useRouter();
  const [channels, setChannels] = useState<string[]>([]);
  const [audience, setAudience] = useState("");
  const [links, setLinks] = useState("");
  const [plan, setPlan] = useState("");
  const [ftc, setFtc] = useState(false);
  const [terms, setTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkList = links
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const ready =
    channels.length > 0 &&
    audience.trim().length > 0 &&
    plan.trim().length > 0 &&
    linkList.length <= 5 &&
    ftc &&
    terms;

  async function submit() {
    setError(null);
    setPending(true);
    const res = await applyAffiliateAction({
      promotionChannels: channels,
      audienceDescription: audience.trim(),
      links: linkList,
      promotionPlan: plan.trim(),
    });
    setPending(false);
    if (res.ok) {
      router.refresh();
      return;
    }
    if (res.status === 409) {
      // Already pending or already an affiliate: the server view is right.
      router.refresh();
      return;
    }
    setError(
      res.status === 404
        ? "Sign-ups are closed right now."
        : res.error === "terms_not_accepted"
          ? "The terms changed since this page loaded. Reload and try again."
          : "Check the form: every link must start with http, and each field is required.",
    );
  }

  return (
    <>
      <Pitch />
      {!status.applicationsOpen ? (
        <Card className="mt-6 px-5 py-6 text-center">
          <h2 className="font-display text-lg">Sign-ups are closed right now</h2>
          <p className="mt-2 text-sm text-muted">Check back soon.</p>
        </Card>
      ) : (
        <Card className="mt-6 px-5 py-5">
          <h2 className="font-display text-lg">Sign up</h2>
          <p className="mt-1 text-sm text-muted">
            A person reads every sign-up. Tell us enough to say yes.
          </p>

          <p className="mt-4 text-xs uppercase tracking-wide text-muted">
            Where will you mostly share?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {AFFILIATE_PROMOTION_CHANNELS.map((c) => {
              const on = channels.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  className={chip(on)}
                  onClick={() =>
                    setChannels(on ? channels.filter((x) => x !== c) : [...channels, c])
                  }
                >
                  {CHANNEL_LABELS[c]}
                </button>
              );
            })}
          </div>

          <label className="mt-4 block text-xs uppercase tracking-wide text-muted">
            Who do you reach?
            <textarea
              className={cn(INPUT, "mt-2 min-h-20")}
              maxLength={1000}
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder={`${cap(vocab.clientNounPlural)} at the ${vocab.stationNoun}, a local following, other owners I know…`}
            />
          </label>

          <label className="mt-4 block text-xs uppercase tracking-wide text-muted">
            Links to where you&rsquo;d post (optional, one per line, up to 5)
            <textarea
              className={cn(INPUT, "mt-2 min-h-16 font-mono text-sm")}
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              placeholder="https://instagram.com/…"
            />
          </label>

          <label className="mt-4 block text-xs uppercase tracking-wide text-muted">
            How will you get the word out?
            <textarea
              className={cn(INPUT, "mt-2 min-h-20")}
              maxLength={2000}
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              placeholder="A story when someone new books in, and the link in my bio."
            />
          </label>

          <label className="mt-5 flex items-start gap-3 text-sm text-offwhite">
            <input
              type="checkbox"
              className="mt-1"
              checked={ftc}
              onChange={(e) => setFtc(e.target.checked)}
            />
            <span>
              I&rsquo;ll say I&rsquo;m an affiliate wherever I share the link. (It&rsquo;s the law,
              and every template we give you already says it.)
            </span>
          </label>
          <label className="mt-3 flex items-start gap-3 text-sm text-offwhite">
            <input
              type="checkbox"
              className="mt-1"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
            />
            <span>
              I accept the{" "}
              <Link href="/affiliate-terms" className="underline" target="_blank">
                affiliate terms
              </Link>{" "}
              (version {status.termsVersion}).
            </span>
          </label>

          {error && (
            <p role="alert" className="mt-4 text-xs text-danger-soft">
              {error}
            </p>
          )}
          <div className="mt-5">
            <button type="button" className={PRIMARY} disabled={!ready || pending} onClick={submit}>
              {pending ? "Sending…" : "Send my sign-up"}
            </button>
          </div>
        </Card>
      )}
    </>
  );
}

//  Screen 2: waiting / rejected

function Waiting({ status }: { status: AffiliateStatus }) {
  return (
    <Card className="px-5 py-6 text-center">
      <h2 className="font-display text-lg">We&rsquo;re reviewing your sign-up</h2>
      <p className="mt-2 text-sm text-muted">
        Sent {fmtDate(status.application?.submittedAt ?? null)}. Usually a day or two.
        You&rsquo;ll get an email either way.
      </p>
    </Card>
  );
}

function Rejected({ status, onReapply }: { status: AffiliateStatus; onReapply: () => void }) {
  const canReapply = REAPPLY_REASONS.has(status.application?.decisionReason ?? "");
  return (
    <Card className="px-5 py-6 text-center">
      <h2 className="font-display text-lg">Not this time</h2>
      <p className="mt-2 text-sm text-muted">{status.application?.publicMessage}</p>
      {canReapply && (
        <button type="button" className={cn(PRIMARY, "mt-5")} onClick={onReapply}>
          Apply again
        </button>
      )}
    </Card>
  );
}

//  Screen 3: choose styles

function ChooseStyles({
  initial,
  canCancel,
  onDone,
}: {
  initial: AffiliatePromotionStyle[];
  canCancel: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<AffiliatePromotionStyle[]>(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setPending(true);
    const res = await setAffiliateStylesAction(chosen);
    setPending(false);
    if (!res.ok) {
      setError("Couldn't save that. Try again.");
      return;
    }
    onDone();
    router.refresh();
  }

  return (
    <Card className="px-5 py-5">
      <h2 className="font-display text-lg">
        {initial.length === 0 ? "You're in. How will you get the word out?" : "Change how you promote"}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Pick everything that fits. Each one unlocks ready-made copy on your dashboard.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {AFFILIATE_PROMOTION_STYLES.map((s) => {
          const on = chosen.includes(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              className={chip(on)}
              onClick={() => setChosen(on ? chosen.filter((x) => x !== s) : [...chosen, s])}
            >
              {AFFILIATE_PROMOTION_STYLE_LABELS[s]}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="mt-4 text-xs text-danger-soft">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        <button type="button" className={PRIMARY} disabled={chosen.length === 0 || pending} onClick={save}>
          {pending ? "Saving…" : initial.length === 0 ? "Open my dashboard" : "Save"}
        </button>
        {canCancel && (
          <button type="button" className={SECONDARY} onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </Card>
  );
}

//  Screen 4: the dashboard

function Stat({ value, label, muted = false }: { value: number; label: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <p className={cn("font-display text-4xl tabular-nums", muted ? "text-muted" : "text-offwhite")}>
        {value}
      </p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

/**
 * The milestones on the road to a business whose commissions can be paid out,
 * from the program's own policy (the API echoes the invoice count in
 * `overview.policy`): signed up, then each qualifying payment. After the last
 * one, each commission is payable as its own hold ends.
 */
export function milestoneLabels(qualifyingInvoices: number): string[] {
  return [
    "Signed up",
    ...Array.from({ length: qualifyingInvoices }, (_, i) => `Payment ${i + 1}`),
  ];
}

type Referral = AffiliateOverview["referrals"][number];

/** Still on the way to its qualifying payments. */
const IN_PROGRESS: ReadonlySet<ReferralStage> = new Set(["signed_up", "first_payment"]);

/** How many milestones one referral has reached, out of `q + 1`. */
function milestonesReached(r: Referral, q: number): number {
  switch (r.stage) {
    case "signed_up":
      return 1;
    case "first_payment":
    case "second_payment":
      return 1 + Math.min(Math.max(r.qualifyingInvoices, 1), q);
    default:
      return 0;
  }
}

export interface NextBusinessProgress {
  state: "empty" | "in_progress" | "payable";
  value: number;
  max: number;
  /** One sentence: the visible caption AND the bar's aria-valuetext. */
  text: string;
  /** Businesses still on the road besides the one the bar shows. */
  othersOnTheWay: number;
}

/**
 * The bar toward the affiliate's NEXT business whose commissions can be paid:
 * the business furthest along the road (ties go to the one that signed up
 * first). Nothing on the road but businesses past their qualifying payments =
 * a full bar. Nothing at all = an empty bar with a nudge. Reads only what the
 * overview returns, and says nothing about amounts - there is no endpoint for
 * them yet.
 */
export function nextBusinessProgress(
  overview: Pick<AffiliateOverview, "referrals" | "policy">,
): NextBusinessProgress {
  const q = overview.policy.qualifyingInvoices;
  const max = q + 1;
  const onTheRoad = overview.referrals
    .filter((r) => IN_PROGRESS.has(r.stage))
    .sort(
      (a, b) =>
        milestonesReached(b, q) - milestonesReached(a, q) ||
        a.signedUpAt.localeCompare(b.signedUpAt),
    );

  const lead = onTheRoad[0];
  if (lead) {
    const paid = Math.min(lead.qualifyingInvoices, q);
    const where =
      lead.stage === "signed_up"
        ? "signed up, waiting on their first payment"
        : `${paid} of ${q} payments made`;
    return {
      state: "in_progress",
      value: milestonesReached(lead, q),
      max,
      text: `${lead.label}: ${where}`,
      othersOnTheWay: onTheRoad.length - 1,
    };
  }

  const payable = overview.referrals.filter((r) => r.stage === "second_payment");
  if (payable.length > 0) {
    const hold = `${COMMISSION.holdDays}-day hold`;
    return {
      state: "payable",
      value: max,
      max,
      text:
        payable.length === 1
          ? `${payable[0]!.label}: ${q} of ${q} payments made, so each commission is payable once its ${hold} ends`
          : `${payable.length} businesses have made ${q} payments, so each commission is payable once its ${hold} ends`,
      othersOnTheWay: 0,
    };
  }

  return {
    state: "empty",
    value: 0,
    max,
    text:
      overview.referrals.length === 0
        ? "Nobody on the way yet. Share your link: the first business that signs up starts this bar."
        : "Nobody on the way right now. Share your link to bring in your next business.",
    othersOnTheWay: 0,
  };
}

export interface BusinessCounts {
  /** Every business attributed to this affiliate. */
  signedUp: number;
  /** Paid at least once and not taken back or expired. */
  paying: number;
  /** Made every qualifying payment, not taken back or expired. */
  qualified: number;
}

/** Counts from the referral list - the only honest numbers the tab has today. */
export function businessCounts(
  overview: Pick<AffiliateOverview, "referrals" | "policy">,
): BusinessCounts {
  const q = overview.policy.qualifyingInvoices;
  const live = overview.referrals.filter((r) => r.stage !== "reversed" && r.stage !== "expired");
  return {
    signedUp: overview.referrals.length,
    paying: live.filter((r) => r.qualifyingInvoices >= 1).length,
    qualified: live.filter((r) => r.qualifyingInvoices >= q).length,
  };
}

export interface EarningsSoFar {
  /** Every month that is yours or about to be: used + ready + inHold. */
  total: number;
  /** Already taken off a ChairBack bill. */
  used: number;
  /** Ready, or being put on a bill right now. */
  ready: number;
  /** Qualified, waiting out the hold. */
  inHold: number;
  underReview: number;
}

/** Month-off credits from the earlier (v1) program, from the reward ledger the
 *  overview returns (one reward = one month). Honoured, so still shown. */
export function earningsSoFar(
  overview: Pick<AffiliateOverview, "months" | "rewards">,
): EarningsSoFar {
  const count = (...statuses: string[]) =>
    overview.rewards.filter((r) => statuses.includes(r.status)).length;
  const used = overview.months.earned;
  const ready = count("AVAILABLE", "RESERVED");
  const inHold = count("PENDING");
  return { total: used + ready + inHold, used, ready, inHold, underReview: overview.months.underReview };
}

function NextBusinessBar({ progress, q }: { progress: NextBusinessProgress; q: number }) {
  const pct = progress.max > 0 ? Math.round((progress.value / progress.max) * 100) : 0;
  const labels = milestoneLabels(q);
  return (
    <div className="min-w-0">
      <div
        role="progressbar"
        aria-label="Progress of your next business"
        aria-valuemin={0}
        aria-valuemax={progress.max}
        aria-valuenow={progress.value}
        aria-valuetext={progress.text}
        className="h-3 w-full overflow-hidden rounded-full bg-offwhite/10"
      >
        <div
          className="h-full rounded-full bg-gold transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <ol
        aria-hidden="true"
        className="mt-1.5 grid gap-1 text-[10px] text-muted"
        style={{ gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}
      >
        {labels.map((label, i) => (
          <li
            key={label}
            className={cn(
              "min-w-0 truncate",
              i === 0 ? "text-left" : i === labels.length - 1 ? "text-right" : "text-center",
              i < progress.value && "text-offwhite",
            )}
          >
            {label}
          </li>
        ))}
      </ol>
      <p className="mt-2 min-w-0 break-words text-sm text-offwhite" data-testid="next-business-caption">
        {progress.text}
      </p>
      {progress.othersOnTheWay > 0 && (
        <p className="mt-0.5 text-xs text-muted">
          {progress.othersOnTheWay === 1
            ? "1 more business is on the way too."
            : `${progress.othersOnTheWay} more businesses are on the way too.`}
        </p>
      )}
    </div>
  );
}

function Dashboard({
  overview,
  appBase,
  shopName,
  onChangeStyles,
}: {
  overview: AffiliateOverview;
  appBase: string;
  shopName: string;
  onChangeStyles: () => void;
}) {
  const { toast } = useToast();
  const [origin, setOrigin] = useState(appBase);
  useEffect(() => {
    if (!appBase) setOrigin(window.location.origin);
  }, [appBase]);
  const link = `${origin}/join?ref=${encodeURIComponent(overview.account.code)}`;

  const [qr, setQr] = useState<{ svg: string; png: string } | null>(null);
  const [qrPending, setQrPending] = useState(false);

  function copy(text: string, what: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast(`${what} copied`, "success"))
      .catch(() => toast(`Couldn't copy ${what.toLowerCase()}`, "error"));
  }

  async function share(text: string) {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch (err) {
        // A closed share sheet is changing their mind, not a failure: it used
        // to fall through and toast "copied". Only a real failure copies.
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    copy(text, "Message");
  }

  async function showQr() {
    if (qr) {
      setQr(null);
      return;
    }
    setQrPending(true);
    const res = await getAffiliateQrAction(link);
    setQrPending(false);
    if (res.ok) setQr({ svg: res.qr.svg, png: res.qr.png });
    else toast("Couldn't build the QR code", "error");
  }

  const m = overview.months;
  const q = overview.policy.qualifyingInvoices;
  const progress = nextBusinessProgress(overview);
  const counts = businessCounts(overview);
  const earned = earningsSoFar(overview);
  const hasMonthOffHistory =
    overview.rewards.length > 0 ||
    earned.total + earned.underReview + m.reversed + m.expired > 0;
  const example = commissionExample();
  const styles = overview.account.promotionStyles as AffiliatePromotionStyle[];
  const vocab = useVocab();
  const toolkit = useMemo(
    () => styles.map((s) => toolkitFor(s, { link, shopName, vocab })),
    [styles, link, shopName, vocab],
  );

  return (
    <>
      {overview.account.suspensionMessage && (
        <div
          role="status"
          className="mb-6 rounded-xl border border-warning-soft/40 bg-warning-soft/10 px-4 py-3 text-sm text-warning-soft"
        >
          {overview.account.suspensionMessage}
        </div>
      )}

      <Card className="px-5 py-5">
        <p className="text-[10px] uppercase tracking-wide text-muted">Affiliate commission</p>
        <h2 className="mt-1 font-display text-2xl leading-tight text-offwhite">
          Get paid for every business you bring in
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted" data-testid="earn-terms">
          You earn <RateClause /> {PAYABLE_RULE} No cap on how many businesses.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-offwhite" data-testid="earn-example">
          <HideInNativeApp>
            For example, a business on {example.planName} at {formatUsdCents(example.planCents)}{" "}
            a month earns you {formatUsdCents(example.cashMonthlyCents)} a month in cash or{" "}
            {formatUsdCents(example.creditMonthlyCents)} in credit, up to{" "}
            {formatUsdCents(example.cashWindowCents)} or{" "}
            {formatUsdCents(example.creditWindowCents)} over its {PERIOD}.
          </HideInNativeApp>
          <ShowInNativeApp>
            The rates, payouts and a worked example are on getchairback.com in your web browser.
          </ShowInNativeApp>
        </p>
        <p className="mt-3 text-xs leading-relaxed text-muted" data-testid="earn-choice">
          Credit is the default. Choosing cash and connecting a payout account aren&rsquo;t on
          this page yet, so for now your commissions are earned as credit.
        </p>

        <p className="mt-5 text-[10px] uppercase tracking-wide text-muted">Your next business</p>
        <div className="mt-2">
          <NextBusinessBar progress={progress} q={q} />
        </div>

        <p className="mt-5 text-[10px] uppercase tracking-wide text-muted">Your businesses</p>
        <div className="mt-2 flex flex-wrap items-end gap-x-8 gap-y-3">
          <Stat value={counts.signedUp} label="signed up through your link" />
          <Stat value={counts.paying} label="paying" muted />
          <Stat value={counts.qualified} label={`made ${q} payments`} muted />
        </div>
        <p className="mt-3 text-xs text-muted" data-testid="earnings-note">
          Commission amounts aren&rsquo;t shown on this page yet.
        </p>
      </Card>

      <Card className="mt-6 px-5 py-5">
        <p className="text-[10px] uppercase tracking-wide text-muted">Your link</p>
        <p className="mt-1 truncate font-mono text-sm text-offwhite">{link}</p>
        <p className="mt-1 min-w-0 break-words text-xs text-muted">
          Your code: <span className="font-mono text-offwhite">{overview.account.code}</span>.
          Someone on another device can enter it at {origin}/join/enter before they sign up.
        </p>
        <p className="mt-1 text-xs text-muted">
          Opened {overview.clicks.last7Days} times this week · {overview.clicks.last30Days} this
          month · {overview.clicks.allTime} all time
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => share(toolkitFor("text_dm", { link, shopName, vocab }).text)} className={PRIMARY}>
            Share
          </button>
          <button type="button" onClick={() => copy(link, "Link")} className={SECONDARY}>
            Copy link
          </button>
          <button type="button" onClick={showQr} disabled={qrPending} className={SECONDARY}>
            {qr ? "Hide QR" : qrPending ? "Building…" : "QR code"}
          </button>
        </div>
        {qr && (
          <div className="mt-4 flex flex-col items-start gap-2">
            <div
              className="w-40 rounded-lg bg-white p-2 [&_svg]:h-auto [&_svg]:w-full"
              aria-label="QR code for your affiliate link"
              dangerouslySetInnerHTML={{ __html: qr.svg }}
            />
            <a href={qr.png} download="chairback-affiliate-qr.png" className="text-xs text-muted underline">
              Download PNG
            </a>
          </div>
        )}
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-subtle px-5 py-4">
          <h2 className="font-display text-lg">Your toolkit</h2>
          <button type="button" onClick={onChangeStyles} className="text-xs text-muted underline">
            Change my styles
          </button>
        </div>
        <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
          {toolkit.map((t) => (
            <li key={t.style} className="px-5 py-4" data-testid="toolkit-card">
              <p className="text-sm font-medium text-offwhite">{t.title}</p>
              <p className="mt-0.5 text-xs text-muted">{t.blurb}</p>
              <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-charcoal-800 px-3 py-2.5 font-sans text-sm leading-relaxed text-offwhite">
                {t.text}
              </pre>
              <div className="mt-2 flex gap-2">
                <button type="button" className={SECONDARY} onClick={() => copy(t.text, "Text")}>
                  Copy
                </button>
                <button type="button" className={SECONDARY} onClick={() => share(t.text)}>
                  Share
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-subtle px-5 py-4">
          <h2 className="font-display text-lg">Who you&rsquo;ve brought on</h2>
        </div>
        {overview.referrals.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            Nobody yet. Businesses that sign up through your link show up here, by number, never by name.
          </p>
        ) : (
          <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
            {overview.referrals.map((r) => {
              const step = STAGE_STEP[r.stage];
              return (
                <li key={r.id} className="px-5 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium text-offwhite">{r.label}</p>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-[11px]",
                        step === null ? "bg-offwhite/5 text-muted" : "bg-gold/15 text-gold",
                      )}
                    >
                      {STAGE_COPY[r.stage]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    Signed up {fmtDate(r.signedUpAt)}
                    {r.stage === "hold" && r.holdEndsAt && ` · month off ready ${fmtDate(r.holdEndsAt)}`}
                    {r.stage === "month_off" && r.expiresAt && ` · use by ${fmtDate(r.expiresAt)}`}
                    {r.reversalMessage && ` · ${r.reversalMessage}`}
                  </p>
                  {step !== null && (
                    <ol className="mt-2 flex gap-1" aria-label="Progress">
                      {STEPS.map((label, i) => (
                        <li
                          key={label}
                          title={label}
                          className={cn(
                            "h-1.5 flex-1 rounded-full",
                            i <= step ? "bg-gold" : "bg-offwhite/10",
                          )}
                        />
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {hasMonthOffHistory && (
        <Card className="mt-6 overflow-hidden">
          <div className="border-b border-subtle px-5 py-4" data-testid="month-off-credits">
            <h2 className="font-display text-lg">Your month-off credits</h2>
            <p className="mt-1 text-xs text-muted">
              Earned under the earlier program, and kept: each one comes off a future ChairBack
              invoice automatically.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-x-8 gap-y-3">
              <Stat
                value={earned.total}
                label={earned.total === 1 ? "month off so far" : "months off so far"}
              />
              <Stat value={earned.used} label="used on your bill" muted />
              <Stat value={earned.ready} label="ready to use" muted />
              <Stat value={earned.inHold} label="waiting out the hold" muted />
              {earned.underReview > 0 && (
                <Stat value={earned.underReview} label="under review" muted />
              )}
            </div>
            {(m.reversed > 0 || m.expired > 0) && (
              <p className="mt-3 text-xs text-muted">
                {m.reversed > 0 && `${m.reversed} taken back`}
                {m.reversed > 0 && m.expired > 0 && " · "}
                {m.expired > 0 && `${m.expired} expired`}
              </p>
            )}
          </div>
          <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
            {overview.rewards.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm text-offwhite">1 month · {r.label}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {r.status === "PENDING" && `Ready ${fmtDate(r.holdEndsAt)}`}
                    {r.status === "AVAILABLE" && r.expiresAt && `Use by ${fmtDate(r.expiresAt)}`}
                    {r.status === "APPLIED" && "Applied to a ChairBack invoice"}
                    {r.status === "REVERSED" && r.reversalMessage}
                    {r.status === "REVIEW_REQUIRED" && "We're taking a look; nothing is lost"}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted">{REWARD_STATUS_COPY[r.status] ?? r.status}</span>
              </li>
            ))}
          </ul>
          <p className="px-5 py-3 text-xs text-muted">
            A month off expires {overview.policy.expiryMonths} months after it&rsquo;s ready if
            unused, as the terms you signed up under say.
          </p>
        </Card>
      )}

      <details className="mt-6 rounded-xl border border-subtle px-5 py-4 text-sm">
        <summary className="cursor-pointer font-medium text-offwhite">How it works</summary>
        <ul className="mt-3 space-y-2 text-muted" data-testid="how-it-works">
          <li>
            A business counts as yours if it signs up within {overview.policy.attributionWindowDays}{" "}
            days of opening your link.
          </li>
          <li>
            You earn on every payment it makes for its base plan in its {PERIOD}, counted from
            its first payment. Tax, add-ons, discounts and credits don&rsquo;t count.
          </li>
          <li>{PAYABLE_RULE}</li>
          <li>
            <HideInNativeApp>
              Cash is {bpsToPercent(COMMISSION.cashBps)}%, credit is{" "}
              {bpsToPercent(COMMISSION.creditBps)}%. Cash is paid through Stripe once you have{" "}
              {formatUsdCents(COMMISSION.minimumCashPayoutCents)} or more; less rolls over.
            </HideInNativeApp>
            <ShowInNativeApp>
              Cash is paid through Stripe above a minimum; less rolls over. The rates and the
              minimum are on getchairback.com in your web browser.
            </ShowInNativeApp>
          </li>
          <li>
            If a payment is refunded, disputed or credited back, its commission is taken back.
            If it was already paid, it comes off a future payout.
          </li>
          <li>
            Commissions can be held for review while an account is paused. Month-off credits
            you already earned are kept. We never text anyone on your behalf.
          </li>
        </ul>
        <p className="mt-3 text-xs text-muted">
          <Link href="/affiliate-terms" className="underline">
            Affiliate terms
          </Link>{" "}
          · version {overview.termsVersion}
        </p>
      </details>
    </>
  );
}

//  The toolkit: one ready-to-use asset per chosen style

interface ToolkitCard {
  style: AffiliatePromotionStyle;
  title: string;
  blurb: string;
  text: string;
}

/** The words this business uses for itself - so a nail tech's templates do
 *  not talk about chairs and haircuts. */
export interface ToolkitVocab {
  stationNoun: string;
  businessNoun: string;
  clientNounPlural: string;
}

const NEUTRAL_TOOLKIT_VOCAB: ToolkitVocab = {
  stationNoun: "station",
  businessNoun: "business",
  clientNounPlural: "clients",
};

export function toolkitFor(
  style: AffiliatePromotionStyle,
  ctx: { link: string; shopName: string; vocab?: ToolkitVocab },
): ToolkitCard {
  const { link } = ctx;
  const v = ctx.vocab ?? NEUTRAL_TOOLKIT_VOCAB;
  switch (style) {
    case "short_video":
      return {
        style,
        title: "Short video",
        blurb: "A 20-second script. Put the link in your bio and say so at the end.",
        text:
          `Real talk for anyone running their own ${v.businessNoun}: I stopped losing people between visits when I started running my book on ChairBack. Booking, reminders, a ${v.clientNounPlural} list that's actually mine. ` +
          "Link in my bio if you want to try it. " +
          DISCLOSURE,
      };
    case "posts_stories":
      return {
        style,
        title: "Post or story",
        blurb: "Caption for a photo of your setup. Add the link to your bio or a sticker.",
        text:
          `My book, my ${v.clientNounPlural}, my reminders. All in one place, and it's mine. If you run your own ${v.businessNoun} too, here's my link: ` +
          link +
          "\n\n" +
          DISCLOSURE,
      };
    case "in_the_chair":
      return {
        style,
        title: `In the ${v.stationNoun}`,
        blurb: `What to say when someone in your ${v.stationNoun} turns out to run their own ${v.businessNoun}.`,
        text:
          "You run your own book? I use ChairBack for mine. Booking, reminders, rewards, the lot. " +
          "I'll text you my link after this, it gets you set up. " +
          "Full disclosure: I'm a ChairBack affiliate, so I earn a commission when someone signs up through it.",
      };
    case "text_dm":
      return {
        style,
        title: "Text or DM",
        blurb: "Leads with what they get, not with the favor.",
        text:
          "I use ChairBack to run my shop: booking, reminders, and a client list that's actually mine. " +
          "Here's my link if you want to try it: " +
          link +
          "\n" +
          DISCLOSURE,
      };
    case "email_list":
      return {
        style,
        title: "Email",
        blurb: "Subject line plus a short body. Paste, tweak the greeting, send.",
        text:
          "Subject: The tool I run my book on\n\n" +
          "Hey,\n\nA few people asked what I use to run bookings and reminders. It's ChairBack. The client list is yours, reminders go out on their own, and clients rebook without calling.\n\n" +
          "Here's my link: " +
          link +
          "\n\n" +
          DISCLOSURE +
          "\n",
      };
    case "flyer_qr":
      return {
        style,
        title: "Flyer or QR at the shop",
        blurb: "Print the QR code from above. This is the caption under it.",
        text:
          `Run your own ${v.businessNoun}? Scan to try ChairBack: booking, reminders, rewards.
` +
          link +
          "\n" +
          DISCLOSURE,
      };
    case "blog_podcast":
      return {
        style,
        title: "Blog or podcast",
        blurb: "A paragraph you can read out or paste in, disclosure included.",
        text:
          `One thing that changed how I run my ${v.businessNoun}: moving my book to ChairBack. ${cap(v.clientNounPlural)} book themselves, reminders go out without me, and the ${v.clientNounPlural} list belongs to me, not to a marketplace. ` +
          "If you want to try it, my link is " +
          link +
          ". " +
          DISCLOSURE,
      };
    case "other":
    default:
      return {
        style: "other",
        title: "Your own way",
        blurb: "The link and the disclosure line. Everything else is yours.",
        text: link + "\n" + DISCLOSURE,
      };
  }
}
