"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { disconnectGcalAction } from "./actions";
import type { ConnectStatus } from "./page";

/**
 * The Google Calendar bridge card. Booksy, GlossGenius, Vagaro etc. have no
 * public API, but they all can sync appointments into the barber's Google
 * Calendar — connecting that calendar here turns those platforms' bookings
 * into automatic visit tracking. It's an ADD-ON to "Your own link" mode (the
 * customer still books on the platform), not a bookingMode of its own, so it
 * renders as its own card under the platform picker. Hidden while the API
 * reports the bridge unavailable (env not configured).
 */
export function GoogleCalendarCard({
  connect,
  apiBase,
}: {
  connect: ConnectStatus;
  apiBase: string;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  if (!connect.gcalAvailable) return null;
  const connected = connect.gcalConnected;

  function connectOAuth() {
    // Google REFUSES OAuth inside embedded WebViews (disallowed_useragent), so
    // in the native app's dashboard WebView this flow can only dead-end at an
    // "Access blocked" screen. Point the barber at a real browser instead —
    // it's a one-time setup; the synced visits then show up in the app fine.
    if (typeof window !== "undefined" && "ReactNativeWebView" in window) {
      toast(
        "Google doesn't allow this step inside the app — connect once from getchairback.com in your browser.",
        "error",
      );
      return;
    }
    start(() => {
      // Full-page nav to the API OAuth start (it 302s to Google). Not a
      // fetch — CSP + the redirect chain need a real navigation.
      window.location.href = `${apiBase}/api/gcal/oauth/start`;
    });
  }

  function disconnect() {
    if (
      !window.confirm(
        "Disconnect Google Calendar? New appointments will stop syncing. Your existing clients and visit history are kept, and you can reconnect anytime.",
      )
    ) {
      return;
    }
    start(async () => {
      const r = await disconnectGcalAction();
      if (r.ok) {
        toast("Google Calendar disconnected.", "success");
        router.refresh();
      } else {
        toast(r.error ?? "Couldn't disconnect Google Calendar.", "error");
      }
    });
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-charcoal-800 ring-1 ring-white/5">
            <GcalMark />
          </div>
          <CardHeader
            title="Sync from Booksy, GlossGenius & more"
            subtitle="Those apps don't offer a direct connection — but they can push every appointment to Google Calendar. Connect that calendar and your visits track automatically."
          />
        </div>
        {connected && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
            <Check /> Connected
          </span>
        )}
      </div>

      {connect.gcalRevoked && (
        <p className="mt-3 rounded-xl border border-gold/30 bg-gold/5 px-4 py-3 text-xs text-gold">
          Google access was revoked, so syncing has stopped. Reconnect below to
          resume.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!connected ? (
          <button
            type="button"
            onClick={connectOAuth}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-full bg-gold px-3.5 py-1.5 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
          >
            {pending ? "Opening…" : "Connect Google Calendar"}
          </button>
        ) : (
          <>
            {connect.gcalEmail && (
              <span className="text-xs text-muted">
                Syncing <span className="text-offwhite">{connect.gcalEmail}</span>
              </span>
            )}
            <button
              type="button"
              onClick={connectOAuth}
              disabled={pending}
              className="inline-flex items-center rounded-full border border-subtle px-3 py-1.5 text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
            >
              Reconnect
            </button>
            <button
              type="button"
              onClick={disconnect}
              disabled={pending}
              className="inline-flex items-center rounded-full border border-rose-400/30 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors duration-150 ease-out hover:bg-rose-500/10 disabled:opacity-50"
            >
              {pending ? "Working…" : "Disconnect"}
            </button>
          </>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted">
        Set it up once: in Booksy or GlossGenius, turn on their Google Calendar
        sync, then connect that same Google account here. Heads up — calendar
        events rarely include phone numbers, so synced clients may need to claim
        their rewards page before you can text them.
      </p>
    </Card>
  );
}

function GcalMark() {
  // A calendar glyph in Google's blue.
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="17" rx="2" stroke="#4285F4" strokeWidth="2" />
      <path d="M3 9h18M8 2v4M16 2v4" stroke="#4285F4" strokeWidth="2" strokeLinecap="round" />
      <rect x="8" y="12" width="4" height="4" rx="1" fill="#4285F4" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
