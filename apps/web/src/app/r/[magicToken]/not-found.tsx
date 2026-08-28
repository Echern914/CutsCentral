import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { NativeReadySignal } from "@/components/NativeReadySignal";

/**
 * Shown when a rewards magic link is invalid or expired.
 *
 * This page is the single most important rewards-recovery door: everyone who
 * lands here is holding a dead credential, and (once link rotation ships)
 * every ROTATED link in an old text lands exactly here. So it must not be a
 * dead end that says "ask your shop" - the customer can re-earn their link
 * themselves at /my-rewards with the phone number they already own.
 */
export default function RewardsNotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      {/* /r/[token] is the app's awaitsReady source page: without this signal a
          dead link means an eternal native spinner (see NativeReadySignal). */}
      <NativeReadySignal />
      <Card className="p-8 text-center">
        <h1 className="font-display text-2xl">Link not found</h1>
        <p className="mt-2 text-sm text-muted">
          This rewards link isn&apos;t valid anymore - but your rewards
          aren&apos;t lost. Verify your phone number and we&apos;ll take you
          right back to them.
        </p>
        <Link
          href="/my-rewards"
          className="mt-6 flex h-12 w-full items-center justify-center rounded-full bg-gold text-sm font-semibold text-charcoal-900 transition-transform duration-150 hover:scale-[1.01]"
        >
          Find my rewards
        </Link>
        <p className="mt-3 text-xs text-muted">
          Or ask your shop to text you a fresh link.
        </p>
      </Card>
    </main>
  );
}
