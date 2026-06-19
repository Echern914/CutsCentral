"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { mergeClientAction, searchClientsAction } from "../../actions";

interface Hit {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/**
 * Fold a duplicate client into THIS one (the winner). The barber searches for the
 * duplicate, picks it, and confirms; on the server the duplicate's visits, punch
 * ledger, nudges, and promo uses move here, consent reconciles (opted-out-wins,
 * earliest-consent-wins), and the duplicate is archived. Collapsed by default
 * since it's a rare, deliberate action.
 */
export function MergeClient({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, startSearch] = useTransition();
  const [merging, startMerge] = useTransition();
  const [picked, setPicked] = useState<Hit | null>(null);

  function runSearch() {
    const term = q.trim();
    if (!term) {
      setHits([]);
      return;
    }
    startSearch(async () => {
      const results = await searchClientsAction(term);
      // Never offer THIS client as its own merge source.
      setHits(results.filter((h) => h.id !== clientId));
    });
  }

  function doMerge(loser: Hit) {
    startMerge(async () => {
      const r = await mergeClientAction(clientId, loser.id);
      if (r.ok) {
        setPicked(null);
        setOpen(false);
        setQ("");
        setHits([]);
        toast(`Merged ${loser.name} into ${clientName}`, "success");
        router.refresh();
      } else {
        toast("Couldn't merge those clients.", "error");
      }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-offwhite hover:underline"
      >
        Merge a duplicate into this client
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-subtle bg-charcoal-800 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-offwhite">Merge a duplicate</h3>
        <button
          onClick={() => {
            setOpen(false);
            setPicked(null);
            setQ("");
            setHits([]);
          }}
          className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
        >
          Close
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">
        Find the duplicate record. Its visits, punches, and nudge history move into{" "}
        <span className="text-offwhite">{clientName}</span>, and the duplicate is archived.
      </p>

      {!picked ? (
        <>
          <div className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch();
              }}
              placeholder="Search the duplicate's name, phone, or email…"
              className={field}
            />
            <button
              onClick={runSearch}
              disabled={searching}
              className="shrink-0 rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
            >
              {searching ? "…" : "Search"}
            </button>
          </div>
          {hits.length > 0 && (
            <ul className="mt-2 divide-y divide-subtle rounded-xl border border-subtle">
              {hits.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-offwhite">{h.name}</p>
                    <p className="truncate text-xs text-muted">
                      {h.phone ?? h.email ?? "no contact"}
                    </p>
                  </div>
                  <button
                    onClick={() => setPicked(h)}
                    className="shrink-0 rounded-full border border-gold/50 px-3 py-1 text-[11px] text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
                  >
                    Merge in
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!searching && q.trim() !== "" && hits.length === 0 && (
            <p className="mt-2 text-xs text-muted">No matching clients.</p>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-offwhite">
            Merge <span className="text-gold">{picked.name}</span> into{" "}
            <span className="text-gold">{clientName}</span>? This moves all of their
            history here and archives <span className="text-offwhite">{picked.name}</span>.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => doMerge(picked)}
              disabled={merging}
              className="rounded-full bg-gold px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
            >
              {merging ? "Merging…" : "Yes, merge"}
            </button>
            <button
              onClick={() => setPicked(null)}
              disabled={merging}
              className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
