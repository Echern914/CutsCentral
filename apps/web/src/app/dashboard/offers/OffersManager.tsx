"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cap, useVocab } from "@/components/VocabProvider";
import { copyText } from "@/lib/contactUri";
import { offerValueWords } from "@chairback/config/offers";
import { CreateOfferDialog } from "./CreateOfferDialog";
import { deleteOfferAction, setOfferActiveAction, type OfferRow, type OffersList } from "./actions";

const STATUS_WORDS: Record<OfferRow["status"], string> = {
  on: "On",
  paused: "Paused",
  ended: "Ended",
  used_up: "Used",
};

/**
 * OFFERS & CODES - every offer the shop (or this seat) has made: its code,
 * what it gives, who it's for, how many uses are left. Pause stops new uses
 * and keeps every booking it already discounted; Delete is only for an offer
 * never used.
 */
export function OffersManager({ list, clientId }: { list: OffersList; clientId?: string }) {
  const vocab = useVocab();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const services = list.services ?? [];
  const staff = list.staff ?? [];
  const serviceName = (id: string) => services.find((s) => s.id === id)?.name ?? null;
  const staffName = (id: string) => staff.find((s) => s.id === id)?.name ?? cap(vocab.providerNoun);
  const timezone = list.timezone ?? "UTC";
  const client = clientId ? (list.offers.find((o) => o.client?.id === clientId)?.client ?? null) : null;

  async function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    if (busy) return;
    setBusy(id);
    setRowError(null);
    try {
      const res = await fn();
      if (!res.ok) setRowError({ id, message: res.error ?? "That didn't go through. Try again." });
      router.refresh();
    } catch {
      setRowError({ id, message: "No answer from ChairBack. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {list.canCreate && !clientId && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex h-11 items-center justify-center self-start rounded-xl bg-gold px-5 text-sm font-semibold text-charcoal-900 transition-colors duration-150 ease-out hover:bg-gold-muted"
        >
          Create offer
        </button>
      )}
      {list.offers.length === 0 ? (
        <p className="text-sm text-muted">No offers yet.</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-3" data-testid="offers-list">
          {list.offers.map((o) => {
            const limit =
              o.maxUses === null ? `${o.uses} used` : `${o.uses} of ${o.maxUses} used`;
            const forWhom = o.client ? `Only ${o.client.name} · staff-applied (New appointment → Offer)` : "Anyone with the code · online or in person";
            const covers =
              o.kind === "FREE_SERVICE"
                ? ""
                : o.serviceIds.length
                  ? ` · ${o.serviceIds.map((id) => serviceName(id) ?? cap(vocab.serviceNoun)).join(", ")}`
                  : ` · any ${vocab.serviceNoun}`;
            const withWho = o.staffIds.length ? ` · with ${o.staffIds.map(staffName).join(", ")}` : "";
            const ends = o.endsAt
              ? ` · visits before ${new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(new Date(o.endsAt))}`
              : "";
            return (
              <li key={o.id} className="flex min-w-0 flex-col gap-2 rounded-2xl border border-subtle bg-charcoal-800/40 p-3.5">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => void copyText(o.code).then((ok) => setCopied(ok ? o.id : null))}
                    className="min-w-0 truncate font-mono text-base tracking-wider text-gold"
                    aria-label={`Copy code ${o.code}`}
                  >
                    {o.code}
                  </button>
                  <span className="shrink-0 rounded-full border border-subtle px-2.5 py-0.5 text-[11px] text-muted">
                    {copied === o.id ? "Copied" : STATUS_WORDS[o.status]}
                  </span>
                </div>
                <p className="text-sm text-offwhite [overflow-wrap:anywhere]">
                  {offerValueWords(o, serviceName)}
                  {covers}
                  {withWho}
                </p>
                <p className="text-[12px] text-muted [overflow-wrap:anywhere]">
                  {forWhom} · {limit}
                  {ends}
                  {o.note ? ` · ${o.note}` : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  {o.status !== "ended" && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void run(o.id, () => setOfferActiveAction(o.id, !o.active))}
                      className="h-9 rounded-lg border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
                    >
                      {o.active ? "Pause" : "Turn back on"}
                    </button>
                  )}
                  {o.uses === 0 && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void run(o.id, () => deleteOfferAction(o.id))}
                      className="h-9 rounded-lg border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:text-danger-soft disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
                {rowError?.id === o.id && (
                  <p role="alert" className="text-sm text-danger-soft">
                    {rowError.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <CreateOfferDialog
          open
          onClose={() => setCreating(false)}
          onCreated={() => router.refresh()}
          services={services}
          staff={staff}
          client={client}
          allowedServiceIds={list.allowedServiceIds}
          ownStaffId={list.ownStaffId}
          timezone={timezone}
        />
      )}
    </div>
  );
}
