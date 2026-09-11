"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";
import { useToast } from "@/components/ui/Toast";
import { dismissDuplicatesAction, mergeClientAction } from "../../actions";

export interface DuplicateClientView {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  completedVisits: number;
  lastVisitAt: string | null;
  createdAt: string;
}

export interface DuplicateGroupView {
  key: string;
  matchedOn: ("phone" | "email")[];
  clients: DuplicateClientView[];
}

const MATCH_LABEL: Record<string, string> = {
  phone: "Same phone number",
  email: "Same email",
  "phone,email": "Same phone number and email",
};

const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/**
 * The duplicates review. Each group is clients who share a phone or email; the
 * barber picks the record to keep, chooses which others fold into it, and
 * merges - or says they're different people. Rendered straight from props (the
 * page refreshes after every action), with per-group state keyed by the group's
 * membership so a changed group starts fresh.
 */
export function DuplicateReview({ groups }: { groups: DuplicateGroupView[] }) {
  if (groups.length === 0) {
    return (
      <Card className="overflow-hidden">
        <p className="px-5 py-8 text-center text-sm text-muted">
          No possible duplicates. Clients who share a phone number or email will show up here.
        </p>
      </Card>
    );
  }
  return (
    <ul className="flex flex-col gap-4">
      {groups.map((g) => (
        <li key={g.key}>
          <DuplicateGroupCard group={g} />
        </li>
      ))}
    </ul>
  );
}

function visitsLine(c: DuplicateClientView) {
  if (c.completedVisits === 0) {
    return (
      <>
        No visits yet · added <LocalDate iso={c.createdAt} options={DATE} />
      </>
    );
  }
  return (
    <>
      {c.completedVisits} {c.completedVisits === 1 ? "visit" : "visits"}
      {c.lastVisitAt && (
        <>
          {" "}
          · last <LocalDate iso={c.lastVisitAt} options={DATE} />
        </>
      )}
    </>
  );
}

function DuplicateGroupCard({ group }: { group: DuplicateGroupView }) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The server lists the suggested record to keep first.
  const [keepId, setKeepId] = useState(group.clients[0]!.id);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const keep = group.clients.find((c) => c.id === keepId) ?? group.clients[0]!;
  const toMerge = group.clients.filter((c) => c.id !== keep.id && !unchecked.has(c.id));
  const matchLabel = MATCH_LABEL[group.matchedOn.join(",")] ?? "Same contact details";

  function toggle(id: string) {
    setConfirming(false);
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function merge() {
    const reason = `Duplicates review: ${matchLabel.toLowerCase()}`;
    startTransition(async () => {
      let merged = 0;
      let refusal: string | undefined;
      for (const c of toMerge) {
        const r = await mergeClientAction(keep.id, c.id, reason);
        if (!r.ok) {
          refusal = r.error;
          break;
        }
        merged++;
      }
      if (merged === toMerge.length) {
        toast(
          merged === 1
            ? `Merged ${toMerge[0]!.name} into ${keep.name}`
            : `Merged ${merged} records into ${keep.name}`,
          "success",
        );
      } else {
        // Say WHICH refusal. Somebody here already answered this question, and
        // "couldn't merge" invites them to try again on something that will
        // never work.
        toast(
          refusal === "marked_different_people"
            ? "These were marked as different people, so they can't be merged."
            : merged === 0
              ? "Couldn't merge those clients."
              : `Merged ${merged} of ${toMerge.length}. The rest are still here to try again.`,
          "error",
        );
      }
      setConfirming(false);
      router.refresh();
    });
  }

  function dismiss() {
    startTransition(async () => {
      const r = await dismissDuplicatesAction(group.clients.map((c) => c.id));
      if (r.ok) {
        toast("Marked as different people", "success");
        router.refresh();
      } else {
        toast("Couldn't save that. Try again.", "error");
      }
    });
  }

  return (
    <Card className="overflow-hidden">
      <fieldset disabled={pending} className="min-w-0">
        <legend className="sr-only">
          {matchLabel}: {group.clients.map((c) => c.name).join(", ")}
        </legend>
        <p className="border-b border-subtle px-4 py-2.5 text-xs text-muted sm:px-5">{matchLabel}</p>
        <ul className="divide-y divide-subtle">
          {group.clients.map((c) => {
            const isKeep = c.id === keep.id;
            return (
              <li key={c.id} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
                <input
                  type="radio"
                  name={`keep-${group.key}`}
                  checked={isKeep}
                  onChange={() => {
                    setKeepId(c.id);
                    setConfirming(false);
                  }}
                  className="mt-1 h-5 w-5 shrink-0 accent-gold"
                  aria-label={`Keep ${c.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <Link
                      href={`/dashboard/clients/${c.id}`}
                      className="truncate text-sm font-medium text-offwhite underline-offset-2 hover:underline"
                    >
                      {c.name}
                    </Link>
                    {isKeep && <span className="text-xs text-gold">Keep</span>}
                  </div>
                  <p className="truncate text-xs text-muted">
                    {[c.phone, c.email].filter(Boolean).join(" · ") || "No contact details"}
                  </p>
                  <p className="text-xs text-muted">{visitsLine(c)}</p>
                </div>
                {!isKeep && (
                  <label className="flex shrink-0 cursor-pointer items-center gap-2 py-1 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={!unchecked.has(c.id)}
                      onChange={() => toggle(c.id)}
                      className="h-5 w-5 accent-gold"
                    />
                    Merge
                  </label>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex flex-col gap-3 border-t border-subtle px-4 py-3 sm:px-5">
          {confirming ? (
            <>
              <p className="text-sm text-offwhite">
                Merge {toMerge.map((c) => c.name).join(", ")} into{" "}
                <span className="text-gold">{keep.name}</span>? Their visits, appointments and
                punches move to {keep.name}, and {toMerge.length === 1 ? "the other record is" : "the other records are"}{" "}
                archived.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={merge}
                  className="rounded-full bg-gold px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
                >
                  {pending ? "Merging…" : "Yes, merge"}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite disabled:opacity-50"
                >
                  Back
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setConfirming(true)}
                disabled={toMerge.length === 0}
                className="rounded-full bg-gold px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
              >
                {toMerge.length <= 1
                  ? `Merge into ${keep.name}`
                  : `Merge ${toMerge.length} into ${keep.name}`}
              </button>
              <button
                onClick={dismiss}
                className="rounded-full border border-subtle px-4 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
              >
                {group.clients.length === 2 ? "Not the same person" : "None of these are the same"}
              </button>
            </div>
          )}
        </div>
      </fieldset>
    </Card>
  );
}
