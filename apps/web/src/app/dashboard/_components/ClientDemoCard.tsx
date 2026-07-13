import { Card } from "@/components/ui/Card";

/**
 * Overview entry into the guided tours: the client-experience demo (/demo) and
 * a replayable dashboard walkthrough (?tour=1 on this page) so a barber can
 * always come back and see where things live.
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
          <a
            href="/dashboard?tour=1"
            className="mt-2 inline-block text-xs font-medium text-gold hover:underline"
          >
            Or tour this dashboard — where everything lives →
          </a>
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
