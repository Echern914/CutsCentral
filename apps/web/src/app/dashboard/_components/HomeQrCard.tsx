"use client";

import { useToast } from "@/components/ui/Toast";
import { ShopQrCard } from "@/app/dashboard/booking/ShopQrCard";

/**
 * The shop's booking QR on the dashboard home.
 *
 * Exists only to cross the server/client boundary: the home page is a SERVER
 * component and `ShopQrCard` needs a `toast` callback, which is a function and
 * therefore not serializable across that line. This wrapper supplies it from
 * the client-side provider and renders the very same card the Booking →
 * Settings tab does — one implementation, so the two can never drift.
 *
 * On the home page because that is where a barber is standing when someone asks
 * "how do I book you?" — hunting through Booking → Settings for it is exactly
 * the friction the code was meant to remove.
 */
export function HomeQrCard({
  bookUrl,
  shopName,
}: {
  bookUrl: string;
  shopName: string;
}) {
  const { toast } = useToast();
  return <ShopQrCard bookUrl={bookUrl} shopName={shopName} toast={toast} />;
}
