import { Card } from "@/components/ui/Card";

/**
 * Overview entry into the guided client-experience tour (/demo): a standing
 * "see what your clients see" card so a barber can re-walk the live demo any
 * time — where the mini-site, booking flow, check-in, and rewards page live.
 */
export function ClientDemoCard() {
  return (
    <Card hover className="p-5">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="font-display text-lg">See what your clients see</h2>
          <p className="mt-1 text-sm text-muted">
            Walk the live demo shop — your mini-site, one-tap booking, &ldquo;on my
            way&rdquo; check-in, and the punch card that fills itself.
          </p>
        </div>
        <a
          href="/demo"
          className="shrink-0 rounded-full bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted"
        >
          Take the 2-minute demo →
        </a>
      </div>
    </Card>
  );
}
