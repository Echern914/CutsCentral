"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";

export interface ReferralRow {
  id: string;
  shopName: string;
  status: "PENDING" | "REWARDED" | "VOID";
  joinedAt: string;
  rewardedAt: string | null;
}

/**
 * The share surface.
 *
 * The message is pre-written and copied WITH the link because the hard part of
 * a referral isn't the URL, it's knowing what to say. A link on its own makes
 * the sender compose the pitch, and most won't - so the default text leads with
 * what the RECIPIENT gets, not with the favor being asked.
 */
export function ReferralShare({
  appBase,
  code,
  rows,
  earnedMonths,
  pendingCount,
  rewardDays,
}: {
  /** APP_BASE_URL. Empty string when the env var isn't set. */
  appBase: string;
  code: string;
  rows: ReferralRow[];
  earnedMonths: number;
  pendingCount: number;
  rewardDays: number;
}) {
  const vocab = useVocab();
  const { toast } = useToast();

  // A referral link is pasted into someone else's text messages, so it MUST be
  // absolute. If APP_BASE_URL is unset the server would render "/?ref=CODE",
  // which is silently useless once it leaves this browser — so fall back to the
  // origin we're actually being served from. Read after mount, since
  // `window` doesn't exist during the server render and the two must agree on
  // the first paint.
  const [origin, setOrigin] = useState(appBase);
  useEffect(() => {
    if (!appBase) setOrigin(window.location.origin);
  }, [appBase]);

  const shareUrl = `${origin}/?ref=${encodeURIComponent(code)}`;

  const message =
    `I use ChairBack to run my shop — booking, reminders, and a client list ` +
    `that's actually mine. Use my link and you get an extra month free: ${shareUrl}`;

  function copy(text: string, what: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast(`${what} copied`, "success"))
      .catch(() => toast(`Couldn't copy ${what.toLowerCase()}`, "error"));
  }

  async function share() {
    // The native share sheet is the whole game on a phone — it puts the message
    // straight into their texts. Falls back to copying where it doesn't exist
    // (every desktop browser, and the WebView when unsupported).
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ text: message });
        return;
      } catch {
        // Cancelled or unavailable — fall through to copy.
      }
    }
    copy(message, "Message");
  }

  return (
    <>
      <Card className="px-5 py-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <Stat value={earnedMonths} label={earnedMonths === 1 ? "month earned" : "months earned"} />
          <Stat value={pendingCount} label="waiting on their first payment" muted />
        </div>

        <p className="mt-4 text-[10px] uppercase tracking-wide text-muted">
          Your link
        </p>
        <p className="mt-1 truncate font-mono text-sm text-offwhite">{shareUrl}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={share}
            className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted"
          >
            Share
          </button>
          <button
            onClick={() => copy(shareUrl, "Link")}
            className="rounded-full border border-subtle px-4 py-2 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
          >
            Copy link
          </button>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted">
          They get {rewardDays} extra days free on top of their trial, the moment
          they sign up. You get a free month once they become a paying shop —
          that&rsquo;s why some referrals sit as &ldquo;joined&rdquo; for a while.
        </p>
      </Card>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-subtle px-5 py-4">
          <h2 className="font-display text-lg">Who you&rsquo;ve brought in</h2>
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            Nobody yet. {cap(vocab.providerNounPlural)} you refer show up here.
          </p>
        ) : (
          <ul className="divide-y divide-[rgba(245,245,244,0.08)]">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-offwhite">
                    {r.shopName}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    Joined {new Date(r.joinedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
                {r.status === "REWARDED" ? (
                  <span className="shrink-0 rounded-full border border-emerald-soft/40 bg-emerald-soft/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-soft">
                    Month earned
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full border border-subtle px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                    Joined
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Stat({
  value,
  label,
  muted = false,
}: {
  value: number;
  label: string;
  muted?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-2">
      <span
        className={
          muted
            ? "font-display text-2xl text-offwhite"
            : "font-display text-3xl text-gold"
        }
      >
        {value}
      </span>
      <span className="text-xs text-muted">{label}</span>
    </span>
  );
}
