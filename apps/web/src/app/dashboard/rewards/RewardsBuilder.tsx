"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { LoyaltyConfig } from "./page";
import {
  createRewardAction,
  createRuleAction,
  deleteRewardAction,
  deleteRuleAction,
  reorderRewardsAction,
  reorderRulesAction,
  saveEarnRateAction,
  updateRewardAction,
  updateRuleAction,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const smallBtn =
  "rounded-full border border-subtle px-3 py-1.5 text-xs text-muted hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-40";
const goldBtn =
  "rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50";

type Reward = LoyaltyConfig["rewards"][number];
type Rule = LoyaltyConfig["rules"][number];

export function RewardsBuilder({ config }: { config: LoyaltyConfig }) {
  return (
    <div className="flex flex-col gap-6">
      <RewardMenu rewards={config.rewards} />
      <Earning punchesPerVisit={config.punchesPerVisit} rules={config.rules} />
    </div>
  );
}

/*  Reward menu  */

function RewardMenu({ rewards }: { rewards: Reward[] }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function move(index: number, dir: -1 | 1) {
    const order = rewards.map((r) => r.id);
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    startTransition(async () => {
      const r = await reorderRewardsAction(order);
      if (!r.ok) toast("Could not reorder", "error");
    });
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Reward menu"
        subtitle="What punches buy at your chair. Add as many as you want."
        action={
          !adding && (
            <button onClick={() => setAdding(true)} className={goldBtn}>
              + Add reward
            </button>
          )
        }
      />

      {adding && (
        <div className="border-b border-subtle bg-charcoal-800/60 px-5 py-4">
          <RewardForm
            onCancel={() => setAdding(false)}
            onSave={(input) =>
              startTransition(async () => {
                const r = await createRewardAction(input);
                if (r.ok) {
                  setAdding(false);
                  toast("Reward added", "success");
                } else toast(r.error ?? "Could not add reward", "error");
              })
            }
            pending={pending}
          />
        </div>
      )}

      {rewards.length === 0 && !adding ? (
        <p className="px-5 py-6 text-sm text-muted">
          No rewards yet. Add your first one: e.g. &ldquo;Free Cut&rdquo; for 10 punches.
        </p>
      ) : (
        <ul className="divide-y divide-subtle">
          {rewards.map((reward, i) =>
            editingId === reward.id ? (
              <li key={reward.id} className="bg-charcoal-800/60 px-5 py-4">
                <RewardForm
                  initial={reward}
                  onCancel={() => setEditingId(null)}
                  onSave={(input) =>
                    startTransition(async () => {
                      const r = await updateRewardAction(reward.id, input);
                      if (r.ok) {
                        setEditingId(null);
                        toast("Reward updated", "success");
                      } else toast("Could not update reward", "error");
                    })
                  }
                  pending={pending}
                />
              </li>
            ) : (
              <li
                key={reward.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 px-5 py-3.5",
                  !reward.active && "opacity-50",
                )}
              >
                <div className="flex w-7 flex-col items-center gap-0.5">
                  <button
                    aria-label="Move up"
                    disabled={i === 0 || pending}
                    onClick={() => move(i, -1)}
                    className="text-xs text-muted hover:text-offwhite disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    aria-label="Move down"
                    disabled={i === rewards.length - 1 || pending}
                    onClick={() => move(i, 1)}
                    className="text-xs text-muted hover:text-offwhite disabled:opacity-30"
                  >
                    ▼
                  </button>
                </div>
                <span className="text-xl" aria-hidden>
                  {reward.emoji || "🎁"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-offwhite">
                    {reward.name}
                    {!reward.active && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">
                        hidden
                      </span>
                    )}
                  </p>
                  {reward.description && (
                    <p className="truncate text-xs text-muted">{reward.description}</p>
                  )}
                </div>
                <span className="rounded-full bg-gold/15 px-3 py-1 text-xs font-semibold text-gold">
                  {reward.punchCost} {reward.punchCost === 1 ? "punch" : "punches"}
                </span>
                {reward.timesRedeemed > 0 && (
                  <span className="text-[10px] text-muted">
                    redeemed {reward.timesRedeemed}×
                  </span>
                )}
                <div className="flex items-center gap-2">
                  <button
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await updateRewardAction(reward.id, {
                          active: !reward.active,
                        });
                        if (!r.ok) toast("Could not update", "error");
                      })
                    }
                    className={smallBtn}
                  >
                    {reward.active ? "Hide" : "Show"}
                  </button>
                  <button onClick={() => setEditingId(reward.id)} className={smallBtn}>
                    Edit
                  </button>
                  {confirmDeleteId === reward.id ? (
                    <span className="flex items-center gap-1.5">
                      <button
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const r = await deleteRewardAction(reward.id);
                            setConfirmDeleteId(null);
                            if (r.ok) toast("Reward deleted", "success");
                            else toast("Could not delete", "error");
                          })
                        }
                        className="rounded-full bg-danger-soft/20 px-3 py-1.5 text-xs font-medium text-danger-soft hover:bg-danger-soft/30"
                      >
                        Confirm
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)} className={smallBtn}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(reward.id)}
                      className={smallBtn}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  );
}

