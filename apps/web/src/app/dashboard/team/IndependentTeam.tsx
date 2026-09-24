"use client";

import { useEffect, useState } from "react";
import type { BusinessVocabulary } from "@chairback/config";
import { Card, CardHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { teamStats, type Sharing, type TeamNumbers } from "@/lib/teamNumbers";
import { hasRent, type RentSummary } from "@/lib/boothRent";
import { approveLinkAction, endLinkAction, teamLinksAction } from "./actions";
import { OwnerRent } from "./BoothRent";

export interface TeamLinksData {
  /** The one link the owner sends: /team/link/<their shop id>. */
  joinUrl: string;
  pending: {
    id: string;
    business: { name: string; logoUrl: string | null };
    ownerName: string;
    requestedAt: string;
  }[];
  active: {
    id: string;
    business: { name: string; logoUrl: string | null };
    ownerName: string;
    approvedAt: string | null;
    sharing: Sharing;
    numbers: TeamNumbers;
    /** Booth rent: the owner's own ledger with this member. */
    rent: RentSummary;
  }[];
  /**
   * Booth rent with members who left (ENDED) or are asking to come back
   * (PENDING): only the rent - nothing else of their business. The owner can
   * still settle it (a late payment, voiding a mistake), never restart it.
   */
  past: {
    id: string;
    status: "PENDING" | "ENDED";
    endedAt: string | null;
    business: { name: string };
    rent: RentSummary;
  }[];
}

const quiet =
  "min-h-[40px] rounded-full border border-subtle px-4 text-xs text-muted transition-colors hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-50";
const primary =
  "min-h-[40px] rounded-full bg-gold px-4 text-xs font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";

/**
 * The owner's side of an independent team (booth-rent shops): one link to
 * send, requests to approve, and the team with each member's numbers - only
 * the ones that member shares. Everything here is read back from the server
 * after each change; nothing is assumed to have worked.
 */
export function IndependentTeam({
  initial,
  vocab,
}: {
  initial: TeamLinksData;
  vocab: BusinessVocabulary;
}) {
  const { toast } = useToast();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<
    TeamLinksData["active"][number] | null
  >(null);
  const providers = vocab.providerNounPlural;

  /**
   * Run one change, then show what the SERVER now says - success only after
   * it confirmed. A 404 means someone already handled it (a second device, the
   * barber withdrew): the re-read makes it disappear, and the toast says why.
   */
  async function act(
    /** Which change is running, e.g. "approve:<id>" - so only its button says so. */
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    done: string,
    failed: string,
  ) {
    setBusy(key);
    const res = await fn();
    const fresh = await teamLinksAction();
    if (fresh) setData(fresh);
    if (res.ok) toast(done, "success");
    else
      toast(
        res.error === "not_found" ? "That was already handled" : failed,
        "error",
      );
    setBusy(null);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(data.joinUrl);
      toast("Link copied", "success");
    } catch {
      // Clipboard blocked (some in-app browsers): the link is on screen and
      // selectable, so point at it rather than claim a copy that didn't happen.
      toast("Couldn't copy - press and hold the link to copy it", "error");
    }
  }

  async function shareLink() {
    try {
      await navigator.share({ title: "Join our team", url: data.joinUrl });
    } catch {
      /* The share sheet was closed - nothing to report. */
    }
  }

  // Decided after mount: the server has no navigator, and a button that
  // appears only on the client would not match the server render.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator.share === "function");
  }, []);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Independent ${providers}`}
        subtitle={`They keep their own ${vocab.clientNounPlural}, bookings and payments. You see only what each one shares.`}
      />

      <div className="flex flex-col gap-5 px-5 py-5">
        {/* The one link. Everything else on this card starts with it. */}
        <div>
          <label
            htmlFor="team-link"
            className="text-sm font-medium text-offwhite"
          >
            Your team link
          </label>
          <p className="mt-0.5 text-xs text-muted">
            Text it to a {vocab.providerNoun}. They sign in with their own
            business and ask to join; you approve them here.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="team-link"
              readOnly
              value={data.joinUrl}
              onFocus={(e) => e.currentTarget.select()}
              data-qa="team-link"
              className="min-h-[40px] w-full min-w-0 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite outline-none focus:border-gold/50"
            />
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => void copyLink()}
                className={primary}
                data-qa="copy-team-link"
              >
                Copy link
              </button>
              {canShare && (
                <button
                  type="button"
                  onClick={() => void shareLink()}
                  className={quiet}
                >
                  Share
                </button>
              )}
            </div>
          </div>
        </div>

        {data.pending.length > 0 && (
          <section aria-labelledby="team-waiting">
            <h3 id="team-waiting" className="text-sm font-medium text-gold">
              Waiting for you ({data.pending.length})
            </h3>
            <ul className="mt-2 divide-y divide-subtle rounded-xl border border-subtle">
              {data.pending.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-offwhite">
                      {p.business.name}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {p.ownerName} · asked{" "}
                      {new Date(p.requestedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `approve:${p.id}`,
                          () => approveLinkAction(p.id),
                          `${p.business.name} is on your team`,
                          "Couldn't approve that - try again",
                        )
                      }
                      className={primary}
                      data-qa="approve-link"
                    >
                      {busy === `approve:${p.id}` ? "Approving…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `decline:${p.id}`,
                          () => endLinkAction(p.id),
                          "Request declined",
                          "Couldn't decline that - try again",
                        )
                      }
                      className={quiet}
                    >
                      {busy === `decline:${p.id}` ? "Declining…" : "Decline"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="team-list">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="team-list" className="text-sm font-medium text-offwhite">
              Your team
            </h3>
            {data.active.length > 0 && (
              <p className="text-xs text-muted">Last 30 days</p>
            )}
          </div>
          {data.active.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              No one yet. Send your team link to a {vocab.providerNoun} -
              they&apos;ll show up here to approve.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3">
              {data.active.map((m) => (
                <li
                  key={m.id}
                  className="rounded-xl border border-subtle p-4"
                  data-qa="team-member"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-offwhite">
                        {m.business.name}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {m.ownerName}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setRemoving(m)}
                      className="min-h-[40px] shrink-0 px-2 text-xs text-rose-300 transition-colors hover:text-rose-200 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {teamStats(m.numbers, vocab).map((s) => (
                      <div
                        key={s.key}
                        className="rounded-lg bg-charcoal-800/60 px-3 py-2"
                      >
                        <dt className="text-[11px] uppercase tracking-wide text-muted">
                          {s.label}
                        </dt>
                        <dd
                          className={cn(
                            "mt-0.5 text-sm tabular-nums",
                            s.value === null
                              ? "text-muted"
                              : "font-semibold text-offwhite",
                          )}
                        >
                          {s.value ?? "Hidden"}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <OwnerRent
                    linkId={m.id}
                    businessName={m.business.name}
                    rent={m.rent}
                    onRent={(rent) =>
                      setData((d) => ({
                        ...d,
                        active: d.active.map((x) =>
                          x.id === m.id ? { ...x, rent } : x,
                        ),
                      }))
                    }
                  />
                </li>
              ))}
            </ul>
          )}
          {data.active.length > 0 && (
            <p className="mt-2 text-[11px] text-muted/80">
              &ldquo;Hidden&rdquo; means that {vocab.providerNoun} hasn&apos;t
              shared it. Only they can change that.
            </p>
          )}
        </section>

        {(data.past ?? []).length > 0 && (
          // The rent record outlives the team link: what's owed, paid and
          // corrected stays, and can still be settled. Nothing else of their
          // business is here, and rent can't be started again from here.
          <section data-qa="past-rent">
            <h3 className="text-sm font-medium text-offwhite">
              Past booth rent
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              Rent stopped when they left. You can still record a late
              payment or void a mistake.
            </p>
            <ul className="mt-2 flex flex-col gap-2">
              {data.past.map((m) => (
                <li
                  key={m.id}
                  className="rounded-lg border border-subtle px-4 py-3"
                >
                  <p className="text-sm text-offwhite">{m.business.name}</p>
                  <p className="text-xs text-muted">
                    {m.status === "PENDING"
                      ? "Asking to rejoin"
                      : `Left ${m.endedAt ? new Date(m.endedAt).toLocaleDateString() : "the team"}`}
                  </p>
                  <OwnerRent
                    linkId={m.id}
                    businessName={m.business.name}
                    rent={m.rent}
                    ended
                    onRent={(rent) =>
                      setData((d) => ({
                        ...d,
                        past: d.past.map((x) => (x.id === m.id ? { ...x, rent } : x)),
                      }))
                    }
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.business.name}?` : "Remove"}
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRemoving(null)}
              className={quiet}
            >
              Keep
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                const m = removing;
                if (!m) return;
                setRemoving(null);
                void act(
                  m.id,
                  () => endLinkAction(m.id),
                  `${m.business.name} is off your team`,
                  "Couldn't remove them - try again",
                );
              }}
              className="min-h-[40px] rounded-full bg-rose-500/90 px-4 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
            >
              Remove from team
            </button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          They stop sharing numbers with you. Their business,{" "}
          {vocab.clientNounPlural} and bookings are theirs and stay exactly as
          they are. They can ask to join again with your link.
          {removing && hasRent(removing.rent)
            ? " Booth rent stops at the end of the current period; what's recorded stays under Past booth rent, where you can still settle it."
            : ""}
        </p>
      </Dialog>
    </Card>
  );
}
