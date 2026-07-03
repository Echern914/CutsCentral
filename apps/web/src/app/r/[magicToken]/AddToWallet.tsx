"use client";

import { useEffect, useState } from "react";

/**
 * "Add to Apple Wallet" for the punch card. Renders ONLY when:
 *  - the API can mint passes (wallet.available - the WALLET_* env is set),
 *  - we're in iOS Safari (Wallet is an Apple thing), and
 *  - we're NOT inside the native app WebView (WKWebView can't present the
 *    Add-Pass sheet from a plain navigation; customers coming from the SMS
 *    magic link land in Safari, which is exactly where this works).
 *
 * The link is a same-tab navigation to the same-origin Next relay
 * (./wallet-pass/route.ts) - Safari sees application/vnd.apple.pkpass and
 * opens the Add-to-Wallet sheet over the page. Badge styling follows Apple's
 * Add-to-Wallet guidelines (black badge, white mark + text).
 */
export function AddToWallet({
  magicToken,
  available,
}: {
  magicToken: string;
  /** From the rewards payload: false until the Wallet env is configured. */
  available: boolean;
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
        href={`/r/${magicToken}/wallet-pass`}
        aria-label="Add your punch card to Apple Wallet"
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
