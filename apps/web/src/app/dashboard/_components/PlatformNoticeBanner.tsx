"use client";

import { useState } from "react";
import { PLATFORM_NOTICE_SEVERITY_LABEL } from "@chairback/config/platformNotices";
import type { PlatformNotice } from "@/lib/platformNotices";
import { LocalDate } from "@/components/ui/LocalDate";
import { dismissPlatformNoticeAction } from "./platformNoticeActions";

/**
 * "We know about it and we're fixing it" - the platform's status notices, at
 * the top of every dashboard page (owners and staff alike) while they are live.
 *
 * A barber asked for this: when something is broken or being worked on, say
 * so, instead of leaving them to wonder whether it is their phone. The
 * platform owner posts them from the admin portal.
 *
 * Closing one is per PERSON and remembered on the account (every device);
 * a NEW notice shows again. A fixed notice turns into a short green "Fixed"
 * line for a few hours, then the API stops sending it.
 *
 * Fails quiet by construction: the layout fetches the list and an empty list
 * (or a failed fetch, which becomes one) renders nothing at all.
 */

const TIME: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit" };

/** Theme tokens only: a raw palette class would not flip with the theme. */
const TONE = {
  issue: { box: "border-danger-soft/40 bg-danger-soft/10", accent: "text-danger-soft" },
  maintenance: { box: "border-warning-soft/40 bg-warning-soft/10", accent: "text-warning-soft" },
  info: { box: "border-info-soft/30 bg-info-soft/10", accent: "text-info-soft" },
  resolved: { box: "border-emerald-soft/40 bg-emerald-soft/10", accent: "text-emerald-soft" },
} as const;

export function PlatformNoticeBanner({
  notices,
  demo = false,
}: {
  notices: PlatformNotice[];
  /** The read-only demo session: closing hides it here, nothing is saved. */
  demo?: boolean;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const shown = notices.filter((n) => !n.dismissed && !closed.has(n.id));
  if (shown.length === 0) return null;

  function dismiss(id: string) {
    // Gone at once; the save is best-effort - if it fails, the banner simply
    // comes back on the next page load.
    setClosed((prev) => new Set(prev).add(id));
    if (demo) return;
    void dismissPlatformNoticeAction(id).catch(() => {});
  }

  return (
    <section aria-label="Service notices" className="mx-auto mt-3 flex w-full max-w-6xl flex-col gap-2 px-4">
      {shown.map((n) => {
        const fixed = n.state === "resolved";
        const tone = fixed ? TONE.resolved : (TONE[n.severity] ?? TONE.info);
        const label = fixed ? "Fixed" : (PLATFORM_NOTICE_SEVERITY_LABEL[n.severity] ?? "Notice");
        return (
          <div
            key={n.id}
            role="status"
            data-qa="platform-notice"
            data-severity={n.severity}
            data-state={n.state}
            className={`flex items-start gap-3 rounded-2xl border px-4 py-2.5 ${tone.box}`}
          >
            <NoticeMark fixed={fixed} severity={n.severity} className={`mt-0.5 h-4 w-4 shrink-0 ${tone.accent}`} />
            {/* min-w-0 so a long title wraps instead of widening the page at 320px. */}
            <div className="min-w-0 flex-1 text-xs sm:text-sm">
              <p className="[overflow-wrap:anywhere]">
                <span className={`mr-1.5 font-semibold uppercase tracking-wide ${tone.accent}`}>{label}</span>
                <span className="font-medium text-offwhite">{n.title}</span>
              </p>
              {fixed ? (
                <p className="mt-0.5 text-muted">This is sorted now. Thanks for bearing with us.</p>
              ) : (
                <p className="mt-0.5 whitespace-pre-line text-muted [overflow-wrap:anywhere]">{n.body}</p>
              )}
              {!fixed && n.endsAt && (
                <p className="mt-0.5 text-muted">
                  Expected until <LocalDate iso={n.endsAt} options={TIME} />
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(n.id)}
              aria-label={`Close notice: ${n.title}`}
              data-qa="platform-notice-dismiss"
              className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
    </section>
  );
}

/** Check for fixed, clock for planned work, warning for an issue, "i" for news. */
export function NoticeMark({
  fixed,
  severity,
  className,
}: {
  fixed: boolean;
  severity: PlatformNotice["severity"];
  className?: string;
}) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (fixed) {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 3 3 5-6" />
      </svg>
    );
  }
  if (severity === "issue") {
    return (
      <svg {...common}>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
    );
  }
  if (severity === "maintenance") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  );
}
