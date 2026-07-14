"use client";

import { useState, useTransition } from "react";
import { enableReceptionistAction } from "./actions";

/**
 * Minimal enable/disable controls for the AI receptionist, shown once the shop
 * is entitled (Premium AI tier, the $40 add-on, or a comped pilot). The first
 * enable requires the liability acknowledgment - the API rejects it otherwise
 * (400 receptionist_terms_required) - and the acceptance is one-time: once
 * stamped, the checkbox never shows again.
 */
/** "+15512840878" -> "(551) 284-0878" for display; unknown shapes pass through. */
function prettyNumber(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function ReceptionistControls({
  enabled,
  termsAccepted,
  bookingMode,
  shopNumber,
}: {
  enabled: boolean;
  termsAccepted: boolean;
  bookingMode: string;
  /** The shop's OWN text line (null = shared platform number). */
  shopNumber: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const needsTerms = !termsAccepted && !enabled;
  const nativeReady = bookingMode === "native";

  return (
    <div className="mt-5 rounded-2xl border border-subtle bg-charcoal-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-offwhite">AI receptionist</p>
          <p className="mt-0.5 text-xs text-muted">
            {enabled
              ? "On - answering client texts, booking and rescheduling 24/7."
              : "Off - client texts get no AI reply until you turn it on."}
          </p>
        </div>
        <button
          disabled={pending || (needsTerms && !acknowledged)}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const r = await enableReceptionistAction({
                enable: !enabled,
                acceptTerms: needsTerms && acknowledged,
              });
              if (r?.error) setError(r.error);
            })
          }
          className={
            enabled
              ? "rounded-full border border-subtle px-5 py-2 text-sm text-offwhite transition-all duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
              : "rounded-full bg-gold-gradient px-5 py-2 text-sm font-semibold text-charcoal shadow-glow transition-all duration-150 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
          }
        >
          {pending ? "Saving…" : enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      {/* The shop's own text line - the number the barber hands to clients.
          Only shown once provisioned; shared-line shops see nothing here. */}
      {shopNumber && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-gold/30 bg-gold/10 px-4 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-gold-soft">
              Your shop&apos;s text line
            </p>
            <p className="mt-1 text-lg font-semibold text-offwhite">
              {prettyNumber(shopNumber)}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              Give this number to your clients - texts to it always reach YOUR
              shop&apos;s AI, and its replies come from this number.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(shopNumber)}
            className="rounded-full border border-subtle px-4 py-1.5 text-xs text-offwhite transition-all duration-150 ease-out hover:bg-charcoal-700"
          >
            Copy
          </button>
        </div>
      )}

      {/* How it works - so a barber knows exactly what turning this on does. */}
      <div className="mt-4 rounded-xl border border-subtle bg-charcoal-900/50 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-gold-soft">
          How it works
        </p>
        <ol className="mt-3 flex flex-col gap-2 text-xs text-muted">
          <li className="flex gap-2">
            <span className="text-gold">1.</span>
            <span>
              A client texts your shop&apos;s number like they always have - no app,
              no link.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-gold">2.</span>
            <span>
              The AI texts back, checks your real calendar, and{" "}
              <span className="text-offwhite">books, reschedules, or cancels</span>{" "}
              the appointment for them - 24/7, even while you&apos;re with a client.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-gold">3.</span>
            <span>
              When someone cancels, it quietly texts a regular who&apos;s due to{" "}
              <span className="text-offwhite">fill the open slot</span>.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-gold">4.</span>
            <span>
              Anything it can&apos;t handle, it{" "}
              <span className="text-offwhite">hands off to you</span> and sends you an
              alert - you only step in when a person needs you.
            </span>
          </li>
        </ol>

        {/* One concrete example so "AI receptionist" isn't abstract. */}
        <div className="mt-4 flex flex-col gap-1.5 rounded-lg bg-charcoal-800 p-3">
          <div className="self-start rounded-2xl rounded-bl-sm bg-charcoal-700 px-3 py-1.5 text-xs text-offwhite">
            you got anything sat?
          </div>
          <div className="self-end rounded-2xl rounded-br-sm bg-gold/15 px-3 py-1.5 text-xs text-offwhite">
            Hey! I&apos;ve got 2pm or 4pm open with you Saturday - want me to grab one?
          </div>
          <div className="self-start rounded-2xl rounded-bl-sm bg-charcoal-700 px-3 py-1.5 text-xs text-offwhite">
            2 works
          </div>
          <div className="self-end rounded-2xl rounded-br-sm bg-gold/15 px-3 py-1.5 text-xs text-offwhite">
            Done - you&apos;re booked Saturday at 2pm. See you then!
          </div>
        </div>
      </div>

      {needsTerms && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-subtle bg-charcoal-900/60 px-4 py-3 text-xs text-muted">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#D4AF37]"
          />
          <span>
            I understand the AI receptionist can make scheduling mistakes
            (double-bookings, missed or incorrect bookings), that I&apos;m
            responsible for reviewing my calendar, and that ChairBack isn&apos;t
            liable for scheduling errors. See the{" "}
            <a href="/terms" className="text-gold underline-offset-2 hover:underline">
              Terms
            </a>
            .
          </span>
        </label>
      )}

      {!nativeReady && (
        <div className="mt-4 rounded-xl border border-gold/30 bg-gold/10 px-4 py-3 text-xs text-gold">
          <span className="font-semibold">Before it can book:</span> your booking is
          set to an outside calendar right now, so the AI can answer questions but
          can&apos;t take appointments. Switch booking to{" "}
          <span className="text-offwhite">ChairBack Booking</span> in{" "}
          <a
            href="/dashboard/booking"
            className="text-offwhite underline underline-offset-2 hover:text-gold"
          >
            Settings
          </a>{" "}
          to let it book, reschedule, and fill cancellations.
        </div>
      )}

      {error && <p className="mt-3 text-xs text-danger-soft">{error}</p>}
    </div>
  );
}
