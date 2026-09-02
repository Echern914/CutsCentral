"use client";

import { useState } from "react";
import {
  AFFILIATE_DECISION_REASONS,
  AFFILIATE_PROMOTION_STYLE_LABELS,
  AFFILIATE_SUSPENSION_REASONS,
  type AffiliatePromotionStyle,
} from "@chairback/config/affiliateProgram";
import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  approveAffiliateAction,
  correctAttributionAction,
  markAffiliateCreditAppliedAction,
  reactivateAffiliateAction,
  rejectAffiliateAction,
  releaseAffiliateCreditAction,
  releaseAffiliateRewardAction,
  retryAffiliateCreditAction,
  reverseAffiliateRewardAction,
  suspendAffiliateAction,
} from "./actions";

/**
 * The operator's Affiliates desk: the sign-up queue, the accounts, the
 * rewards the rolling-year rule held back, the liability line, and the four
 * kill switches as the running API sees them.
 *
 * The UI adds no rules. Every button is one API transition (a CAS with its
 * audit event); a refused transition comes back as a toast, and the page
 * revalidates so the table always shows what the database says.
 *
 * 🔴 Applicant links are rendered as TEXT with a copy button, never as
 * anchors. An admin clicking an applicant-supplied URL from the admin
 * portal is a phishing vector; copying it into a separate browser is not.
 */

export interface AdminApplication {
  id: string;
  shopId: string;
  status: string;
  promotionChannels: string[];
  audienceDescription: string;
  links: string[];
  promotionPlan: string;
  createdAt: string;
  shopName: string;
  ownerEmail: string;
}

export interface AdminAccount {
  id: string;
  shopId: string;
  code: string;
  status: "ACTIVE" | "SUSPENDED";
  suspensionReason: string | null;
  promotionStyles: string[];
  createdAt: string;
  shopName: string;
}

export interface AdminReward {
  id: string;
  status: string;
  amountCents: number;
  currency: string;
  basisPlan: string;
  qualifiedAt: string;
  reviewReason: string | null;
  affiliateShopName: string;
  referredShopName: string | null;
}

export interface AdminLiability {
  byStatus: Record<string, { rewards: number; cents: number }>;
  outstanding: { rewards: number; cents: number };
  accounts: { active: number; suspended: number };
  applicationsPending: number;
}

export interface AdminCredit {
  id: string;
  rewardId: string;
  status: string;
  amountCents: number;
  appliedCents: number | null;
  currency: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAmbiguous: boolean;
  nextAttemptAt: string | null;
  appliedAt: string | null;
  stripeBalanceTransactionId: string | null;
  affiliateShopName: string;
  createdAt: string;
}

export interface AdminFlags {
  programEnabled: boolean;
  publicApplicationsEnabled: boolean;
  qualificationEnabled: boolean;
  creditExecutionEnabled: boolean;
}

const BTN =
  "rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-50";
const BTN_GOLD =
  "rounded-full bg-gold px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50";
const BTN_RED =
  "rounded-full border border-red-500/40 px-3 py-1.5 text-xs text-red-400 transition-colors duration-150 ease-out hover:bg-red-500/10 disabled:opacity-50";
const SELECT =
  "rounded-lg border border-subtle bg-charcoal-800 px-2 py-1.5 text-xs text-offwhite focus:border-gold focus:outline-none";
const INPUT =
  "rounded-lg border border-subtle bg-charcoal-800 px-2 py-1.5 text-xs text-offwhite placeholder:text-muted focus:border-gold focus:outline-none";

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(
    cents / 100,
  );
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-0.5 text-[11px]",
        on ? "bg-emerald-500/15 text-emerald-300" : "bg-white/5 text-muted",
      )}
    >
      {label}: {on ? "on" : "off"}
    </span>
  );
}

