"use client";

import { useEffect, useState, type ComponentPropsWithoutRef } from "react";

/**
 * "Add to Apple Wallet" — the one badge, used for both pass kinds.
 *
 * TWO CALLERS, TWO PASSES: the punch card on the rewards page, and the
 * appointment itself on the booking confirmation and beside the customer's next
 * visit. They differ only in where the .pkpass comes from, so the gating, the
 * markup and Apple's badge styling live here once.
 *
 * Renders ONLY when the API can actually mint THAT pass (`available` — each
 * kind has its own env and its own gate; a badge that downloads a 503 is worse
 * than no badge) and we are on iOS, because Wallet is an Apple thing.
 *
 * TWO WAYS TO ADD, because the browser and the app genuinely differ:
 *
 *  - iOS SAFARI: a plain same-tab navigation to the .pkpass. Safari presents
 *    Apple's add sheet itself. `href` is always a same-origin Next relay
 *    (`…/wallet-pass/route.ts`) — the CSP blocks direct browser fetches to the
 *    API origin, and Safari needs an ordinary navigation for the sheet.
 *
 *  - INSIDE THE APP: that same navigation does nothing in a WKWebView, which is
 *    why this component used to render NOTHING there and the app had no way to
 *    add a pass at all. It now asks the shell, which presents PassKit's
 *    PKAddPassesViewController natively (apps/mobile/src/walletBridge.ts).
 *
 * 🔴 THE APP PATH NEEDS `manageToken`, AND ONLY THE APPOINTMENT PASS HAS ONE.
 * The bridge takes a token and builds the URL itself, so a page can never point
 * the app at an arbitrary host. The rewards PUNCH CARD has no manage token and
 * no native path, so in-app it stays hidden exactly as before — which is the
 * honest outcome, not an oversight.
 */
export function AddToWallet({
  href,
  available,
  label,
  manageToken,
}: {
  /** Same-origin relay path that streams the signed .pkpass. */
  href: string;
  /** From the payload: false until that pass kind's WALLET_* env is set. */
  available: boolean;
  /** Accessible name — says WHICH pass, since a page may offer both. */
  label: string;
  /**
   * The appointment's manage token. Supplied ONLY by appointment-pass callers;
   * its presence is what makes the in-app native path possible. Without it the
   * component behaves exactly as it always has (Safari only).
   */
  manageToken?: string;
}) {
  // Client-only gates (userAgent, the RN bridge) - start hidden, reveal in an
  // effect so SSR never renders a badge the client would remove (hydration).
  const [mode, setMode] = useState<"hidden" | "web" | "native">("hidden");

  useEffect(() => {
    if (!available) return;
    const inApp = Boolean(
      (window as { ReactNativeWebView?: unknown }).ReactNativeWebView,
    );
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!ios) return;
    // In the app, only the appointment pass has a native path (see above).
    if (inApp) {
      if (manageToken) setMode("native");
      return;
    }
    setMode("web");
  }, [available, manageToken]);

  if (mode === "hidden") return null;

  /** Ask the shell to present PassKit's add sheet for this appointment. */
  function askTheApp() {
    (
      window as { ReactNativeWebView?: { postMessage: (s: string) => void } }
    ).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: "cb:add-wallet-pass", manageToken }),
    );
  }

  // 🔴 In the app this MUST be a button. An <a> to the .pkpass is the exact
  // navigation WKWebView cannot complete, so leaving it a link would give the
  // customer a tap that silently does nothing.
  const native = mode === "native";

  return (
    <div className="flex justify-center">
      <Tag
        {...(native
          ? { as: "button" as const, type: "button" as const, onClick: askTheApp }
          : { as: "a" as const, href })}
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
      </Tag>
    </div>
  );
}

/**
 * One badge, two elements. Apple's mark and spacing are identical either way;
 * only the element differs, so the markup is written once and the tag is
 * chosen by the caller rather than duplicating the whole badge in a branch.
 */
function Tag({
  as,
  ...rest
}: { as: "a" | "button" } & ComponentPropsWithoutRef<"a"> &
  ComponentPropsWithoutRef<"button">) {
  const El = as as "a";
  return <El {...(rest as ComponentPropsWithoutRef<"a">)} />;
}
