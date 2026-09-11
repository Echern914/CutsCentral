"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { useVocab } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";
import {
  previewBroadcastAction,
  sendBroadcastAction,
  type BroadcastChannel,
  type BroadcastPreview,
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

  // The audience is re-counted whenever the question changes, so the number on
  // screen is always the answer to what is currently selected.
  const refresh = useCallback(async () => {
    setLoading(true);
    const r = await previewBroadcastAction({ channel, tiers });
    setPreview(r.ok ? (r.preview ?? null) : null);
    setLoading(false);
  }, [channel, tiers]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  function toggleTier(t: LoyaltyTierKey) {
    setTiers((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  const reachable = preview?.reachable ?? 0;
  const blocked = preview?.blocker ?? null;
  const canSend =
    !pending && !loading && !blocked && reachable > 0 && subject.trim() !== "" && body.trim() !== "";

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
      toast(`Sending to ${r.recipients ?? reachable}. They'll get it in a minute or two.`, "success");
      setSubject("");
      setBody("");
      void refresh();
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
          maxLength={120}
          placeholder={channel === "email" ? "Subject" : "Notification title"}
          aria-label={channel === "email" ? "Subject" : "Notification title"}
        />
        <textarea
          className={cn(field, "min-h-[110px] resize-y")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          placeholder="Two chairs open this Friday — first come, first served."
          aria-label="Message"
        />

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
            {pending ? "Sending…" : "Send"}
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
    </Card>
  );
}
