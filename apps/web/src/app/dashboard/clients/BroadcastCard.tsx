"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { useVocab } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";
import {
  listBroadcastsAction,
  previewBroadcastAction,
  sendBroadcastAction,
  type BroadcastChannel,
  type BroadcastPreview,
  type BroadcastRow,
  type LoyaltyTierKey,
} from "./broadcastActions";

/**
 * ONE MESSAGE TO MANY CLIENTS.
 *
 * 🔴 THE NUMBER IS THE POINT. Before anything is sent, this says exactly how
 * many people will receive it out of how many were considered, and names every
 * exclusion - "1,900 have no email address" is a fact the barber can act on,
 * where a blast that quietly reaches a third of who he pictured is how a shop
 * concludes the feature is broken.
 *
 * 🔴 AND THE SECOND NUMBER IS THE POINT TOO. Pressing send does not deliver
 * anything: it freezes the audience and queues it. So this says "Queued for
 * 412" and then SHOWS THE PROGRESS, rather than claiming "they'll get it in a
 * minute or two" - which was a promise about the future dressed as a receipt,
 * and which a barber watching nothing happen would answer by pressing send
 * again.
 *
 * 🔴 TWO CHANNELS, AND THE COST IS SAID OUT LOUD. App notifications are free
 * and unmetered. Email is metered because it costs money, and the remaining
 * allowance is on screen BEFORE the send rather than in a refusal afterwards.
 * There is deliberately no SMS option: a text to a whole client book would
 * empty a month's texting allowance in one tap.
 */

const CHANNELS: { value: BroadcastChannel; label: string; hint: string }[] = [
  { value: "push", label: "App notification", hint: "Free · anyone who installed the app" },
  { value: "email", label: "Email", hint: "Counts against your monthly allowance" },
];

const TIERS: { value: LoyaltyTierKey; label: string }[] = [
  { value: "GOLD", label: "Gold" },
  { value: "SILVER", label: "Silver" },
  { value: "BRONZE", label: "Bronze" },
];

/**
 * What fits, per channel. Mirrors BODY_LIMITS/SUBJECT_LIMITS in the API - the
 * server is the authority and refuses in words, this is what stops the barber
 * writing four paragraphs before finding out.
 *
 * A phone truncates a notification somewhere around 150-240 characters, so a
 * 4,000-character push is four paragraphs the customer never sees, with the
 * offer cut off mid-word.
 */
const FALLBACK_LIMITS: Record<BroadcastChannel, { subject: number; body: number }> = {
  email: { subject: 120, body: 4000 },
  push: { subject: 60, body: 300 },
};

const IN_FLIGHT = new Set(["QUEUED", "SENDING"]);

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

