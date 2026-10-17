"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { saveShopTimezoneAction } from "./actions";

/** Quiet-hours (TCPA) enforcement keys off the shop's zone - every US zone is listed. */
const US_ZONES: [string, string][] = [
  ["America/New_York", "Eastern (New York)"],
  ["America/Chicago", "Central (Chicago)"],
  ["America/Denver", "Mountain (Denver)"],
  ["America/Phoenix", "Arizona (Phoenix, no DST)"],
  ["America/Los_Angeles", "Pacific (Los Angeles)"],
  ["America/Anchorage", "Alaska (Anchorage)"],
  ["Pacific/Honolulu", "Hawaii (Honolulu)"],
  ["America/Puerto_Rico", "Atlantic (Puerto Rico)"],
];

/**
 * The shop's time zone. Setup reads it from the owner's device; this is where
 * it's put right if that was wrong (Account → "Shop time zone" points here).
 * Hours are clock times in this zone, so they stay as set; a booking already
 * made keeps its moment, so it shows at the new zone's clock time - said
 * before saving, because a wrong zone is usually fixed before any booking.
 */
export function ShopTimezoneCard({ current }: { current: string }) {
  const [zone, setZone] = useState(current);
  const [device, setDevice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(current);

  useEffect(() => {
    try {
      setDevice(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    } catch {
      setDevice(null);
    }
  }, []);

  const extra = [saved, device].filter((z): z is string => Boolean(z) && !US_ZONES.some(([u]) => u === z));
  const options: [string, string][] = [...new Set(extra)].map((z) => [z, z.replace(/_/g, " ")] as [string, string]).concat(US_ZONES);
  const changed = zone !== saved;

  async function save() {
    if (busy.current || !changed) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await saveShopTimezoneAction(zone);
      if (res.ok) setSaved(zone);
      else setError("Couldn't change the time zone. Try again.");
    } catch {
      setError("No answer from ChairBack. Check your connection, then reload to see whether it changed.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <Card id="shop-timezone">
      <CardHeader title="Time zone" subtitle="Your hours, reminders and texts all run on your shop's time." />
      <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          aria-label="Shop time zone"
          className="h-11 min-w-[12rem] max-w-full flex-1 rounded-xl border border-subtle bg-charcoal-700 px-3 text-sm text-offwhite sm:h-9"
        >
          {options.map(([z, label]) => (
            <option key={z} value={z}>
              {label}
              {z === device && z !== saved ? " (this device)" : ""}
            </option>
          ))}
        </select>
        {changed && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={pending}
            className="h-11 rounded-lg bg-gold px-4 text-sm font-semibold text-charcoal-900 disabled:opacity-50 sm:h-9"
          >
            {pending ? "Saving…" : "Save time zone"}
          </button>
        )}
      </div>
      {changed && (
        <p className="mt-2 text-xs text-muted" data-testid="timezone-warning">
          Your hours stay the same on the clock. Bookings already made keep their moment, so they&apos;ll show at this
          zone&apos;s time.
        </p>
      )}
      {!changed && device && device !== saved && (
        <p className="mt-2 text-xs text-muted">This device is set to {device.replace(/_/g, " ")}.</p>
      )}
      <FormError className="mt-2 text-sm">{error}</FormError>
      </div>
    </Card>
  );
}
