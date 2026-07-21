"use client";

import { useEffect, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { NumberField } from "@/components/ui/NumberField";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type { LoyaltyConfig } from "./page";
import { searchClientsAction } from "../actions";
import {
  createCardAction,
  deleteCardAction,
  grantCardAction,
  listCardGrantsAction,
  reorderCardsAction,
  revokeCardAction,
  updateCardAction,
  type CardGrantRow,
  type CardInput,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const smallBtn =
  "rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-40";
const goldBtn =
  "rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50";

type CardType = LoyaltyConfig["cards"][number];

/**
 * Punch card TYPES editor: separate cards ("Haircut card", "Retwist card",
 * "VIP") each with its own balance and look. A visit auto-fills the FIRST card
 * (top to bottom) whose service term appears in the booked service name; no
 * match fills the classic default card. Exclusive cards are invite-only: the
 * barber picks members here (or just punches their card - that invites them).
 */
export function PunchCards({ cards }: { cards: CardType[] }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [membersId, setMembersId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function move(index: number, dir: -1 | 1) {
    const order = cards.map((c) => c.id);
    const target = index + dir;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    startTransition(async () => {
      const r = await reorderCardsAction(order);
      if (!r.ok) toast("Could not reorder", "error");
    });
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Punch cards"
        subtitle="Separate cards for different services - a retwist card, a VIP card. Each keeps its own punches. Order sets which card a service fills first."
        action={
          !adding && (
            <button onClick={() => setAdding(true)} className={goldBtn}>
              + Add card
            </button>
          )
        }
      />

      {adding && (
        <div className="border-b border-subtle bg-charcoal-800/60 px-5 py-4">
          <CardForm
            onCancel={() => setAdding(false)}
            onSave={(input) =>
              startTransition(async () => {
                const r = await createCardAction(input);
                if (r.ok) {
                  setAdding(false);
                  toast("Card added", "success");
                } else toast(r.error ?? "Could not add card", "error");
              })
            }
            pending={pending}
          />
        </div>
      )}

      {cards.length === 0 && !adding ? (
        <p className="px-5 py-6 text-sm text-muted">
          No extra cards yet - every visit fills your classic punch card. Add one to
          track a service separately (e.g. a &ldquo;Retwist card&rdquo;) or to reward
          your VIPs with their own invite-only card.
        </p>
      ) : (
        <ul className="divide-y divide-subtle">
          {cards.map((card, i) => (
            <li key={card.id}>
              {editingId === card.id ? (
                <div className="bg-charcoal-800/60 px-5 py-4">
                  <CardForm
                    initial={card}
                    onCancel={() => setEditingId(null)}
                    onSave={(input) =>
                      startTransition(async () => {
                        const r = await updateCardAction(card.id, input);
                        if (r.ok) {
                          setEditingId(null);
                          toast("Card updated", "success");
                        } else toast("Could not update card", "error");
                      })
                    }
                    pending={pending}
                  />
                </div>
              ) : (
                <div
                  className={cn(
                    "flex flex-wrap items-center gap-3 px-5 py-3.5",
                    !card.active && "opacity-50",
                  )}
                >
                  <div className="flex w-7 flex-col items-center gap-0.5">
                    <button
                      aria-label="Move up"
                      disabled={i === 0 || pending}
                      onClick={() => move(i, -1)}
                      className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      aria-label="Move down"
                      disabled={i === cards.length - 1 || pending}
                      onClick={() => move(i, 1)}
                      className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </div>
                  <span
                    aria-hidden
                    className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-subtle"
                    style={{ backgroundColor: card.accentColor ?? "#D4AF37" }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-offwhite">
                      {card.emoji ? `${card.emoji} ` : ""}
                      {card.name}
                      {card.exclusive && (
                        <span className="ml-2 rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold">
                          invite-only
                        </span>
                      )}
                      {!card.active && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">
                          archived
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {card.serviceMatch.length > 0
                        ? `Fills on: ${card.serviceMatch.join(", ")}`
                        : "No service match - fills only when you pick it"}
                      {" · "}
                      {card.punchesPerVisit} {card.punchesPerVisit === 1 ? "punch" : "punches"}
                      /visit
                      {card.exclusive &&
                        ` · ${card.grantCount} ${card.grantCount === 1 ? "member" : "members"}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {card.exclusive && (
                      <button
                        onClick={() => setMembersId(membersId === card.id ? null : card.id)}
                        className={smallBtn}
                      >
                        {membersId === card.id ? "Close members" : "Members"}
                      </button>
                    )}
                    <button
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const r = await updateCardAction(card.id, { active: !card.active });
                          if (!r.ok) toast("Could not update", "error");
                        })
                      }
                      className={smallBtn}
                    >
                      {card.active ? "Archive" : "Restore"}
                    </button>
                    <button onClick={() => setEditingId(card.id)} className={smallBtn}>
                      Edit
                    </button>
                    {card.hasActivity ? null : confirmDeleteId === card.id ? (
                      <span className="flex items-center gap-1.5">
                        <button
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              const r = await deleteCardAction(card.id);
                              setConfirmDeleteId(null);
                              if (r.ok) toast("Card deleted", "success");
                              else if (r.error === "has_activity")
                                toast(
                                  "This card has punch history - archive it instead",
                                  "error",
                                );
                              else toast("Could not delete", "error");
                            })
                          }
                          className="rounded-full bg-danger-soft/20 px-3 py-1.5 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/30"
                        >
                          Confirm
                        </button>
                        <button onClick={() => setConfirmDeleteId(null)} className={smallBtn}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmDeleteId(card.id)} className={smallBtn}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              )}
              {membersId === card.id && card.exclusive && (
                <MembersPanel cardId={card.id} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CardForm({
  initial,
  onSave,
  onCancel,
  pending,
}: {
  initial?: CardType;
  onSave: (input: CardInput) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [emoji, setEmoji] = useState(initial?.emoji ?? "");
  const [accentColor, setAccentColor] = useState(initial?.accentColor ?? "");
  const [punchesPerVisit, setPunchesPerVisit] = useState(initial?.punchesPerVisit ?? 1);
  const [exclusive, setExclusive] = useState(initial?.exclusive ?? false);
  const [terms, setTerms] = useState<string[]>(initial?.serviceMatch ?? []);
  const [termDraft, setTermDraft] = useState("");

  function addTerm() {
    const t = termDraft.trim();
    if (!t || terms.length >= 12) return;
    if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) setTerms([...terms, t]);
    setTermDraft("");
  }

  const validColor = accentColor === "" || /^#[0-9a-fA-F]{6}$/.test(accentColor);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[80px_1fr_130px_120px]">
        <label className="text-xs text-muted">
          Emoji
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="🌀"
            maxLength={8}
            className={`mt-1 ${field}`}
          />
        </label>
        <label className="text-xs text-muted">
          Card name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Retwist Card"
            maxLength={40}
            className={`mt-1 ${field}`}
          />
        </label>
        <label className="text-xs text-muted">
          Color (optional)
          <input
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value.trim())}
            placeholder="#D4AF37"
            maxLength={7}
            className={cn(`mt-1 ${field}`, !validColor && "border-danger-soft/60")}
          />
        </label>
        <label className="text-xs text-muted">
          Punches/visit
          <NumberField
            min={1}
            max={10}
            integer
            value={punchesPerVisit}
            onChange={setPunchesPerVisit}
            className={`mt-1 ${field}`}
          />
        </label>
      </div>

      <div className="text-xs text-muted">
        Fills when the booked service contains
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {terms.map((t) => (
            <span
              key={t}
              className="flex items-center gap-1.5 rounded-full border border-subtle bg-charcoal-700 px-3 py-1 text-xs text-offwhite"
            >
              {t}
              <button
                aria-label={`Remove ${t}`}
                onClick={() => setTerms(terms.filter((x) => x !== t))}
                className="text-muted transition-colors duration-150 ease-out hover:text-offwhite"
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={termDraft}
            onChange={(e) => setTermDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTerm();
              }
            }}
            onBlur={addTerm}
            placeholder={terms.length === 0 ? "retwist, twist…" : "add another…"}
            maxLength={80}
            className={cn(field, "w-44")}
          />
        </div>
        <p className="mt-1">
          Leave empty for a card that only fills when you pick it at the chair. Cards
          match before your default-card service bonuses.
        </p>
      </div>

      <label className="flex items-center gap-3 text-xs text-muted">
        <button
          type="button"
          role="switch"
          aria-checked={exclusive}
          onClick={() => setExclusive(!exclusive)}
          className={cn(
            "relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150 ease-out",
            exclusive ? "border-gold bg-gold/30" : "border-subtle bg-charcoal-700",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-offwhite transition-all duration-150 ease-out",
              exclusive ? "left-[18px]" : "left-0.5",
            )}
          />
        </button>
        <span>
          <span className="font-medium text-offwhite">Invite-only (VIP)</span> - only
          clients you add (or whose card you punch) can earn and see it
        </span>
      </label>

      <div className="flex items-center gap-2">
        <button
          disabled={
            pending ||
            name.trim() === "" ||
            !validColor ||
            !Number.isFinite(punchesPerVisit) ||
            punchesPerVisit < 1
          }
          onClick={() =>
            onSave({
              name: name.trim(),
              emoji: emoji.trim(),
              accentColor,
              serviceMatch: terms,
              punchesPerVisit: Math.trunc(punchesPerVisit),
              exclusive,
            })
          }
          className={goldBtn}
        >
          {pending ? "Saving…" : "Save card"}
        </button>
        <button onClick={onCancel} className={smallBtn}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Grant/revoke membership on an invite-only card. */
function MembersPanel({ cardId }: { cardId: string }) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [grants, setGrants] = useState<CardGrantRow[] | null>(null);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; phone: string | null }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listCardGrantsAction(cardId).then((r) => {
      if (!cancelled) setGrants(r.grants);
    });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  useEffect(() => {
    const t = term.trim();
    if (t.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchClientsAction(t).then((r) => {
        if (!cancelled) setResults(r);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const memberIds = new Set((grants ?? []).map((g) => g.clientId));

  return (
    <div className="border-t border-subtle bg-charcoal-800/40 px-5 py-4">
      <p className="mb-2 text-xs text-muted">Members</p>
      {grants === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : grants.length === 0 ? (
        <p className="text-sm text-muted">No members yet - search your book below.</p>
      ) : (
        <ul className="mb-3 flex flex-wrap gap-2">
          {grants.map((g) => (
            <li
              key={g.clientId}
              className="flex items-center gap-2 rounded-full border border-subtle bg-charcoal-700 px-3 py-1 text-xs text-offwhite"
            >
              {g.name}
              <button
                aria-label={`Remove ${g.name}`}
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const r = await revokeCardAction(cardId, g.clientId);
                    if (r.ok) {
                      setGrants((prev) => prev?.filter((x) => x.clientId !== g.clientId) ?? null);
                      toast("Member removed", "success");
                    } else toast("Could not remove", "error");
                  })
                }
                className="text-muted transition-colors duration-150 ease-out hover:text-offwhite"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search clients to add…"
        className={cn(field, "max-w-sm")}
      />
      {results.length > 0 && (
        <ul className="mt-2 flex max-w-sm flex-col gap-1">
          {results
            .filter((r) => !memberIds.has(r.id))
            .slice(0, 6)
            .map((r) => (
              <li key={r.id}>
                <button
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await grantCardAction(cardId, r.id);
                      if (res.ok) {
                        setGrants((prev) => [
                          { clientId: r.id, name: r.name, grantedAt: new Date().toISOString() },
                          ...(prev ?? []),
                        ]);
                        setTerm("");
                        setResults([]);
                        toast(`${r.name} added`, "success");
                      } else toast("Could not add", "error");
                    })
                  }
                  className="flex w-full items-center justify-between rounded-xl border border-subtle px-3 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
                >
                  <span>{r.name}</span>
                  <span className="text-xs text-muted">{r.phone ?? ""}</span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
