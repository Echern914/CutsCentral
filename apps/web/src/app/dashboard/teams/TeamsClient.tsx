"use client";

import { useState } from "react";
import type { BusinessVocabulary } from "@chairback/config";
import { Card, CardHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  SHARE_KEYS,
  teamStats,
  type ShareKey,
  type Sharing,
  type TeamNumbers,
} from "@/lib/teamNumbers";
import { hasRent, type RentSummary } from "@/lib/boothRent";
import { MemberRent } from "../team/BoothRent";
import { leaveTeamAction, myRentHistoryAction, myTeamsAction, setSharingAction } from "./actions";

export interface MyTeamLink {
  id: string;
  status: "PENDING" | "ACTIVE";
  requestedAt: string;
  approvedAt: string | null;
  team: { name: string };
  sharing: Sharing;
  /** Exactly what the team's owner sees now. Null until they approve. */
  theySee: TeamNumbers | null;
  /** Their booth rent with this team (ACTIVE only). */
  rent: RentSummary | null;
}

export interface MyTeamsData {
  business: { id: string; name: string } | null;
  links: MyTeamLink[];
}

/** What each switch shares, in plain words. */
function shareHint(key: ShareKey, v: BusinessVocabulary): string {
  switch (key) {
    case "shareCuts":
      return `How many ${v.serviceNounPlural} you did in the last 30 days`;
    case "shareRevenue":
      return "What you earned in the last 30 days";
    case "shareClients":
      return `How many different ${v.clientNounPlural} you saw in the last 30 days`;
    case "shareRating":
      return "Your star rating from reviews";
  }
}

const NOTHING: TeamNumbers = { cuts: null, revenueCents: null, clients: null, rating: null };

/**
 * A barber's own teams: what each shop may see, a preview of exactly what it
 * does see, and the way out.
 *
 * 🔴 NOTHING HERE IS OPTIMISTIC. A privacy switch that shows "Off" before the
 * server agrees would tell a barber their revenue is hidden when it isn't. A
 * switch reads "Saving…" until the server answers, then shows what the server
 * says - and the preview is the server's own answer too.
 */
