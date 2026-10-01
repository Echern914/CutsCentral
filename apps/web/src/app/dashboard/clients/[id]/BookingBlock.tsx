"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { setBookingBlockAction } from "../../actions";

/**
 * Block this client from booking online, or unblock them.
 *
 * Asked for by a shop: "if any issues ever happen they don't want that client
 * booking again". Blocking is one tap and a confirm, because it changes what a
 * real person can do; unblocking is one tap, because it only gives access back.
 *
 * What a block does is enforced by the API (services/clientBookingBlock.ts):
 * no booking, waitlist join or moved booking online with this phone number or
 * email, and no rebook reminders, deals or announcements. The shop can still
 * book them from New appointment, and their upcoming appointments stay booked -
 * the confirm says so, with the count, so nobody assumes they were cancelled.
 *
 * The answer is written in the panel, not a toast - a toast can hide under a
 * dialog on a phone.
 */
export function BookingBlock({
  clientId,
  initial,
  upcoming,
  timezone,
}: {
  clientId: string;
  /** When the shop blocked them (ISO), or null. Undefined = an API from before this: show nothing. */
  initial: string | null | undefined;
  /** How many appointments they have coming up. */
  upcoming: number;
  /** The shop's timezone, so the date reads the same on the server and in the browser. */
  timezone: string;
}) {
  const [blockedAt, setBlockedAt] = useState(initial);
  // A server refresh (this change's revalidate, or any other edit) is the truth.
  useEffect(() => setBlockedAt(initial), [initial]);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  if (blockedAt === undefined) return null;

  async function save(blocked: boolean) {
    if (pending) return;
    setOutcome(null);
    setPending(true);
    try {
      const r = await setBookingBlockAction(clientId, blocked);
      if (r.ok && r.bookingBlockedAt !== undefined) {
        setBlockedAt(r.bookingBlockedAt);
        setConfirming(false);
        setOutcome({ ok: true, text: blocked ? "Blocked." : "Unblocked. They can book online again." });
        return;
      }
      setOutcome({ ok: false, text: "Could not save that. Try again." });
    } catch {
      setOutcome({ ok: false, text: "Could not save that. Try again." });
    } finally {
      setPending(false);
    }
  }

  const date = blockedAt
    ? new Date(blockedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: timezone,
      })
    : null;
  const small = "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50";

  return (
    <Card className="px-5 py-4">
      <h2 className="text-[10px] uppercase tracking-wide text-muted">Online booking</h2>

      {blockedAt ? (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-sm text-offwhite" data-qa="booking-block-state">
            Blocked from booking since {date}. They can&apos;t book, join your waitlist or move a booking
            online, and they don&apos;t get your rebook reminders, deals or announcements.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void save(false)}
            className={`${small} border border-subtle text-offwhite hover:bg-charcoal-700`}
          >
            Unblock
          </button>
        </div>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-offwhite" data-qa="booking-block-state">
              Can book online.
            </p>
            {!confirming && (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOutcome(null);
                  setConfirming(true);
                }}
                className={`${small} border border-subtle text-muted hover:text-offwhite`}
              >
                Block from booking
              </button>
            )}
          </div>
          {confirming && (
            <div
              role="group"
              aria-label="Block this client from booking?"
              className="mt-2 flex flex-col gap-2 rounded-xl border border-subtle bg-charcoal-800 p-3"
            >
              <p className="text-sm text-offwhite">Block this client from booking?</p>
              <p className="text-xs text-muted">
                They won&apos;t be able to book, join your waitlist or move a booking online with this phone
                number or email - they&apos;ll be asked to contact you instead. They also won&apos;t get your
                rebook reminders, deals or announcements. You can still book them yourself.
              </p>
              {upcoming > 0 && (
                <p className="text-xs text-muted">
                  {upcoming === 1
                    ? "Their upcoming appointment stays booked. Cancel it if you don't want to keep it."
                    : `Their ${upcoming} upcoming appointments stay booked. Cancel any you don't want to keep.`}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void save(true)}
                  className={`${small} bg-danger-soft/15 text-danger-soft hover:bg-danger-soft/25`}
                >
                  Block
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                  className={`${small} border border-subtle text-muted hover:text-offwhite`}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {(pending || outcome) && (
        <p
          role="status"
          aria-live="polite"
          className={`mt-1 text-xs ${pending ? "text-muted" : outcome?.ok ? "text-emerald-soft" : "text-danger-soft"}`}
        >
          {pending ? "Saving…" : outcome?.text}
        </p>
      )}
    </Card>
  );
}
