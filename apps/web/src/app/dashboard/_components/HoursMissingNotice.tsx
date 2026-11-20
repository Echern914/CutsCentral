import Link from "next/link";
import { nameList } from "@/lib/nameList";

/**
 * People who take appointments here and have no hours yet - so the booking
 * page shows no times for them.
 *
 * A NOTICE, not setup mode. The shop is open (config/onboarding.ts
 * clientsCanBook: someone has hours), so the dashboard stays the dashboard;
 * this names who is missing and goes straight to where hours are set. It is
 * what a shop sees after someone accepts an invitation, because that makes
 * them a new, empty week (services/memberChair.ts in the API).
 *
 * Renders nothing when everyone has hours, which is every one-person shop that
 * finished setup - so their dashboard is exactly as it was.
 */
export function HoursMissingNotice({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const one = names.length === 1;
  return (
    <section
      aria-labelledby="hours-missing-title"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gold/40 bg-gold/5 px-5 py-4"
      data-testid="hours-missing"
    >
      <div className="min-w-0 flex-1">
        <h2 id="hours-missing-title" className="text-sm font-semibold text-offwhite">
          {nameList(names)} {one ? "has" : "have"} no hours yet
        </h2>
        <p className="mt-0.5 text-sm text-muted">
          Clients can&apos;t book {one ? "them" : "any of them"} until their hours are set. Everyone else is open as
          usual.
        </p>
      </div>
      <Link
        href="/dashboard/booking?tab=Staff"
        className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-xl bg-primary px-5 text-sm font-semibold text-on-primary transition-colors hover:bg-primary/90"
      >
        Set hours
      </Link>
    </section>
  );
}