export function TeamsClient({
  initial,
  vocab,
}: {
  initial: MyTeamsData;
  vocab: BusinessVocabulary;
}) {
  const { toast } = useToast();
  const [data, setData] = useState(initial);
  /** `${linkId}:${key}` of the switch being saved, or null. */
  const [saving, setSaving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<MyTeamLink | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);

  async function flip(link: MyTeamLink, key: ShareKey) {
    setSaving(`${link.id}:${key}`);
    const res = await setSharingAction(link.id, { [key]: !link.sharing[key] });
    if (res.ok && res.sharing) {
      setData((d) => ({
        ...d,
        links: d.links.map((l) =>
          l.id === link.id ? { ...l, sharing: res.sharing!, theySee: res.theySee ?? null } : l,
        ),
      }));
    } else {
      toast(
        res.error === "not_found"
          ? "That team link has ended - refresh to see your teams"
          : "Couldn't save that - nothing changed",
        "error",
      );
    }
    setSaving(null);
  }

  async function leave(link: MyTeamLink) {
    setLeaveBusy(true);
    const res = await leaveTeamAction(link.id);
    setLeaveBusy(false);
    if (!res.ok && res.error !== "not_found") {
      toast("Couldn't leave - try again", "error");
      return;
    }
    setLeaving(null);
    // Say it's done only once a fresh read agrees (a 404 means it had already
    // ended - on another device, or the owner removed them).
    const fresh = await myTeamsAction();
    if (fresh) setData(fresh);
    const gone = fresh ? !fresh.links.some((l) => l.id === link.id) : res.ok;
    if (gone) {
      toast(
        link.status === "PENDING" ? "Request withdrawn" : `You left ${link.team.name}'s team`,
        "success",
      );
    } else {
      toast("Couldn't confirm that - refresh to check", "error");
    }
  }

  if (!data.business) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-display text-2xl">Teams</h1>
        <Card className="p-5">
          <p className="text-sm text-muted">
            Teams are for {vocab.providerNounPlural} who run their own business on ChairBack.
            Set up your business first, then open the shop&apos;s team link again.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl">Teams</h1>
        <p className="mt-1 text-sm text-muted">
          {data.business.name} stays yours: your {vocab.clientNounPlural}, bookings and payments
          never move. A team only sees what you turn on here.
        </p>
      </div>

      {data.links.length === 0 && (
        <Card className="p-5">
          <p className="text-sm text-offwhite">You&apos;re not on a team.</p>
          <p className="mt-1 text-sm text-muted">
            When a shop owner sends you their team link, open it to ask to join.
          </p>
        </Card>
      )}

      {data.links.map((link) => {
        const active = link.status === "ACTIVE";
        const stats = teamStats(link.theySee ?? NOTHING, vocab);
        return (
          <Card key={link.id} className="overflow-hidden">
            <CardHeader
              title={link.team.name}
              subtitle={
                active
                  ? `On the team${link.approvedAt ? ` since ${new Date(link.approvedAt).toLocaleDateString()}` : ""}`
                  : "Waiting for the owner to approve you"
              }
            />
            <div className="px-5 py-4">
              <p className="text-sm font-medium text-offwhite">What {link.team.name} can see</p>
              <ul className="mt-1 divide-y divide-subtle">
                {SHARE_KEYS.map((key) => {
                  const on = link.sharing[key];
                  const isSaving = saving === `${link.id}:${key}`;
                  const label = stats.find((s) => s.key === key)!.label;
                  return (
                    <li key={key} className="flex items-center justify-between gap-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm text-offwhite">{label}</p>
                        <p className="text-xs text-muted">{shareHint(key, vocab)}</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`Share ${label} with ${link.team.name}`}
                        disabled={saving !== null}
                        onClick={() => void flip(link, key)}
                        data-qa={`share-${key}`}
                        className={cn(
                          "min-h-[40px] min-w-[72px] shrink-0 rounded-full px-4 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-60",
                          on && !isSaving
                            ? "bg-emerald-soft/15 text-emerald-soft"
                            : "border border-subtle text-muted hover:bg-charcoal-700",
                        )}
                      >
                        {isSaving ? "Saving…" : on ? "Shared" : "Hidden"}
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mt-3 rounded-xl bg-charcoal-800/60 px-4 py-3" aria-live="polite">
                <p className="text-[11px] uppercase tracking-wide text-muted">
                  {active ? "What they see right now" : "What they'll see once approved"}
                </p>
                {active ? (
                  <p className="mt-1 text-sm text-offwhite" data-qa="they-see">
                    {stats.map((s) => `${s.label} ${s.value ?? "hidden"}`).join(" · ")}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-muted">
                    Nothing until they approve you - then only what&apos;s shared above.
                  </p>
                )}
              </div>

              {active && link.rent && (
                <MemberRent
                  teamName={link.team.name}
                  rent={link.rent}
                  loadHistory={() => myRentHistoryAction(link.id)}
                />
              )}

              {/* Left-aligned: on a phone the floating help button sits
                  bottom-right and would cover it at the end of the page. */}
              <div className="mt-4 flex justify-start">
                <button
                  type="button"
                  onClick={() => setLeaving(link)}
                  className="min-h-[40px] px-2 text-xs text-rose-300 transition-colors hover:text-rose-200"
                >
                  {active ? "Leave team" : "Withdraw request"}
                </button>
              </div>
            </div>
          </Card>
        );
      })}

      <Dialog
        open={leaving !== null}
        onClose={() => (leaveBusy ? undefined : setLeaving(null))}
        title={
          leaving?.status === "PENDING"
            ? "Withdraw your request?"
            : `Leave ${leaving?.team.name ?? "this"} team?`
        }
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={leaveBusy}
              onClick={() => setLeaving(null)}
              className="min-h-[40px] rounded-full border border-subtle px-4 text-xs text-muted transition-colors hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-50"
            >
              Stay
            </button>
            <button
              type="button"
              disabled={leaveBusy}
              onClick={() => leaving && void leave(leaving)}
              className="min-h-[40px] rounded-full bg-rose-500/90 px-4 text-xs font-semibold text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
            >
              {leaveBusy ? "Leaving…" : leaving?.status === "PENDING" ? "Withdraw" : "Leave team"}
            </button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          They stop seeing your numbers right away. Your {vocab.clientNounPlural}, bookings and
          payments stay exactly as they are. You can ask to join again with their link.
          {leaving?.rent && hasRent(leaving.rent)
            ? " Booth rent stops at the end of the current period; what's recorded is kept."
            : ""}
        </p>
      </Dialog>
    </div>
  );
}
