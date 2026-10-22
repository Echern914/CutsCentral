"use client";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { CONNECT_CARD_NAMES } from "./connectCardNames";

/**
 * A shop whose public page has no way to book: not booking on ChairBack, and
 * no outside booking link saved (the page's Book button opens that link).
 *
 * 🔴 IT NAMES THE CONTROL BY ITS REAL NAME, AND SAYS WHERE IT IS. It used to
 * tell the barber to "switch to Run booking on ChairBack ... below", but the
 * switch is the "ChairBack Booking" card on the SETTINGS tab, and this banner
 * sits above every tab. A barber who had set up his services, himself and his
 * hours (2026-10-22) still had a dead booking link, because the one control
 * that turns booking on was described by a name that is nowhere on screen.
 * So: the card's own name, the tab it is on, and a button that opens it.
 *
 * `onOpenSettings` is null while the Settings tab is already showing.
 */
export function NoBookingLinkBanner({
  mode,
  onOpenSettings,
}: {
  mode: string;
  onOpenSettings: (() => void) | null;
}) {
  return (
    <Card className="flex flex-col gap-3 border-gold/30 bg-gold/5 px-5 py-4">
      <p className="text-sm text-gold">
        {mode === "square" ? (
          <>
            Square is syncing your appointments, but your public page has no Book
            button yet. Paste your Square booking-site link in{" "}
            <strong>Your booking link</strong> on the <strong>Settings</strong> tab so
            clients can book straight from your page.
          </>
        ) : mode === "acuity" ? (
          <>
            Acuity is syncing your appointments, but your public page has no Book
            button yet. Paste your Acuity scheduling link in{" "}
            <strong>Your booking link</strong> on the <strong>Settings</strong> tab so
            clients can book straight from your page.
          </>
        ) : (
          <>
            Clients can&apos;t book you yet. To take bookings right here, tap{" "}
            <strong>{CONNECT_CARD_NAMES.native}</strong> on the <strong>Settings</strong> tab. Book
            somewhere else, like Booksy? Paste that link in{" "}
            <strong>Your booking link</strong> there instead. Until you do one of these,
            customers can only request a time.
          </>
        )}
      </p>
      {onOpenSettings && (
        <Button type="button" onClick={onOpenSettings} className="self-start">
          Open Settings
        </Button>
      )}
    </Card>
  );
}