function RewardForm({
  initial,
  onSave,
  onCancel,
  pending,
}: {
  initial?: Reward;
  onSave: (input: {
    name: string;
    description?: string;
    emoji?: string;
    punchCost: number;
  }) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [punchCost, setPunchCost] = useState(initial?.punchCost ?? 10);
  const [description, setDescription] = useState(initial?.description ?? "");

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[80px_1fr_120px]">
        <label className="text-xs text-muted">
          Emoji
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="✂️"
            maxLength={8}
            className={`mt-1 ${field}`}
          />
        </label>
        <label className="text-xs text-muted">
          Reward name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Free Cut"
            maxLength={80}
            className={`mt-1 ${field}`}
          />
        </label>
        <label className="text-xs text-muted">
          Punch cost
          <input
            type="number"
            min={1}
            max={100}
            value={punchCost}
            onChange={(e) => setPunchCost(Number(e.target.value))}
            className={`mt-1 ${field}`}
          />
        </label>
      </div>
      <label className="text-xs text-muted">
        Description (optional)
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Any service up to $40"
          maxLength={200}
          className={`mt-1 ${field}`}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          disabled={pending || name.trim() === "" || !Number.isFinite(punchCost) || punchCost < 1}
          onClick={() =>
            onSave({
              name: name.trim(),
              emoji: emoji.trim(),
              description: description.trim(),
              punchCost: Math.trunc(punchCost),
            })
          }
          className={goldBtn}
        >
          {pending ? "Saving…" : "Save reward"}
        </button>
        <button onClick={onCancel} className={smallBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/*  Earning  */

function Earning({
  punchesPerVisit,
  rules,
}: {
  punchesPerVisit: number;
  rules: Rule[];
}) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [rate, setRate] = useState(punchesPerVisit);
  const [adding, setAdding] = useState(false);
  const [match, setMatch] = useState("");
  const [punches, setPunches] = useState(2);

  function saveRate(next: number) {
    const clamped = Math.min(10, Math.max(1, next));
    setRate(clamped);
    startTransition(async () => {
      const r = await saveEarnRateAction(clamped);
      if (!r.ok) {
        setRate(punchesPerVisit);
        toast("Could not save earn rate", "error");
      }
    });
  }

  function moveRule(index: number, dir: -1 | 1) {
    const order = rules.map((r) => r.id);
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    startTransition(async () => {
      const r = await reorderRulesAction(order);
      if (!r.ok) toast("Could not reorder", "error");
    });
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="How punches are earned"
        subtitle="Set the base rate, then boost specific services."
      />

      {/* Base rate */}
      <div className="flex flex-wrap items-center gap-3 border-b border-subtle px-5 py-4">
        <p className="text-sm text-offwhite">Every completed visit earns</p>
        <span className="flex items-center gap-1">
          <button
            aria-label="Decrease"
            disabled={pending || rate <= 1}
            onClick={() => saveRate(rate - 1)}
            className={smallBtn}
          >
            −
          </button>
          <span className="w-10 text-center font-display text-lg text-gold">{rate}</span>
          <button
            aria-label="Increase"
            disabled={pending || rate >= 10}
            onClick={() => saveRate(rate + 1)}
            className={smallBtn}
          >
            +
          </button>
        </span>
        <p className="text-sm text-offwhite">{rate === 1 ? "punch" : "punches"}</p>
      </div>

      {/* Service rules */}
      <div className="px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            Service bonuses: when the booked service name contains your text, it earns
            that amount instead. First matching rule wins.
          </p>
          {!adding && (
            <button onClick={() => setAdding(true)} className={smallBtn}>
              + Add bonus
            </button>
          )}
        </div>

        {adding && (
          <div className="mb-3 flex flex-wrap items-end gap-3 rounded-xl border border-subtle bg-charcoal-800/60 p-3">
            <label className="flex-1 text-xs text-muted">
              Service contains
              <input
                value={match}
                onChange={(e) => setMatch(e.target.value)}
                placeholder="Cut + Beard"
                maxLength={80}
                className={`mt-1 ${field}`}
              />
            </label>
            <label className="w-28 text-xs text-muted">
              Earns
              <input
                type="number"
                min={1}
                max={20}
                value={punches}
                onChange={(e) => setPunches(Number(e.target.value))}
                className={`mt-1 ${field}`}
              />
            </label>
            <button
              disabled={pending || match.trim() === "" || !Number.isFinite(punches) || punches < 1}
              onClick={() =>
                startTransition(async () => {
                  const r = await createRuleAction({
                    serviceMatch: match.trim(),
                    punches: Math.trunc(punches),
                  });
                  if (r.ok) {
                    setAdding(false);
                    setMatch("");
                    setPunches(2);
                    toast("Bonus added", "success");
                  } else toast(r.error ?? "Could not add bonus", "error");
                })
              }
              className={goldBtn}
            >
              Save
            </button>
            <button onClick={() => setAdding(false)} className={smallBtn}>
              Cancel
            </button>
          </div>
        )}

        {rules.length === 0 && !adding ? (
          <p className="text-sm text-muted">
            No service bonuses. Example: &ldquo;Cut + Beard&rdquo; earns 2 punches.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((rule, i) => (
              <li
                key={rule.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-xl border border-subtle px-3 py-2.5",
                  !rule.active && "opacity-50",
                )}
              >
                <div className="flex w-7 flex-col items-center gap-0.5">
                  <button
                    aria-label="Move up"
                    disabled={i === 0 || pending}
                    onClick={() => moveRule(i, -1)}
                    className="text-xs text-muted hover:text-offwhite disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    aria-label="Move down"
                    disabled={i === rules.length - 1 || pending}
                    onClick={() => moveRule(i, 1)}
                    className="text-xs text-muted hover:text-offwhite disabled:opacity-30"
                  >
                    ▼
                  </button>
                </div>
                <p className="min-w-0 flex-1 text-sm text-offwhite">
                  Service contains{" "}
                  <span className="font-medium text-gold">&ldquo;{rule.serviceMatch}&rdquo;</span>
                </p>
                <span className="rounded-full bg-gold/15 px-3 py-1 text-xs font-semibold text-gold">
                  {rule.punches} {rule.punches === 1 ? "punch" : "punches"}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await updateRuleAction(rule.id, { active: !rule.active });
                        if (!r.ok) toast("Could not update", "error");
                      })
                    }
                    className={smallBtn}
                  >
                    {rule.active ? "Pause" : "Resume"}
                  </button>
                  <button
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await deleteRuleAction(rule.id);
                        if (r.ok) toast("Bonus removed", "success");
                        else toast("Could not remove", "error");
                      })
                    }
                    className={smallBtn}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
