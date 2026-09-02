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
  type AffiliatePromotionStyle,
} from "@chairback/config/affiliateProgram";
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
 * MONTHS, NEVER DOLLARS. The headline number is months off; no price, plan
 * name or dollar figure renders anywhere on this tab. That is what Eric asked
 * for, it reads the same for every kind of business, and it keeps the iOS
 * WebView clean of the pricing UI that App Store Guideline 3.1.1 rejected a
 * build over. A test asserts the dashboard never renders a dollar amount.
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

const STAGE_COPY: Record<ReferralStage, string> = {
  signed_up: "Signed up",
  first_payment: "1 of 2 payments",
  second_payment: "2 of 2 payments",
  hold: "In the hold",
  month_off: "Month off ready",
  applied: "Applied to your bill",
  reversed: "Taken back",
  expired: "Expired",
  under_review: "Under review",
};

/** Index on the five-step road; null = a terminal badge instead. */
const STAGE_STEP: Record<ReferralStage, number | null> = {
  signed_up: 0,
  first_payment: 1,
  second_payment: 2,
  hold: 3,
  month_off: 4,
  applied: 4,
  reversed: null,
  expired: null,
  under_review: null,
};

const STEPS = ["Signed up", "1st payment", "2nd payment", "Hold", "Month off"];

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
  "I'm a ChairBack affiliate and get a month off my plan when a shop signs up through my link.";

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
      <p className="mb-6 text-sm text-muted">
        Bring a business onto ChairBack. When they&rsquo;ve paid for{" "}
        {AFFILIATE_POLICY.qualification.qualifyingInvoices} months, you get a month off.
      </p>

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
          using ChairBack.
        </li>
        <li>
          <span className="mr-2 text-gold">3</span>After their{" "}
          {p.qualification.qualifyingInvoices === 2 ? "second" : `${p.qualification.qualifyingInvoices}th`}{" "}
          paid month, and a {p.qualification.holdDaysAfterSecond}-day hold, a month off
          lands on your plan.
        </li>
      </ol>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        One month per business, no cap on businesses. Your link counts for{" "}
        {p.attribution.windowDays} days after someone opens it. A month off expires{" "}
        {p.reward.expiryMonthsAfterAvailable} months after it&rsquo;s ready if unused. Credits
        are never cash. Full rules:{" "}
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
            <p role="alert" className="mt-4 text-xs text-red-400">
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
        <p role="alert" className="mt-4 text-xs text-red-400">
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
      } catch {
        // Cancelled or unsupported: fall through to copying.
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
          className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          {overview.account.suspensionMessage}
        </div>
      )}

      <Card className="px-5 py-5">
        <p className="text-[10px] uppercase tracking-wide text-muted">Months off</p>
        <div className="mt-2 flex flex-wrap gap-x-8 gap-y-3">
          <Stat value={m.earned} label={m.earned === 1 ? "month earned" : "months earned"} />
          <Stat value={m.onTheWay} label="on the way" muted />
          {m.underReview > 0 && <Stat value={m.underReview} label="under review" muted />}
        </div>
        {(m.reversed > 0 || m.expired > 0) && (
          <p className="mt-3 text-xs text-muted">
            {m.reversed > 0 && `${m.reversed} taken back`}
            {m.reversed > 0 && m.expired > 0 && " · "}
            {m.expired > 0 && `${m.expired} expired`}
          </p>
        )}

        <p className="mt-5 text-[10px] uppercase tracking-wide text-muted">Your link</p>
        <p className="mt-1 truncate font-mono text-sm text-offwhite">{link}</p>
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
                        step === null ? "bg-white/5 text-muted" : "bg-gold/15 text-gold",
                      )}
                    >
                      {STAGE_COPY[r.stage]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    Signed up {fmtDate(r.signedUpAt)}
                    {r.stage === "hold" && r.holdEndsAt && ` · ready ${fmtDate(r.holdEndsAt)}`}
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
                            i <= step ? "bg-gold" : "bg-white/10",
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

      {overview.rewards.length > 0 && (
        <Card className="mt-6 overflow-hidden">
          <div className="border-b border-subtle px-5 py-4">
            <h2 className="font-display text-lg">Your months</h2>
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
            Months are applied to a future ChairBack invoice automatically.
          </p>
        </Card>
      )}

      <details className="mt-6 rounded-xl border border-subtle px-5 py-4 text-sm">
        <summary className="cursor-pointer font-medium text-offwhite">How the months work</summary>
        <ul className="mt-3 space-y-2 text-muted">
          <li>
            A business counts as yours if it signs up within {overview.policy.attributionWindowDays}{" "}
            days of opening your link.
          </li>
          <li>
            It qualifies after {overview.policy.qualifyingInvoices} paid months, then a{" "}
            {overview.policy.holdDays}-day hold.
          </li>
          <li>One month per business. A month expires {overview.policy.expiryMonths} months after it&rsquo;s ready.</li>
          <li>If their payment is refunded or disputed before your month is applied, it&rsquo;s taken back.</li>
          <li>Never cash, never transferable. We never text anyone on your behalf.</li>
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
          "Full disclosure: I'm a ChairBack affiliate, so I get a month off my plan when someone signs up through it.",
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