export function BroadcastCard() {
  const { toast } = useToast();
  const vocab = useVocab();
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState<BroadcastChannel>("push");
  const [tiers, setTiers] = useState<LoyaltyTierKey[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<BroadcastRow[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const limits = preview?.limits ?? FALLBACK_LIMITS[channel];

  // The audience is re-counted whenever the question changes, so the number on
  // screen is always the answer to what is currently selected.
  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await previewBroadcastAction({ channel, tiers });
    setPreview(r.ok ? (r.preview ?? null) : null);
    setLoading(false);
  }, [channel, tiers]);

  const refreshHistory = useCallback(async () => {
    const r = await listBroadcastsAction();
    if (r.ok && r.broadcasts) setHistory(r.broadcasts.filter((b) => b.status !== "DRAFT"));
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  // 🔴 POLL ONLY WHILE SOMETHING IS ACTUALLY MOVING. A blast takes a minute or
  // two to drain, and a progress line that never updates is indistinguishable
  // from a feature that stopped. Once nothing is in flight the timer is cleared
  // rather than left running on a page a barber leaves open all day.
  const anyInFlight = history.some((b) => IN_FLIGHT.has(b.status));
  useEffect(() => {
    if (!anyInFlight) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => void refreshHistory(), 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [anyInFlight, refreshHistory]);

  function toggleTier(t: LoyaltyTierKey) {
    setTiers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  const reachable = preview?.reachable ?? 0;
  const blocked = preview?.blocker ?? null;
  const tooLong = subject.length > limits.subject || body.length > limits.body;
  const canSend =
    !pending &&
    !loading &&
    !blocked &&
    !tooLong &&
    reachable > 0 &&
    subject.trim() !== "" &&
    body.trim() !== "";

  function send() {
    const who =
      tiers.length === 0
        ? `all ${reachable} of your ${vocab.clientNounPlural}`
        : `${reachable} ${tiers.map((t) => t.toLowerCase()).join(" and ")} ${vocab.clientNounPlural}`;
    const how = channel === "email" ? "an email" : "an app notification";
    // 🔴 A blast cannot be recalled. The confirm names the real number and the
    // channel, because "are you sure?" on its own tells nobody anything.
    if (!window.confirm(`Send ${how} to ${who}? This can't be undone.`)) return;
    start(async () => {
      const r = await sendBroadcastAction({ channel, tiers, subject: subject.trim(), body: body.trim() });
      if (!r.ok) {
        toast(r.error ?? "Couldn't send that.", "error");
        return;
      }
      // 🔴 "QUEUED", NOT "THEY'LL GET IT". At this instant the audience is
      // frozen and the allowance is reserved; nothing has been delivered. The
      // progress line below is where the rest of the truth shows up.
      toast(`Queued for ${r.recipients ?? reachable}. Watch it go out below.`, "success");
      setSubject("");
      setBody("");
      void refresh();
      void refreshHistory();
    });
  }

  if (!open) {
    return (
      <Card className="p-5">
        <CardHeader
          title={`Message your ${vocab.clientNounPlural}`}
          subtitle="One message to everyone, or just one loyalty group."
        />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 self-start rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900"
        >
          Write a message
        </button>
        <BroadcastHistory rows={history} vocab={vocab.clientNounPlural} />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <CardHeader
        title={`Message your ${vocab.clientNounPlural}`}
        subtitle="One message to everyone, or just one loyalty group."
      />

      <div className="mt-4 flex flex-col gap-4">
        <div>
          <p className="text-xs text-muted">Send it as</p>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {CHANNELS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setChannel(c.value)}
                aria-pressed={channel === c.value}
                className={cn(
                  "rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                  channel === c.value
                    ? "border-gold/60 bg-gold/10"
                    : "border-subtle hover:border-strong",
                )}
              >
                <span className="block text-sm font-medium text-offwhite">{c.label}</span>
                <span className="mt-0.5 block text-xs text-muted">{c.hint}</span>
              </button>
            ))}
          </div>
          {/* Said once, plainly, so nobody goes hunting for it. */}
          <p className="mt-1.5 text-xs text-muted">
            Text messages aren&apos;t an option here on purpose — one text to your
            whole book would spend a month&apos;s texting allowance in a single tap.
          </p>
        </div>

        <div>
          <p className="text-xs text-muted">Who gets it</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setTiers([])}
              aria-pressed={tiers.length === 0}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                tiers.length === 0
                  ? "bg-gold/20 text-gold"
                  : "border border-subtle text-muted hover:text-offwhite",
              )}
            >
              Everyone
            </button>
            {TIERS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => toggleTier(t.value)}
                aria-pressed={tiers.includes(t.value)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  tiers.includes(t.value)
                    ? "bg-gold/20 text-gold"
                    : "border border-subtle text-muted hover:text-offwhite",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <input
          className={field}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={limits.subject}
          placeholder={channel === "email" ? "Subject" : "Notification title"}
          aria-label={channel === "email" ? "Subject" : "Notification title"}
        />
        <div>
          <textarea
            className={cn(field, "min-h-[110px] resize-y")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={limits.body}
            // A mechanic has bays, not chairs. The example a barber is shown
            // while composing is presentation copy like any other, and reading
            // the wrong trade's word back at him is how a shop decides this
            // tool was not built for it.
            placeholder={`Two ${vocab.stationNounPlural} open this Friday — first come, first served.`}
            aria-label="Message"
          />
          {/* The count only appears once it starts to matter: a character
              counter on an empty box is noise, and on a push at 240 it is the
              difference between the offer arriving and being cut off. */}
          {channel === "push" && body.length > limits.body * 0.6 && (
            <p className="mt-1 text-xs text-muted">
              {limits.body - body.length} characters left — phones cut a
              notification off around here. Send it as an email if you need more room.
            </p>
          )}
        </div>

        {/* 🔴 THE REAL NUMBER, AND WHO IS MISSING FROM IT. */}
        <div className="rounded-xl border border-subtle bg-charcoal-700/50 px-3.5 py-3">
          {loading ? (
            <p className="text-sm text-muted">Counting…</p>
          ) : blocked ? (
            <p className="text-sm text-gold">{blocked.message}</p>
          ) : (
            <>
              <p className="text-sm text-offwhite">
                <span className="font-semibold">{reachable}</span> of{" "}
                {preview?.considered ?? 0} {vocab.clientNounPlural} will get this.
              </p>
              {preview?.emailsRemaining !== null && preview?.emailsRemaining !== undefined && (
                <p className="mt-0.5 text-xs text-muted">
                  {preview.emailsRemaining} emails left in your allowance this month.
                </p>
              )}
              {(preview?.skipped.length ?? 0) > 0 && (
                <ul className="mt-2 flex flex-col gap-0.5">
                  {preview!.skipped.map((s) => (
                    <li key={s.reason} className="text-xs text-muted">
                      {s.count} · {s.label}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className="rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
          >
            {pending ? "Queueing…" : "Send"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs font-medium text-muted transition-colors hover:text-offwhite"
          >
            Cancel
          </button>
        </div>
        {channel === "email" && (
          <p className="text-xs text-muted">
            Every email carries an unsubscribe link and your shop address, because
            marketing email has to. Anyone who unsubscribes still gets their
            booking confirmations and reminders.
          </p>
        )}
      </div>

      <BroadcastHistory rows={history} vocab={vocab.clientNounPlural} />
    </Card>
  );
}

/**
 * What has been sent, and what is going out right now.
 *
 * 🔴 THIS IS THE ANSWER TO "DID IT WORK?". Without it, a barber presses send,
 * sees a toast, and has no way to tell a blast that is draining from one that
 * stopped - so he presses send again. The status words are the ones the server
 * actually uses, including PARTIAL, because rounding "380 sent, 32 refused" up
 * to "Sent" is how a shop never learns that some of its list did not hear from
 * it.
 */
function BroadcastHistory({ rows, vocab }: { rows: BroadcastRow[]; vocab: string }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-5 border-t border-subtle pt-4">
      <p className="text-xs text-muted">Recent messages</p>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.slice(0, 5).map((b) => (
          <li key={b.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm text-offwhite">{b.subject || b.body}</p>
              <p className="mt-0.5 text-xs text-muted">
                {b.channel === "email" ? "Email" : "App notification"} ·{" "}
                {describe(b, vocab)}
              </p>
            </div>
            <span className={cn("shrink-0 text-xs font-medium", toneFor(b.status))}>
              {LABEL[b.status] ?? b.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LABEL: Record<string, string> = {
  QUEUED: "Queued",
  SENDING: "Going out",
  SENT: "Sent",
  PARTIAL: "Partly sent",
  FAILED: "Didn't send",
};

function toneFor(status: string): string {
  if (status === "FAILED") return "text-red-400";
  if (status === "PARTIAL") return "text-gold";
  if (status === "SENT") return "text-emerald-400";
  return "text-muted";
}

/** One honest sentence per row - counts, not adjectives. */
function describe(b: BroadcastRow, vocab: string): string {
  if (b.status === "QUEUED") return `queued for ${b.recipientCount} ${vocab}`;
  if (b.status === "SENDING") {
    return `${b.sentCount} of ${b.recipientCount} sent${b.failedCount > 0 ? `, ${b.failedCount} failed` : ""}`;
  }
  const parts = [`${b.sentCount} sent`];
  if (b.failedCount > 0) parts.push(`${b.failedCount} failed`);
  if (b.skippedCount > 0) parts.push(`${b.skippedCount} skipped`);
  return parts.join(", ");
}
