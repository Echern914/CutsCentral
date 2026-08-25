"use client";

import { useEffect, useRef, useState } from "react";
import { MOBILE_APP } from "@chairback/config/constants";

/**
 * The hop back into the app.
 *
 * WHY A CUSTOM SCHEME AT THE VERY END, when every other link in this flow is a
 * verified https universal link: the system authentication browser
 * (ASWebAuthenticationSession) closes on exactly one signal - a navigation to
 * the callback SCHEME the app registered when it opened the session. Universal
 * links do not dismiss it. So https gets us here, verified, and one final
 * chairback:// navigation hands control back.
 *
 * That hand-off carries only the one-time code and the state, never a session
 * (see auth/mobileHandoff.ts on the API): a scheme can be claimed by any app on
 * the device, so nothing here may be worth stealing. Without the PKCE verifier,
 * which never left the app that started this, the code is inert.
 *
 * WHAT THE PERSON SEES. Usually nothing - the app takes over in a blink. If it
 * doesn't (app not installed, or they finished the flow in ordinary Safari),
 * this stops being a redirect and becomes a page: their seat is already created,
 * so the honest message is "you're in", plus a way to open or install the app.
 */
export function ReturnToApp({ code, state }: { code: string; state: string }) {
  const [showFallback, setShowFallback] = useState(false);
  const target = useRef(
    `${MOBILE_APP.scheme}://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );

  useEffect(() => {
    // Scrub the code out of the address bar (and therefore out of history, the
    // Referer of anything the person taps next, and any analytics pageview that
    // fires after this). The value we need is already captured above.
    window.history.replaceState(null, "", "/auth/mobile/callback");

    window.location.replace(target.current);
    // If the app were installed and listening, this page would be gone by now.
    // Whoever is still reading needs buttons, not a spinner.
    const timer = setTimeout(() => setShowFallback(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="text-center">
      <p className="text-sm text-muted">
        {showFallback
          ? "Still here? Open ChairBack to finish."
          : "Taking you back to ChairBack…"}
      </p>
      {showFallback && (
        <div className="mt-5 flex flex-col gap-3">
          <a
            href={target.current}
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl bg-gold px-5 py-3 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted"
          >
            Open ChairBack
          </a>
          <a
            href={MOBILE_APP.appStoreUrl}
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-subtle px-5 py-3 text-sm font-medium text-offwhite transition-colors duration-200 ease-out hover:bg-white/5"
          >
            Download ChairBack
          </a>
        </div>
      )}
    </div>
  );
}
