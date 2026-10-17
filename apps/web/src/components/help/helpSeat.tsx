"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { SeatRole } from "@chairback/config/features";
import type { SetupBrief } from "@chairback/config/onboarding";

/**
 * WHO IS ASKING THE CORNER ASSISTANT.
 *
 * The bubble lives in the root layout, above every page and outside the
 * dashboard's data, so it used to answer everyone as the owner and knew
 * nothing about the shop. The dashboard and setup layouts already know the
 * seat and how far setup is; they hand it over here, and the bubble reads it.
 * Null on a page that hands nothing over (marketing): the bubble's old
 * behaviour.
 */
export interface HelpSeat {
  role: SeatRole;
  /** The shop's setup brief - owners only (config/onboarding.ts setupBrief). */
  setup: SetupBrief | null;
}

let current: HelpSeat | null = null;
const listeners = new Set<() => void>();

function publish(seat: HelpSeat | null) {
  current = seat;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useHelpSeat(): HelpSeat | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** Rendered by a layout that knows the seat. Renders nothing. */
export function HelpSeatSync({ role, setup }: HelpSeat) {
  // The brief arrives as a fresh object each render; its content is the key.
  const key = JSON.stringify(setup);
  useEffect(() => {
    publish({ role, setup });
    return () => publish(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, key]);
  return null;
}
