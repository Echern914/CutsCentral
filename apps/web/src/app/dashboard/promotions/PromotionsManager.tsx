"use client";

import Link from "next/link";
import { cap, useVocab } from "@/components/VocabProvider";
import { useRef, useState, useTransition } from "react";
import { LOYALTY_TIERS, LOYALTY_TIER_KEYS, type LoyaltyTierKey } from "@chairback/config/constants";
import { describeTierAudience } from "@chairback/config/tierRules";
import { Card, CardHeader } from "@/components/ui/Card";
import { NumberField } from "@/components/ui/NumberField";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import { PlanBadge } from "../_components/PlanBadge";
import type { Promo } from "./page";
import { promoBroadcastHref, valueLabel } from "./promoDraft";
import {
  blastPromoAction,
  createPromoAction,
  deletePromoAction,
  updatePromoAction,
  type BlastAudience,
  type BlastSummary,
  type PromoInput,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const smallBtn =
  "rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-40";
const goldBtn =
  "rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50";

const KIND_LABELS: Record<Promo["kind"], string> = {
  PERCENT_OFF: "% off",
  AMOUNT_OFF: "$ off",
  FREE_ADDON: "Free add-on",
  EXTRA_PUNCHES: "Extra punches",
};

/** Highest first - the order a barber thinks about them in. */
const TIERS_TOP_DOWN = [...LOYALTY_TIER_KEYS].reverse();

/** A preview, stamped with the audience it counted - which is what Send sends. */
interface BlastPreview {
  summary: BlastSummary;
  audience: BlastAudience;
  tiers: LoyaltyTierKey[];
}

type BlastResult = Awaited<ReturnType<typeof blastPromoAction>>;

const NOT_A_TEXT = "Email or notify sends this promo without texting.";

/**
 * What a refused preview or send says.
 *
 * 🔴 THE API'S SENTENCE IS SHOWN ONLY WHERE THIS SURFACE KNOWS WHAT IT SAYS.
 * The 402s carry "Upgrade your plan..." - and this page runs inside the iOS
 * app, where upgrade steering is a Guideline 3.1.1 rejection. So a plan refusal
 * gets our own words (no upgrade hint in the app), texting-off gets the API's
 * `reason` (it has no `message`), and only the two refusals written for the
 * barber about THIS form pass their message through.
 */
function blastErrorText(r: BlastResult, inApp: boolean | null, fallback: string): string {
  switch (r.error) {
    case "subscription_required":
    case "premium_required":
      // Not-yet-known reads as the app: the careful copy is right in both.
      return inApp === false
        ? `Promo blasts are a Premium feature - upgrade from the Billing page. ${NOT_A_TEXT}`
        : `Promo blasts are a Premium feature. ${NOT_A_TEXT}`;
    case "texting_off":
      return `${r.reason ?? "Texting is turned off right now."} ${NOT_A_TEXT}`;
    case "quiet_hours":
      return "Texting is paused 9pm-8am (client local time). Try again in the morning.";
    case "invalid_input":
    case "tiers_need_rewards":
      return r.message ?? fallback;
    default:
      return fallback;
  }
}

function toastKind(r: BlastResult): "info" | "error" {
  return r.error === "subscription_required" || r.error === "premium_required" || r.error === "texting_off"
    ? "info"
    : "error";
}

const STATUS_STYLES: Record<Promo["status"], string> = {
  live: "bg-emerald-soft/15 text-emerald-soft",
  scheduled: "bg-gold/15 text-gold",
  ended: "bg-charcoal-700 text-muted",
  off: "bg-charcoal-700 text-muted",
};

function fmtDate(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";
}

export function PromotionsManager({
  promotions,
  premiumLocked = false,
  rewardsEnabled = false,
}: {
  promotions: Promo[];
  /** Lapsed shop: the blast trigger carries the diamond and says so up front. */
  premiumLocked?: boolean;
  /** Tiers exist only while rewards are on - no tier audience without them. */
  rewardsEnabled?: boolean;
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Your promotions"
        subtitle="Live ones show to clients automatically."
        action={
          !creating && (
            <button onClick={() => setCreating(true)} className={goldBtn}>
              + New promotion
            </button>
          )
        }
      />

      {creating && (
        <div className="border-b border-subtle bg-charcoal-800/60 px-5 py-4">
          <PromoForm
            pending={pending}
            onCancel={() => setCreating(false)}
            onSave={(input) =>
              startTransition(async () => {
                const r = await createPromoAction(input);
                if (r.ok) {
                  setCreating(false);
                  toast("Promotion created", "success");
                } else toast(r.error ?? "Could not create", "error");
              })
            }
          />
        </div>
      )}

      {promotions.length === 0 && !creating ? (
        <p className="px-5 py-6 text-sm text-muted">
          No promotions yet. Try &ldquo;20% off weekday cuts&rdquo; or a double-punch
          week to fill slow days.
        </p>
      ) : (
        <ul className="divide-y divide-subtle">
          {promotions.map((promo) => (
            <PromoRow
              key={promo.id}
              promo={promo}
              premiumLocked={premiumLocked}
              rewardsEnabled={rewardsEnabled}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PromoRow({
  promo,
  premiumLocked,
  rewardsEnabled,
}: {
  promo: Promo;
  premiumLocked?: boolean;
  rewardsEnabled?: boolean;
}) {
  const vocab = useVocab();
  const { toast } = useToast();
  // No "upgrade" steering inside the iOS app (Guideline 3.1.1).
  const inApp = useIsNativeApp();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blastOpen, setBlastOpen] = useState(false);
  const [preview, setPreview] = useState<BlastPreview | null>(null);
  const [audience, setAudience] = useState<BlastAudience>("all");
  const [tiers, setTiers] = useState<LoyaltyTierKey[]>([]);
  // "Only these tiers" with none picked is not a question the API will answer
  // (it would otherwise read as "everyone"), so it is not one we ask.
  const needsTier = audience === "tiers" && tiers.length === 0;
  // 🔴 A PREVIEW BELONGS TO THE QUESTION IT ANSWERED. Every change of audience
  // bumps this, and a preview that comes back for an older question is thrown
  // away - otherwise "Gold" counted 3, the barber adds Silver while it loads,
  // the screen says "Would text 3 ... Gold and Silver members" and Send texts 43.
  const asked = useRef(0);

  function clearPreview() {
    asked.current++;
    setPreview(null);
  }

  function toggleTier(t: LoyaltyTierKey) {
    setTiers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
    clearPreview();
  }

  const dates =
    promo.status === "scheduled"
      ? `starts ${fmtDate(promo.startsAt)}`
      : promo.endsAt
        ? `${promo.status === "ended" ? "ended" : "ends"} ${fmtDate(promo.endsAt)}`
        : "no end date";

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
            STATUS_STYLES[promo.status],
          )}
        >
          {promo.status}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-offwhite">
            {promo.title}
            <span className="ml-2 text-xs text-gold">{valueLabel(promo)}</span>
            {promo.code && (
              <span className="ml-2 rounded bg-charcoal-700 px-1.5 py-0.5 font-mono text-[10px] text-offwhite">
                {promo.code}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted">
            {promo.description ? `${promo.description} · ` : ""}
            {dates}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted">
          <span title="Texts sent">📱 {promo.textsSent}</span>
          <span title="Rebookings after the text">↩ {promo.rebookings}</span>
          <span title={`Times used at the ${vocab.stationNoun}`}>✓ {promo.timesUsed}</span>
        </div>
        <div className="flex items-center gap-2">
          {promo.status === "live" && (
            <span className="flex items-center gap-1.5">
              {premiumLocked && <PlanBadge tier="pro" />}
              <button
                onClick={() => {
                  setBlastOpen((v) => !v);
                  clearPreview();
                }}
                className="rounded-full border border-gold/50 px-3 py-1.5 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
              >
                Text clients
              </button>
              {/* The same promo to the same people, without texting: the
                  Clients-page composer (app notification or email) works on
                  every plan and while texting is off. It opens written out
                  from this promo, aimed at the tiers picked here. */}
              <Link
                href={promoBroadcastHref(promo.id, audience === "tiers" ? tiers : [])}
                className={smallBtn}
              >
                Email or notify
              </Link>
            </span>
          )}
          <button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await updatePromoAction(promo.id, { active: !promo.active });
                if (!r.ok) toast("Could not update", "error");
              })
            }
            className={smallBtn}
          >
            {promo.active ? "Pause" : "Resume"}
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-1.5">
              <button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await deletePromoAction(promo.id);
                    setConfirmDelete(false);
                    if (r.ok) toast("Promotion deleted", "success");
                    else toast("Could not delete", "error");
                  })
                }
                className="rounded-full bg-danger-soft/20 px-3 py-1.5 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/30"
              >
                Confirm
              </button>
              <button onClick={() => setConfirmDelete(false)} className={smallBtn}>
                Cancel
              </button>
            </span>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className={smallBtn}>
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Blast panel: preview first, then send - texting costs real money. */}
      {blastOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-gold/30 bg-charcoal-800/60 p-3">
          <label className="text-xs text-muted">
            Send to
            <select
              value={audience}
              disabled={pending}
              onChange={(e) => {
                setAudience(e.target.value as BlastAudience);
                clearPreview();
              }}
              className={`mt-1 ${field}`}
            >
              <option value="all">All opted-in clients</option>
              <option value="atRisk">Only overdue (at-risk) clients</option>
              {rewardsEnabled && <option value="tiers">Only these tiers…</option>}
            </select>
          </label>
          {audience === "tiers" && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tiers">
              {TIERS_TOP_DOWN.map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={pending}
                  onClick={() => toggleTier(t)}
                  aria-pressed={tiers.includes(t)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                    tiers.includes(t)
                      ? "bg-gold/20 text-gold"
                      : "border border-subtle text-muted hover:text-offwhite",
                  )}
                >
                  {LOYALTY_TIERS[t].label}
                </button>
              ))}
              {needsTier && <span className="text-xs text-muted">Pick at least one tier.</span>}
            </div>
          )}
          {/* Only the TEXT is aimed. The promo itself is still public, and an
              extra-punch promo still earns on every visit - saying so here
              stops "text it to Gold" being read as "a Gold-only offer". */}
          {audience === "tiers" && (
            <p className="w-full text-xs text-muted">
              Only the text goes to these tiers. The promo still shows on your page and every{" "}
              {vocab.clientNoun}&apos;s rewards page
              {promo.kind === "EXTRA_PUNCHES" ? ", and its extra punches count on everyone's visits" : ""}.
            </p>
          )}
          {preview === null ? (
            <button
              disabled={pending || needsTier}
              onClick={() => {
                // Snapshot the question; the answer is kept only if it is
                // still the question when the answer lands.
                const q = { audience, tiers: [...tiers] };
                const id = ++asked.current;
                startTransition(async () => {
                  const r = await blastPromoAction(promo.id, q.audience, true, q.tiers);
                  if (id !== asked.current) return;
                  if (r.summary) setPreview({ summary: r.summary, ...q });
                  else toast(blastErrorText(r, inApp, "Could not preview"), toastKind(r));
                });
              }}
              className={smallBtn}
            >
              {pending ? "…" : "Preview"}
            </button>
          ) : (
            <>
              <span className="text-xs text-offwhite">
                Would text <span className="font-semibold text-gold">{preview.summary.sent}</span>{" "}
                of {preview.summary.eligible} eligible
                {preview.audience === "tiers" ? ` ${describeTierAudience(preview.tiers)}` : ""}
                {preview.summary.skippedCap > 0 ? ` (${preview.summary.skippedCap} over today's cap)` : ""}
              </span>
              <button
                disabled={pending || preview.summary.sent === 0}
                onClick={() =>
                  startTransition(async () => {
                    // Sends exactly the audience that was counted, never
                    // whatever the controls say by the time this is tapped.
                    const r = await blastPromoAction(promo.id, preview.audience, false, preview.tiers);
                    setBlastOpen(false);
                    clearPreview();
                    if (r.summary)
                      toast(`Sent ${r.summary.sent} text${r.summary.sent === 1 ? "" : "s"}`, "success");
                    else toast(blastErrorText(r, inApp, "Send failed"), toastKind(r));
                  })
                }
                className={goldBtn}
              >
                Send now
              </button>
            </>
          )}
          <button
            onClick={() => {
              setBlastOpen(false);
              clearPreview();
            }}
            className={smallBtn}
          >
            Close
          </button>
        </div>
      )}
    </li>
  );
}

