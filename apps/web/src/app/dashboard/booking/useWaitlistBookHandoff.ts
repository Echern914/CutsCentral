"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WAITLIST_BOOK_EVENT, type WaitlistBookDetail } from "./WaitlistBoard";

/**
 * "Book appointment" on the WAITLIST TAB.
 *
 * The board hands off with a window event that BookingCalendar listens for -
 * but the booking page's tabs are exclusive, so on the Waitlist tab the
 * calendar is not mounted and the event landed nowhere. The button simply did
 * nothing (Drick, 2026-09-24). This catches the event whenever the calendar is
 * NOT on screen, remembers the entry, and asks to go to the calendar; the
 * calendar takes `pending` on mount and opens the same form it always does.
 *
 * While the calendar IS on screen, this stays out of the way entirely: the
 * calendar's own listener handles the event, and two listeners would open it
 * twice.
 */
export function useWaitlistBookHandoff(
  calendarOnScreen: boolean,
  goToCalendar: () => void,
): { pending: WaitlistBookDetail | null; taken: () => void } {
  const [pending, setPending] = useState<WaitlistBookDetail | null>(null);
  const taken = useCallback(() => setPending(null), []);
  // Latest navigation, without re-subscribing on every render of the page.
  const go = useRef(goToCalendar);
  go.current = goToCalendar;

  useEffect(() => {
    if (calendarOnScreen) return;
    const onBook = (e: Event) => {
      setPending((e as CustomEvent<WaitlistBookDetail>).detail);
      go.current();
    };
    window.addEventListener(WAITLIST_BOOK_EVENT, onBook);
    return () => window.removeEventListener(WAITLIST_BOOK_EVENT, onBook);
  }, [calendarOnScreen]);

  return { pending, taken };
}
