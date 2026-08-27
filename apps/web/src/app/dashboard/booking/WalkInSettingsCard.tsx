"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import {
  mintWalkInKioskUrlAction,
  saveWalkInSettingsAction,
} from "./actions";

/**
 * The Walk-In Mode settings card: the master switch, the "accepting right
 * now" pause lever, and the kiosk link.
 *
 * 🔴 THE KIOSK URL IS SHOWN EXACTLY ONCE, at mint time - only its hash is
 * stored, so this card cannot re-display an old link and never pretends it
 * could. Rotating mints a fresh one and kills every tablet holding the old
 * URL at once, which is precisely the "the tablet walked out the door"
 * button. Fine-grained knobs (max line size, per-shop notification choices)
 * deliberately ride the platform defaults for the pilot.
 */

const PILL = (on: boolean) =>
  cn(
    "shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50",
    on
      ? "bg-emerald-soft/15 text-emerald-soft"
      : "border border-subtle text-muted hover:bg-charcoal-700",
  );

export function WalkInSettingsCard({
  initialEnabled,
  initialAccepting,
  toast,
}: {
  initialEnabled: boolean;
  initialAccepting: boolean;
  toast: (message: string, kind?: "success" | "error") => void;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [accepting, setAccepting] = useState(initialAccepting);
  const [pending, setPending] = useState(false);
  const [kioskUrl, setKioskUrl] = useState<string | null>(null);
  const [hasMinted, setHasMinted] = useState(false);

  function save(next: { walkInEnabled?: boolean; walkInAcceptingNow?: boolean }) {
    setPending(true);
    void (async () => {
      const r = await saveWalkInSettingsAction(next);
      toast(
        r.ok ? "Walk-in settings saved" : "Couldn't save",
        r.ok ? "success" : "error",
      );
      if (!r.ok) {
        // Reflect the server's truth back - an optimistic flip that failed
        // must not keep lying.
        if (next.walkInEnabled !== undefined) setEnabled(!next.walkInEnabled);
        if (next.walkInAcceptingNow !== undefined)
          setAccepting(!next.walkInAcceptingNow);
      }
      setPending(false);
    })();
  }

  function mint() {
    setPending(true);
    void (async () => {
      const r = await mintWalkInKioskUrlAction();
      if (r.ok && r.url) {
        setKioskUrl(r.url);
        setHasMinted(true);
        toast("Kiosk link ready — it's shown once, copy it now", "success");
      } else {
        toast("Couldn't create the kiosk link", "error");
      }
      setPending(false);
    })();
  }

  return (
    <Card className="p-5">
      <div>
        <h3 className="font-display text-base text-offwhite">Walk-In Mode</h3>
        <p className="mt-0.5 text-xs text-muted">
          Customers check themselves in on a shop tablet, get a private
          tracking text, and land on the Walk-ins tab as a live line.
        </p>
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted">
          {enabled
            ? "On — the kiosk and the live line are active."
            : "Off — the kiosk and tracking links are dark."}
        </p>
        <button
          disabled={pending}
          className={PILL(enabled)}
          onClick={() => {
            const next = !enabled;
            setEnabled(next);
            save({ walkInEnabled: next });
          }}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>

      {enabled && (
        <>
          <div className="mt-3 flex items-center justify-between gap-4">
            <p className="text-sm text-muted">
              {accepting
                ? "Accepting walk-ins right now."
                : "Paused — the kiosk shows a friendly closed screen."}
            </p>
            <button
              disabled={pending}
              className={PILL(accepting)}
              onClick={() => {
                const next = !accepting;
                setAccepting(next);
                save({ walkInAcceptingNow: next });
              }}
            >
              {accepting ? "Accepting" : "Paused"}
            </button>
          </div>

          <div className="mt-4 border-t border-subtle pt-4">
            <p className="text-sm font-medium text-offwhite">Kiosk link</p>
            <p className="mt-0.5 text-xs text-muted">
              Open it on the shop tablet and bookmark it. The link is shown
              ONCE — rotating mints a new one and signs every old tablet out
              instantly.
            </p>
            {kioskUrl ? (
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-subtle bg-charcoal-900 px-3 py-2 text-xs text-offwhite">
                  {kioskUrl}
                </code>
                <button
                  className={cn(PILL(true), "min-h-11 sm:min-h-9")}
                  onClick={() => {
                    void navigator.clipboard?.writeText(kioskUrl);
                    toast("Copied", "success");
                  }}
                >
                  Copy
                </button>
                <a
                  className={cn(PILL(false), "flex min-h-11 items-center sm:min-h-9")}
                  href={kioskUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open
                </a>
              </div>
            ) : (
              <button
                disabled={pending}
                className={cn(PILL(false), "mt-3 min-h-11")}
                onClick={mint}
              >
                {hasMinted ? "Rotate kiosk link" : "Generate kiosk link"}
              </button>
            )}
            {kioskUrl && (
              <button
                disabled={pending}
                className={cn(PILL(false), "mt-2 min-h-11")}
                onClick={mint}
              >
                Rotate (kills the old link)
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
