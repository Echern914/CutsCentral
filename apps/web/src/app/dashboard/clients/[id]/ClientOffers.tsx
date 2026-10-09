"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useVocab } from "@/components/VocabProvider";
import { offerValueWords } from "@chairback/config/offers";
import { CreateOfferDialog } from "../../offers/CreateOfferDialog";
import type { OffersList } from "../../offers/actions";

/**
 * A client's personal offers, and "Create offer" for one more. A personal
 * offer is used when the shop books this client with its code - never by
 * someone who only knows the code. Nothing is sent from here.
 */
export function ClientOffers({ list, client }: { list: OffersList; client: { id: string; name: string } }) {
  const vocab = useVocab();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const services = list.services ?? [];
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? null;
  const mine = list.offers.filter((o) => o.client?.id === client.id);
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="client-offers">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gold/80">
          Offers{" "}
          <Link href="/dashboard/offers" className="ml-1 normal-case tracking-normal text-muted underline-offset-4 hover:underline">
            All offers
          </Link>
        </h2>
        {list.canCreate && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="h-9 rounded-full border border-gold/50 px-3 text-xs font-medium text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
          >
            Create offer
          </button>
        )}
      </div>
      <p className="text-[12px] text-muted">
        A personal offer is <span className="text-offwhite">staff-applied</span>: it works when you book this{" "}
        {vocab.clientNoun} (Calendar → New appointment → Offer), not on the online booking page.
      </p>
      {mine.length === 0 ? (
        <p className="text-sm text-muted">No offers for this {vocab.clientNoun}.</p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {mine.map((o) => (
            <li key={o.id} className="text-sm text-offwhite [overflow-wrap:anywhere]">
              <span className="font-mono text-gold">{o.code}</span> · {offerValueWords(o, nameOf)} ·{" "}
              <span className="text-muted">
                {o.status === "on" ? (o.maxUses === null ? `${o.uses} used` : `${o.uses} of ${o.maxUses} used`) : o.status === "used_up" ? "used" : o.status}
              </span>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateOfferDialog
          open
          onClose={() => setCreating(false)}
          onCreated={() => router.refresh()}
          services={services}
          staff={list.staff ?? []}
          client={client}
          allowedServiceIds={list.allowedServiceIds}
          ownStaffId={list.ownStaffId}
          timezone={list.timezone ?? "UTC"}
        />
      )}
    </section>
  );
}
