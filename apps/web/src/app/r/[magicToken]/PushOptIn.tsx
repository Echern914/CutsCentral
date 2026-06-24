"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { pressable } from "@/components/motion/variants";
import {
  isIos,
  isInStandaloneMode,
  isPushSupported,
  urlBase64ToArrayBuffer,
} from "@/lib/pwa";
import { surfaceStyle, type RewardsTheme } from "./theme";

/**
 * Client-facing push opt-in on the rewards page, rendered just below the SMS
 * ConsentCard. Push is the FREE alternative to SMS - an installed customer gets
 * earn/redeem/rebook notifications without the shop paying Twilio. It's also its
 * own opt-in (the browser permission grant is the consent), independent of SMS.
 *
 * The platform matrix (Web Push is restrictive, especially on iOS):
 *  - push unsupported -> render nothing (no dead UI)
 *  - already subscribed on THIS device -> quiet "notifications on" + turn off
 *  - Android / desktop -> a button that prompts permission and subscribes
 *  - iOS, NOT installed -> Add-to-Home-Screen instructions (iOS only allows push
 *    from an installed PWA; we must NOT call requestPermission here)
 *  - iOS, installed (standalone) -> a button to turn on alerts (a tap is required
 *    so the permission prompt is bound to a user gesture)
 *
 * Theme-driven like ConsentCard so it matches the barber's identity.
 */

type Phase =
  | "loading"
  | "unsupported"
  | "subscribed"
  | "prompt" // Android/desktop or iOS-standalone: a button to enable
  | "ios-install"; // iOS Safari, not yet installed: show A2HS instructions

export function PushOptIn({
  magicToken,
  shopName,
  theme,
  vapidPublicKey,
}: {
  magicToken: string;
  shopName: string;
  theme: RewardsTheme;
  vapidPublicKey: string;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Decide the initial phase from platform + current subscription state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isPushSupported()) {
        if (!cancelled) setPhase("unsupported");
        return;
      }
      // If a subscription already exists on this device, show the quiet state.
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const existing = reg ? await reg.pushManager.getSubscription() : null;
        if (existing) {
          if (!cancelled) setPhase("subscribed");
          return;
        }
      } catch {
        /* fall through to platform decision */
      }
      if (Notification.permission === "denied") {
        // The customer blocked notifications: nothing actionable, hide the card.
        if (!cancelled) setPhase("unsupported");
        return;
      }
      // iOS only allows push from an installed PWA. If we're on iOS and NOT
      // standalone, guide them to install; otherwise a normal prompt works.
      if (isIos() && !isInStandaloneMode()) {
        if (!cancelled) setPhase("ios-install");
        return;
      }
      if (!cancelled) setPhase("prompt");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setError(null);
    setBusy(true);
    try {
      // Permission must be requested from a user gesture (this click).
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setError(
          perm === "denied"
            ? "Notifications are blocked. Enable them in your browser settings."
            : "Permission wasn't granted. Tap to try again.",
        );
        setBusy(false);
        return;
      }

      // Register the SW (carrying the token so pushsubscriptionchange can re-sub).
      const reg = await navigator.serviceWorker.register(
        `/sw.js?token=${encodeURIComponent(magicToken)}`,
      );
      await navigator.serviceWorker.ready;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(vapidPublicKey),
      });
      const json = sub.toJSON() as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };

      const res = await fetch(`/r/${magicToken}/push/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);

      // Cache the config so the SW can re-subscribe if the browser rotates it.
      try {
        const cache = await caches.open("push-config-v1");
        await cache.put(
          "/__push_config",
          new Response(JSON.stringify({ token: magicToken, vapidPublicKey }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      } catch {
        /* non-fatal: re-subscribe just falls back to next-visit */
      }

      setPhase("subscribed");
    } catch (e) {
      setError("Couldn't turn on notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError(null);
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch(`/r/${magicToken}/push/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setPhase("prompt");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "loading" || phase === "unsupported") return null;

  // Subscribed on this device: quiet confirmation + a way off (mirrors ConsentCard).
  if (phase === "subscribed") {
    return (
      <p className="px-1 text-center text-xs" style={{ color: theme.muted }}>
        Notifications on for {shopName}.{" "}
        <button
          type="button"
          onClick={disable}
          disabled={busy}
          className="underline underline-offset-2 transition-colors duration-150 ease-out disabled:opacity-50"
        >
          Turn off
        </button>
      </p>
    );
  }

  // iOS, not installed: show how to Add to Home Screen (push needs the PWA).
  if (phase === "ios-install") {
    return (
      <div className="relative overflow-hidden p-5" style={surfaceStyle(theme)}>
        <div
          className="absolute inset-y-0 left-0 w-1"
          style={{ backgroundColor: theme.accent }}
          aria-hidden
        />
        <p className="text-sm font-semibold">Get free alerts (no texts needed)</p>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: theme.muted }}>
          Add {shopName} to your Home Screen to get a tap-to-open app with free
          notifications when you earn a punch or it&apos;s time to rebook:
        </p>
        <ol
          className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-relaxed"
          style={{ color: theme.muted }}
        >
          <li>
            Tap the <span style={{ color: theme.text }}>Share</span> button in
            Safari (the square with an up arrow).
          </li>
          <li>
            Choose{" "}
            <span style={{ color: theme.text }}>Add to Home Screen</span>.
          </li>
          <li>Open {shopName} from your Home Screen and turn on alerts.</li>
        </ol>
      </div>
    );
  }

  // Android / desktop, or iOS already installed: a single enable button.
  return (
    <div className="relative overflow-hidden p-5" style={surfaceStyle(theme)}>
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: theme.accent }}
        aria-hidden
      />
      <p className="text-sm font-semibold">Get free alerts (no texts needed)</p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: theme.muted }}>
        Turn on notifications to hear from {shopName} when you earn a punch, a
        reward is ready, or it&apos;s time to rebook - free, no SMS required.
      </p>
      {error && (
        <p className="mt-2 text-xs" style={{ color: "#ef4444" }}>
          {error}
        </p>
      )}
      <motion.button
        {...pressable}
        type="button"
        onClick={enable}
        disabled={busy}
        className="mt-3 w-full px-5 py-2.5 text-sm font-semibold transition-all duration-150 ease-out disabled:pointer-events-none disabled:opacity-50"
        style={{
          backgroundColor: theme.accent,
          color: theme.onAccent,
          borderRadius: theme.buttonRadius,
          boxShadow: `0 8px 30px -10px ${theme.accent}AA`,
        }}
      >
        {busy ? "Turning on…" : "Turn on notifications"}
      </motion.button>
    </div>
  );
}
