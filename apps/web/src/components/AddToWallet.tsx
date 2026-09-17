"use client";

import { useEffect, useState } from "react";

/**
 * "Add to Apple Wallet" — the one badge, used for both pass kinds.
 *
 * TWO CALLERS, TWO PASSES: the punch card on the rewards page, and the
 * appointment itself on the booking confirmation and beside the customer's next
 * visit. They differ only in where the .pkpass comes from, so the gating, the
 * markup and Apple's badge styling live here once.
 *
 * Renders ONLY when:
 *  - the API can actually mint THAT pass (`available` — each kind has its own
 *    env and its own gate; a badge that downloads a 503 is worse than no badge),
 *  - we're in iOS Safari (Wallet is an Apple thing), and
 *  - we're NOT inside the native app WebView (WKWebView can't present the
 *    Add-Pass sheet from a plain navigation; customers coming from an SMS magic
 *    link land in Safari, which is exactly where this works).
 *
 * `href` is always a same-origin Next relay (`…/wallet-pass/route.ts`) — the CSP
 * blocks direct browser fetches to the API origin, and Safari needs a plain
 * same-tab navigation to present the Add-to-Wallet sheet.
 */
export function AddToWallet({
  href,
  available,
  label,
}: {
  /** Same-origin relay path that streams the signed .pkpass. */
  href: string;
  /** From the payload: false until that pass kind's WALLET_* env is set. */
  available: boolean;
  /** Accessible name — says WHICH pass, since a page may offer both. */
  label: string;
}) {
  // Client-only gates (userAgent, the RN bridge) - start hidden, reveal in an
  // effect so SSR never renders a badge the client would remove (hydration).
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!available) return;
    const inApp = Boolean(
      (window as { ReactNativeWebView?: unknown }).ReactNativeWebView,
    );
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (ios && !inApp) setShow(true);
  }, [available]);

  if (!show) return null;

  return (
    <div className="flex justify-center">
      <a
        href={href}
        aria-label={label}
        className="inline-flex items-center gap-2.5 rounded-lg bg-black px-5 py-2.5 transition-transform duration-200 ease-out hover:scale-[1.02]"
        style={{ border: "1px solid rgba(255,255,255,0.25)" }}
      >
        {/* Wallet mark: the layered-cards glyph */}
        <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
          <rect x="1" y="0.5" width="24" height="5.5" rx="2" fill="#D9A946" />
          <rect x="1" y="4.5" width="24" height="5.5" rx="2" fill="#DE5B4F" />
          <rect x="1" y="8.5" width="24" height="5.5" rx="2" fill="#4CA5DF" />
          <path
            d="M1 13.5 h24 v3 a3 3 0 0 1 -3 3 h-18 a3 3 0 0 1 -3 -3 z"
            fill="#4CAF50"
          />
        </svg>
        <span className="flex flex-col leading-tight">
          <span className="text-[10px] text-white/80">Add to</span>
          <span className="text-sm font-semibold text-white">Apple Wallet</span>
        </span>
      </a>
    </div>
  );
}