export function AffiliatesSection({
  applications,
  accounts,
  rewards,
  liability,
  flags,
  credits = [],
}: {
  applications: AdminApplication[];
  accounts: AdminAccount[];
  rewards: AdminReward[];
  liability: AdminLiability | null;
  flags: AdminFlags | null;
  credits?: AdminCredit[];
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (res.ok) toast(done, "success");
    else toast(res.error === "invalid_transition" ? "Already handled" : `Failed: ${res.error ?? "unknown"}`, "error");
  }

  function copy(text: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast("Copied", "success"))
      .catch(() => toast("Couldn't copy", "error"));
  }

  return (
    <section className="mt-10" aria-label="Affiliates">
      <h2 className="mb-3 font-display text-lg">Affiliates</h2>

      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {flags && (
            <>
              <Pill on={flags.programEnabled} label="Program" />
              <Pill on={flags.publicApplicationsEnabled} label="Sign-ups" />
              <Pill on={flags.qualificationEnabled} label="Qualification" />
              <Pill on={flags.creditExecutionEnabled} label="Credits" />
            </>
          )}
          <a
            href="/api/admin-portal/affiliate/export.csv"
            className="ml-auto text-xs text-muted underline"
          >
            Export CSV
          </a>
        </div>
        {liability && (
          <p className="mt-3 text-sm text-muted">
            Outstanding: <span className="text-offwhite">{liability.outstanding.rewards}</span> rewards ·{" "}
            <span className="text-offwhite">{money(liability.outstanding.cents, "usd")}</span> · accounts{" "}
            {liability.accounts.active} active, {liability.accounts.suspended} suspended ·{" "}
            {liability.applicationsPending} sign-ups waiting
          </p>
        )}
      </Card>

      <h3 className="mb-2 mt-6 text-sm font-medium text-offwhite">
        Sign-ups waiting ({applications.length})
      </h3>
      <Card className="overflow-hidden p-0">
        {applications.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">Nothing waiting.</p>
        ) : (
          <ul className="divide-y divide-subtle/60">
            {applications.map((a) => (
              <ApplicationRow
                key={a.id}
                a={a}
                busy={busy === a.id}
                onCopy={copy}
                onApprove={(note) =>
                  run(a.id, () => approveAffiliateAction(a.id, note), `Approved ${a.shopName}`)
                }
                onReject={(reason, note) =>
                  run(a.id, () => rejectAffiliateAction(a.id, reason, note), `Rejected ${a.shopName}`)
                }
              />
            ))}
          </ul>
        )}
      </Card>

      <h3 className="mb-2 mt-6 text-sm font-medium text-offwhite">Accounts ({accounts.length})</h3>
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-subtle text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-medium">Shop</th>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Styles</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Since</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 && (
                <tr>
                  <td className="px-4 py-4 text-muted" colSpan={6}>
                    No accounts yet.
                  </td>
                </tr>
              )}
              {accounts.map((acc) => (
                <AccountRow
                  key={acc.id}
                  acc={acc}
                  busy={busy === acc.id}
                  onSuspend={(reason, note) =>
                    run(acc.id, () => suspendAffiliateAction(acc.id, reason, note), `Suspended ${acc.shopName}`)
                  }
                  onReactivate={() =>
                    run(acc.id, () => reactivateAffiliateAction(acc.id), `Reactivated ${acc.shopName}`)
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <h3 className="mb-2 mt-6 text-sm font-medium text-offwhite">
        Rewards under review ({rewards.length})
      </h3>
      <Card className="overflow-hidden p-0">
        {rewards.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">Nothing held for review.</p>
        ) : (
          <ul className="divide-y divide-subtle/60">
            {rewards.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-offwhite">
                    {r.affiliateShopName} <span className="text-muted">brought on</span>{" "}
                    {r.referredShopName ?? "(unknown shop)"}
                  </p>
                  <p className="text-xs text-muted">
                    {money(r.amountCents, r.currency)} · {r.basisPlan} · qualified{" "}
                    <LocalDate iso={r.qualifiedAt} /> · {r.reviewReason ?? "review"}
                  </p>
                </div>
                <button
                  type="button"
                  className={BTN_GOLD}
                  disabled={busy === r.id}
                  onClick={() => run(r.id, () => releaseAffiliateRewardAction(r.id), "Released")}
                >
                  Release
                </button>
                <button
                  type="button"
                  className={BTN_RED}
                  disabled={busy === r.id}
                  onClick={() => run(r.id, () => reverseAffiliateRewardAction(r.id), "Reversed")}
                >
                  Reverse
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <h3 className="mb-2 mt-6 text-sm font-medium text-offwhite">
        Credits ({credits.filter((c) => c.status !== "APPLIED" && c.status !== "CANCELED").length} open)
      </h3>
      <Card className="overflow-hidden p-0">
        {credits.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">No credit operations yet.</p>
        ) : (
          <ul className="divide-y divide-subtle/60">
            {credits.map((c) => (
              <CreditRow
                key={c.id}
                c={c}
                busy={busy === c.id}
                onRetry={() => run(c.id, () => retryAffiliateCreditAction(c.id), "Queued again")}
                onMarkApplied={(txn) =>
                  run(c.id, () => markAffiliateCreditAppliedAction(c.id, txn), "Marked applied")
                }
                onRelease={() => run(c.id, () => releaseAffiliateCreditAction(c.id), "Released to available")}
              />
            ))}
          </ul>
        )}
      </Card>

      <CorrectionForm
        busy={busy === "correction"}
        onSubmit={(id, code, reason) =>
          run("correction", () => correctAttributionAction(id, code, reason), "Attribution moved")
        }
      />
    </section>
  );
}

function ApplicationRow({
  a,
  busy,
  onCopy,
  onApprove,
  onReject,
}: {
  a: AdminApplication;
  busy: boolean;
  onCopy: (text: string) => void;
  onApprove: (note: string) => void;
  onReject: (reason: string, note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(AFFILIATE_DECISION_REASONS[0]);
  const [note, setNote] = useState("");
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-offwhite">{a.shopName}</p>
          <p className="text-xs text-muted">
            {a.ownerEmail} · sent <LocalDate iso={a.createdAt} /> · {a.promotionChannels.join(", ") || "no channels"}
          </p>
        </div>
        <button type="button" className={BTN} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Review"}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-3 text-sm">
          <p>
            <span className="text-muted">Who they reach: </span>
            <span className="text-offwhite">{a.audienceDescription}</span>
          </p>
          <p>
            <span className="text-muted">Plan: </span>
            <span className="text-offwhite">{a.promotionPlan}</span>
          </p>
          {a.links.length > 0 && (
            <ul className="space-y-1">
              {a.links.map((l) => (
                <li key={l} className="flex items-center gap-2">
                  {/* text, not a link - see the header */}
                  <code className="min-w-0 truncate text-xs text-muted">{l}</code>
                  <button type="button" className={BTN} onClick={() => onCopy(l)}>
                    Copy
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={cn(INPUT, "min-w-[16rem] flex-1")}
              placeholder="Internal note (never shown to the applicant)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
            />
            <button type="button" className={BTN_GOLD} disabled={busy} onClick={() => onApprove(note)}>
              Approve
            </button>
            <select className={SELECT} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Rejection reason">
              {AFFILIATE_DECISION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <button type="button" className={BTN_RED} disabled={busy} onClick={() => onReject(reason, note)}>
              Reject
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function AccountRow({
  acc,
  busy,
  onSuspend,
  onReactivate,
}: {
  acc: AdminAccount;
  busy: boolean;
  onSuspend: (reason: string, note: string) => void;
  onReactivate: () => void;
}) {
  const [reason, setReason] = useState<string>(AFFILIATE_SUSPENSION_REASONS[0]);
  return (
    <tr className="border-b border-subtle/60 last:border-0">
      <td className="px-4 py-3 text-offwhite">{acc.shopName}</td>
      <td className="px-4 py-3 font-mono text-xs text-muted">{acc.code}</td>
      <td className="px-4 py-3 text-xs text-muted">
        {acc.promotionStyles.length === 0
          ? "not chosen yet"
          : acc.promotionStyles
              .map((s) => AFFILIATE_PROMOTION_STYLE_LABELS[s as AffiliatePromotionStyle] ?? s)
              .join(", ")}
      </td>
      <td className="px-4 py-3">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px]",
            acc.status === "ACTIVE" ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-200",
          )}
        >
          {acc.status === "ACTIVE" ? "active" : `suspended · ${acc.suspensionReason ?? ""}`}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-muted">
        <LocalDate iso={acc.createdAt} />
      </td>
      <td className="px-4 py-3">
        {acc.status === "ACTIVE" ? (
          <div className="flex items-center gap-2">
            <select className={SELECT} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Suspension reason">
              {AFFILIATE_SUSPENSION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <button type="button" className={BTN_RED} disabled={busy} onClick={() => onSuspend(reason, "")}>
              Suspend
            </button>
          </div>
        ) : (
          <button type="button" className={BTN} disabled={busy} onClick={onReactivate}>
            Reactivate
          </button>
        )}
      </td>
    </tr>
  );
}

function CreditRow({
  c,
  busy,
  onRetry,
  onMarkApplied,
  onRelease,
}: {
  c: AdminCredit;
  busy: boolean;
  onRetry: () => void;
  onMarkApplied: (txn: string) => void;
  onRelease: () => void;
}) {
  const [txn, setTxn] = useState("");
  const open = c.status === "FAILED" || c.status === "ABANDONED";
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-offwhite">
          {c.affiliateShopName} · {money(c.appliedCents ?? c.amountCents, c.currency)}
        </p>
        <p className="text-xs text-muted">
          {c.status.toLowerCase()} · {c.attempts} attempt{c.attempts === 1 ? "" : "s"}
          {c.lastError ? ` · ${c.lastError}` : ""}
          {c.lastAttemptAmbiguous && c.status !== "APPLIED" ? " · ambiguous - check Stripe first" : ""}
          {c.stripeBalanceTransactionId ? ` · ${c.stripeBalanceTransactionId}` : ""}
        </p>
      </div>
      {c.status === "FAILED" && (
        <button type="button" className={BTN_GOLD} disabled={busy} onClick={onRetry}>
          Retry
        </button>
      )}
      {c.status === "ABANDONED" && (
        <>
          <input
            className={cn(INPUT, "min-w-[12rem]")}
            placeholder="cbtxn_… from Stripe"
            value={txn}
            onChange={(e) => setTxn(e.target.value)}
            aria-label="Stripe balance transaction id"
          />
          <button
            type="button"
            className={BTN_GOLD}
            disabled={busy || txn.trim().length < 3}
            onClick={() => onMarkApplied(txn.trim())}
          >
            Mark applied
          </button>
        </>
      )}
      {open && (
        <button type="button" className={BTN_RED} disabled={busy} onClick={onRelease}>
          Release
        </button>
      )}
    </li>
  );
}

function CorrectionForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (attributionId: string, newCode: string, reason: string) => void;
}) {
  const [id, setId] = useState("");
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const ready = id.trim().length > 0 && code.trim().length > 0 && reason.trim().length >= 3;
  return (
    <details className="mt-6 rounded-xl border border-subtle px-4 py-3 text-sm">
      <summary className="cursor-pointer text-offwhite">Move an attribution (7-day window, written reason)</summary>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className={cn(INPUT, "min-w-[14rem]")} placeholder="Attribution id" value={id} onChange={(e) => setId(e.target.value)} />
        <input className={cn(INPUT, "min-w-[10rem]")} placeholder="New affiliate code" value={code} onChange={(e) => setCode(e.target.value)} />
        <input className={cn(INPUT, "min-w-[18rem] flex-1")} placeholder="Reason (kept on record)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button
          type="button"
          className={BTN_GOLD}
          disabled={!ready || busy}
          onClick={() => onSubmit(id.trim(), code.trim(), reason.trim())}
        >
          Move
        </button>
      </div>
    </details>
  );
}
