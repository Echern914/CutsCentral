"use client";

import { useEffect, useState } from "react";

/**
 * True when this page runs inside an app build whose Rewards tab carries a
 * client's whole rewards - the rebooking timer, the punch card, the deals, what
 * they've claimed. Those builds say so before any page script runs
 * (`window.__cbNative.rewardsTab`, AppWebView's ANNOUNCE_CAPABILITIES).
 *
 * 🔴 AN OLDER BUILD SAYS NOTHING, and keeps the page's own "Your rewards": its
 * Rewards tab has no timer, so taking the button away there would take the
 * timer away from the client until they updated.
 *
 * False until mounted (the bridge is browser-only), which renders the button
 * by default - the safe side.
 */
export function useAppHasRewardsTab(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    const w = window as { __cbNative?: { rewardsTab?: boolean }; ReactNativeWebView?: unknown };
    setHas(w.__cbNative?.rewardsTab === true && Boolean(w.ReactNativeWebView));
  }, []);
  return has;
}
