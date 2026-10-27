"use client";

import { useRef, useState, type FormEvent } from "react";
import {
  PLATFORM_NOTICE_BODY_MAX,
  PLATFORM_NOTICE_SEVERITIES,
  PLATFORM_NOTICE_SEVERITY_LABEL,
  PLATFORM_NOTICE_TITLE_MAX,
  type PlatformNoticeSeverity,
} from "@chairback/config/platformNotices";
import { Card } from "@/components/ui/Card";
import { LocalDate } from "@/components/ui/LocalDate";
import {
  createPlatformNoticeAction,
  deletePlatformNoticeAction,
  resolvePlatformNoticeAction,
  updatePlatformNoticeAction,
  type NoticeResult,
} from "./actions";

/** GET /api/admin-portal/notices (routes/adminPortal.notices.ts). */
export interface AdminNotice {
  id: string;
  title: string;
  body: string;
  severity: PlatformNoticeSeverity;
  state: "scheduled" | "active" | "resolved" | "ended";
  startsAt: string;
  endsAt: string | null;
  resolvedAt: string | null;
  pushedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATE_LABEL: Record<AdminNotice["state"], string> = {
  active: "Live",
  scheduled: "Scheduled",
  resolved: "Showing as Fixed",
  ended: "Ended",
};

const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** ISO -> the value a datetime-local input wants, in THIS browser's zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value is wall time in this browser's zone; send an instant. */
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function pushLine(push: string | undefined): string | null {
  switch (push) {
    case "sending":
      return "Sending one notification to every shop owner's phone.";
    case "dry_run":
      return "Phones were NOT notified: notifications are in test mode (DRY_RUN is on).";
    case "already_sent":
      return "Phones were already notified for this notice, so nothing was sent again.";
    case "resolved":
      return "A fixed notice doesn't notify phones.";
    default:
      return null;
  }
}

function errorLine(error: string | undefined): string {
  if (error === "invalid_window") return "The end has to be after the start. Nothing was saved.";
  if (error === "invalid_input") return "Check the title and message. Nothing was saved.";
  return "Couldn't save. Nothing changed.";
}

interface Draft {
  title: string;
  body: string;
  severity: PlatformNoticeSeverity;
  startsAt: string;
  endsAt: string;
  notifyPhones: boolean;
}

const EMPTY: Draft = { title: "", body: "", severity: "issue", startsAt: "", endsAt: "", notifyPhones: false };

/**
 * PLATFORM NOTICES - "we know about it and we're fixing it".
 *
 * What is posted here shows as a banner at the top of EVERY barber's
 * dashboard (owners and staff) and in their bell, while it is live. Ticking
 * "notify phones" also sends ONE push to every shop owner's phone - the API
 * stamps it, so a notice can never buzz anyone twice. Resolving it turns the
 * banner into a short green "Fixed" line for a few hours.
 *
 * The list is read straight from props: every action revalidates /admin, so
 * the server hands back the fresh list - no local copy to drift out of sync.
 */
export function NoticesSection({ notices }: { notices: AdminNotice[] }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<AdminNotice | null>(null);
  const [pending, setPending] = useState(false);
  // A ref latch, not just `disabled`: two taps inside one handler both land
  // before any re-render, and this one can push to phones.
  const busy = useRef(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function run(fn: () => Promise<NoticeResult>, done: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const r = await fn();
      if (r.ok) {
        setOutcome({ ok: true, text: [done, pushLine(r.push)].filter(Boolean).join(" ") });
      } else {
        setOutcome({ ok: false, text: errorLine(r.error) });
      }
      return r.ok;
    } catch {
      setOutcome({ ok: false, text: "Couldn't save. Nothing changed." });
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const base = {
      title: draft.title.trim(),
      body: draft.body.trim(),
      severity: draft.severity,
      endsAt: fromLocalInput(draft.endsAt),
      ...(draft.notifyPhones ? { notifyPhones: true } : {}),
    };
    const startsAt = fromLocalInput(draft.startsAt);
    const ok = editing
      ? await run(
          () => updatePlatformNoticeAction(editing.id, { ...base, ...(startsAt ? { startsAt } : {}) }),
          "Saved.",
        )
      : await run(
          () => createPlatformNoticeAction({ ...base, ...(startsAt ? { startsAt } : {}) }),
          "Posted. Every dashboard shows it now.",
        );
    if (ok) {
      setDraft(EMPTY);
      setEditing(null);
    }
  }

  function startEdit(n: AdminNotice) {
    setEditing(n);
    setOutcome(null);
    setDraft({
      title: n.title,
      body: n.body,
      severity: n.severity,
      startsAt: toLocalInput(n.startsAt),
      endsAt: toLocalInput(n.endsAt),
      notifyPhones: false,
    });
  }

  const alreadyPushed = Boolean(editing?.pushedAt);
  const input =
    "w-full rounded-xl border border-subtle bg-charcoal-800/60 px-3 py-2 text-sm text-offwhite placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold";

  return (
    <section aria-labelledby="notices-heading">
      <h2 id="notices-heading" className="mb-1 mt-10 font-display text-lg">
        Service notices
      </h2>
      <p className="mb-3 text-sm text-muted">
        Tell every shop when something is broken or being worked on. It shows at the top of every dashboard and in the bell.
      </p>
      <Card className="p-4">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3" data-qa="notice-form">
          <p className="text-sm font-medium">{editing ? "Edit notice" : "Post a notice"}</p>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Title
            <input
              className={input}
              value={draft.title}
              maxLength={PLATFORM_NOTICE_TITLE_MAX}
              required
              placeholder="Texts are delayed"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              data-qa="notice-title"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Message
            <textarea
              className={`${input} min-h-[5rem]`}
              value={draft.body}
              maxLength={PLATFORM_NOTICE_BODY_MAX}
              required
              placeholder="We know about it and we're fixing it. Your bookings are safe."
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              data-qa="notice-body"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              Kind
              <select
                className={input}
                value={draft.severity}
                onChange={(e) => setDraft({ ...draft, severity: e.target.value as PlatformNoticeSeverity })}
                data-qa="notice-severity"
              >
                {PLATFORM_NOTICE_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {PLATFORM_NOTICE_SEVERITY_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Starts (empty = now)
              <input
                type="datetime-local"
                className={input}
                value={draft.startsAt}
                onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              Ends (empty = until resolved)
              <input
                type="datetime-local"
                className={input}
                value={draft.endsAt}
                onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
              />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={draft.notifyPhones}
              disabled={alreadyPushed}
              onChange={(e) => setDraft({ ...draft, notifyPhones: e.target.checked })}
              data-qa="notice-notify"
            />
            <span>
              {alreadyPushed
                ? "Phones were already notified for this notice."
                : "Also send ONE notification to every shop owner's phone, now (only once per notice)."}
            </span>
          </label>
          {outcome && (
            <p
              role="status"
              data-qa="notice-outcome"
              className={`text-sm ${outcome.ok ? "text-offwhite" : "text-danger-soft"}`}
            >
              {outcome.text}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              data-qa="notice-submit"
              className="h-10 flex-1 rounded-xl bg-gold px-4 text-xs font-semibold text-charcoal-900 transition-opacity duration-150 disabled:opacity-60 sm:flex-none"
            >
              {pending ? "Saving…" : editing ? "Save changes" : "Post notice"}
            </button>
            {editing && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setEditing(null);
                  setDraft(EMPTY);
                }}
                className="h-10 rounded-xl border border-subtle px-4 text-xs text-muted"
              >
                Cancel
              </button>
            )}
          </div>
        </form>

        {notices.length > 0 && (
          <ul className="mt-5 flex flex-col divide-y divide-subtle border-t border-subtle" data-qa="notice-list">
            {notices.map((n) => (
              <li key={n.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm [overflow-wrap:anywhere]">
                    <span className="mr-2 rounded-full bg-charcoal-700 px-2 py-0.5 text-xs text-offwhite">
                      {STATE_LABEL[n.state]}
                    </span>
                    <span className="mr-1.5 text-xs uppercase tracking-wide text-muted">
                      {PLATFORM_NOTICE_SEVERITY_LABEL[n.severity]}
                    </span>
                    <span className="font-medium text-offwhite">{n.title}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted [overflow-wrap:anywhere]">{n.body}</p>
                  <p className="mt-1 text-xs text-muted">
                    From <LocalDate iso={n.startsAt} options={WHEN} />
                    {n.endsAt && (
                      <>
                        {" "}until <LocalDate iso={n.endsAt} options={WHEN} />
                      </>
                    )}
                    {n.resolvedAt && (
                      <>
                        {" "}· fixed <LocalDate iso={n.resolvedAt} options={WHEN} />
                      </>
                    )}
                    {n.pushedAt ? " · phones notified" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => startEdit(n)}
                    className="h-9 rounded-xl border border-subtle px-3 text-xs text-muted"
                  >
                    Edit
                  </button>
                  {!n.resolvedAt && (
                    <button
                      type="button"
                      disabled={pending}
                      data-qa="notice-resolve"
                      onClick={() => void run(() => resolvePlatformNoticeAction(n.id), "Marked fixed.")}
                      className="h-9 rounded-xl border border-subtle px-3 text-xs text-offwhite"
                    >
                      Mark resolved
                    </button>
                  )}
                  {confirmDelete === n.id ? (
                    <button
                      type="button"
                      disabled={pending}
                      data-qa="notice-delete-confirm"
                      onClick={() => {
                        setConfirmDelete(null);
                        void run(() => deletePlatformNoticeAction(n.id), "Deleted. It's gone from every dashboard.");
                      }}
                      className="h-9 rounded-xl border border-danger-soft/50 px-3 text-xs text-danger-soft"
                    >
                      Delete for good
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      data-qa="notice-delete"
                      onClick={() => setConfirmDelete(n.id)}
                      className="h-9 rounded-xl border border-subtle px-3 text-xs text-muted"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
