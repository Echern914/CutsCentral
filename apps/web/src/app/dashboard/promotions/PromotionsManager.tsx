"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { Promo } from "./page";
import {
  blastPromoAction,
  createPromoAction,
  deletePromoAction,
  updatePromoAction,
  type BlastSummary,
  type PromoInput,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const smallBtn =
  "rounded-full border border-subtle px-3 py-1.5 text-xs text-muted hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-40";
const goldBtn =
  "rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50";

const KIND_LABELS: Record<Promo["kind"], string> = {
  PERCENT_OFF: "% off",
  AMOUNT_OFF: "$ off",
  FREE_ADDON: "Free add-on",
  EXTRA_PUNCHES: "Extra punches",
};

function valueLabel(p: Promo): string {
  switch (p.kind) {
    case "PERCENT_OFF":
      return `${p.percentOff}% off`;
    case "AMOUNT_OFF":
      return `$${p.amountOff} off`;
    case "FREE_ADDON":
      return "Free add-on";
    case "EXTRA_PUNCHES":
      return `+${p.extraPunches} ${p.extraPunches === 1 ? "punch" : "punches"} per visit`;
  }
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

export function PromotionsManager({ promotions }: { promotions: Promo[] }) {
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
            <PromoRow key={promo.id} promo={promo} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PromoRow({ promo }: { promo: Promo }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blastOpen, setBlastOpen] = useState(false);
  const [preview, setPreview] = useState<BlastSummary | null>(null);
  const [audience, setAudience] = useState<"all" | "atRisk">("all");

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
          <span title="Times used at the chair">✓ {promo.timesUsed}</span>
        </div>
        <div className="flex items-center gap-2">
          {promo.status === "live" && (
            <button
              onClick={() => {
                setBlastOpen((v) => !v);
                setPreview(null);
              }}
              className="rounded-full border border-gold/50 px-3 py-1.5 text-xs font-medium text-gold hover:bg-gold/10"
            >
              Text clients
            </button>
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
                className="rounded-full bg-danger-soft/20 px-3 py-1.5 text-xs font-medium text-danger-soft hover:bg-danger-soft/30"
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
              onChange={(e) => {
                setAudience(e.target.value as "all" | "atRisk");
                setPreview(null);
              }}
              className={`mt-1 ${field}`}
            >
              <option value="all">All opted-in clients</option>
              <option value="atRisk">Only overdue (at-risk) clients</option>
            </select>
          </label>
          {preview === null ? (
            <button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const s = await blastPromoAction(promo.id, audience, true);
                  if (s) setPreview(s);
                  else toast("Could not preview", "error");
                })
              }
              className={smallBtn}
            >
              {pending ? "…" : "Preview"}
            </button>
          ) : (
            <>
              <span className="text-xs text-offwhite">
                Would text <span className="font-semibold text-gold">{preview.sent}</span>{" "}
                of {preview.eligible} eligible
                {preview.skippedCap > 0 ? ` (${preview.skippedCap} over today's cap)` : ""}
              </span>
              <button
                disabled={pending || preview.sent === 0}
                onClick={() =>
                  startTransition(async () => {
                    const s = await blastPromoAction(promo.id, audience, false);
                    setBlastOpen(false);
                    setPreview(null);
                    if (s) toast(`Sent ${s.sent} text${s.sent === 1 ? "" : "s"}`, "success");
                    else toast("Send failed", "error");
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
              setPreview(null);
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
            <input
              type="number"
              min={kind === "AMOUNT_OFF" ? 1 : 1}
              max={kind === "PERCENT_OFF" ? 100 : kind === "EXTRA_PUNCHES" ? 10 : 500}
              step={kind === "AMOUNT_OFF" ? 0.5 : 1}
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
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
          placeholder="20% off any weekday cut"
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