function PromoForm({
  onSave,
  onCancel,
  pending,
}: {
  onSave: (input: PromoInput) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const vocab = useVocab();
  const [kind, setKind] = useState<Promo["kind"]>("PERCENT_OFF");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");
  const [value, setValue] = useState(20);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  const valueLabelFor: Record<Promo["kind"], string> = {
    PERCENT_OFF: "Percent off",
    AMOUNT_OFF: "Dollars off",
    FREE_ADDON: "",
    EXTRA_PUNCHES: "Extra punches per visit",
  };

  function save() {
    const input: PromoInput = {
      kind,
      title: title.trim(),
      description: description.trim() || undefined,
      code: code.trim() || undefined,
    };
    if (kind === "PERCENT_OFF") input.percentOff = Math.trunc(value);
    if (kind === "AMOUNT_OFF") input.amountOff = value;
    if (kind === "EXTRA_PUNCHES") input.extraPunches = Math.trunc(value);
    // Date-only inputs: start at local midnight, end at the END of the chosen
    // day so "ends Friday" includes Friday.
    if (startsAt) input.startsAt = new Date(`${startsAt}T00:00:00`).toISOString();
    if (endsAt) input.endsAt = new Date(`${endsAt}T23:59:59`).toISOString();
    onSave(input);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[170px_1fr_130px]">
        <label className="text-xs text-muted">
          Type
          <select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as Promo["kind"];
              setKind(k);
              setValue(k === "PERCENT_OFF" ? 20 : k === "AMOUNT_OFF" ? 5 : 1);
            }}
            className={`mt-1 ${field}`}
          >
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Spring Special"
            maxLength={80}
            className={`mt-1 ${field}`}
          />
        </label>
        {kind !== "FREE_ADDON" ? (
          <label className="text-xs text-muted">
            {valueLabelFor[kind]}
            <NumberField
              min={1}
              max={kind === "PERCENT_OFF" ? 100 : kind === "EXTRA_PUNCHES" ? 10 : 500}
              step={kind === "AMOUNT_OFF" ? 0.5 : 1}
              integer={kind !== "AMOUNT_OFF"}
              value={value}
              onChange={setValue}
              className={`mt-1 ${field}`}
            />
          </label>
        ) : (
          <div />
        )}
      </div>
      <label className="text-xs text-muted">
        Description (shown to clients)
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={`20% off any weekday ${vocab.serviceNoun}`}
          maxLength={200}
          className={`mt-1 ${field}`}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-muted">
          Code (optional)
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="SPRING20"
            maxLength={24}
            className={`mt-1 ${field}`}
          />
        </label>
        <label className="text-xs text-muted">
          Starts (default today)
          <input
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className={`mt-1 ${field}`}
          />
        </label>
        <label className="text-xs text-muted">
          Ends (optional)
          <input
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className={`mt-1 ${field}`}
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          disabled={
            pending ||
            title.trim() === "" ||
            (kind !== "FREE_ADDON" && (!Number.isFinite(value) || value <= 0))
          }
          onClick={save}
          className={goldBtn}
        >
          {pending ? "Saving…" : "Create promotion"}
        </button>
        <button onClick={onCancel} className={smallBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}
