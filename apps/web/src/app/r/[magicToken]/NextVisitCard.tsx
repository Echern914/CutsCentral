"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { untilLabel } from "@chairback/config/relativeTime";
import { surfaceStyle, type RewardsTheme } from "./theme";

/** Same universal green the rebook countdown uses for "booked": it reads as
 *  its meaning on any shop theme, where the accent might be anything. */
const SUCCESS = "#10b981";

export interface NextVisit {
  startsAt: string; // ISO
  serviceName: string | null;
  staffName: string | null;
  /** Present for a ChairBack booking; null for one synced from Acuity. */
  manageToken: string | null;
  timezone: string;
  address: string | null;
  mapsUrl: string | null;
  /**
   * Set when this visit was booked with others, such as a parent's two or three
   * kids, and at least two are still ahead. Optional: an API older than this page
   * omits it. The token opens the page that moves or cancels the whole party.
   */
  party?: {
    manageToken: string;
    members: { firstName: string; serviceName: string | null; startsAt: string }[];
  } | null;
}

/** "Mia, Leo and Sam", each name once: one person can hold several seats in a run. */
function joinNames(names: string[]): string {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length < 2) return unique[0] ?? "";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

/**
 * The card someone opens the app for: their next appointment - how long until
 * it, when exactly, what, with whom, where, and the way to change it.
 *
 * Every fact here is the SAME fact the confirmation email and the manage page
 * show, from the same shared helpers (`untilLabel`, the address formatter on
 * the API), so the app can never disagree with the message that brought the
 * customer here.
 *
 * Live clock math cannot render on the server - the SSR HTML and the client's
 * first paint would differ - so the countdown appears after mount and re-reads
 * every minute. The date line is stable and renders immediately.
 */
export function NextVisitCard({ visit, theme }: { visit: NextVisit; theme: RewardsTheme }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const startsAt = new Date(visit.startsAt);
  const until = now ? untilLabel(startsAt, now, visit.timezone) : null;
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: visit.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(startsAt);
  const party = visit.party ?? null;
  // A party's services are listed per person below, so this line only says who with.
  const what = [party ? null : visit.serviceName, visit.staffName ? `with ${visit.staffName}` : null]
    .filter(Boolean)
    .join(" · ");
  const memberTime = new Intl.DateTimeFormat("en-US", {
    timeZone: visit.timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const heading = party ? "Your next appointments" : "Your next appointment";

  return (
    <section
      aria-label={heading}
      className="p-5"
      style={{ ...surfaceStyle(theme), borderColor: `${SUCCESS}4D` }}
    >
      <p className="text-xs uppercase tracking-[0.18em]" style={{ color: SUCCESS }}>
        {heading}
      </p>
      {/* min-h keeps the card from jumping when the countdown lands after mount. */}
      <p className="mt-1 min-h-8 font-display text-2xl leading-tight" data-qa="until">
        {until ? until[0]!.toUpperCase() + until.slice(1) : " "}
      </p>
      <p className="mt-1 text-sm">{party ? `${party.members.length} appointments · ${when}` : when}</p>
      {what && (
        <p className="mt-0.5 text-sm" style={{ color: theme.muted }}>
          {what}
        </p>
      )}
      {party && (
        <details className="group mt-3 text-sm">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 font-medium">
              {joinNames(party.members.map((m) => m.firstName)) || "See each appointment"}
            </span>
            <span aria-hidden className="shrink-0 transition-transform group-open:rotate-180" style={{ color: theme.muted }}>
              ▾
            </span>
          </summary>
          <ul className="mt-1">
            {party.members.map((m) => (
              <li
                key={`${m.startsAt}-${m.firstName}`}
                className="flex items-baseline justify-between gap-3 border-t py-2"
                style={{ borderColor: theme.border }}
              >
                <span className="min-w-0">
                  <span className="block">{m.firstName}</span>
                  {m.serviceName && (
                    <span className="block" style={{ color: theme.muted }}>
                      {m.serviceName}
                    </span>
                  )}
                </span>
                <span className="shrink-0" style={{ color: theme.muted }}>
                  {memberTime.format(new Date(m.startsAt))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {visit.address && (
        <p className="mt-3 text-sm">
          <span className="mr-2 text-xs uppercase tracking-[0.14em]" style={{ color: theme.muted }}>
            Where
          </span>
          {visit.mapsUrl ? (
            <a
              href={visit.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-current/40 underline-offset-4"
            >
              {visit.address}
            </a>
          ) : (
            visit.address
          )}
        </p>
      )}
      {party ? (
        <Link
          href={`/book/group/${party.manageToken}`}
          className="mt-4 inline-block rounded-full border px-4 py-2 text-sm font-medium"
          style={{ borderColor: theme.border, color: theme.accent }}
        >
          Manage appointments
        </Link>
      ) : (
        visit.manageToken && (
          <Link
            href={`/book/manage/${visit.manageToken}`}
            className="mt-4 inline-block rounded-full border px-4 py-2 text-sm font-medium"
            style={{ borderColor: theme.border, color: theme.accent }}
          >
            Manage appointment
          </Link>
        )
      )}
    </section>
  );
}
