import Link from "next/link";
import { LocalDate } from "@/components/ui/LocalDate";
import type { StripeAlert } from "@/lib/stripeAlert";

/**
 * THE SHOP'S STRIPE ACCOUNT NEEDS THEM - at the top of every dashboard page,
 * for owners and managers, while Stripe is holding payouts, has paused card
 * payments, has closed the account, or wants details by a deadline.
 *
 * Why: those warnings lived only in the platform's own Stripe dashboard. A
 * barber charged a no-show fee on an account Stripe was closing, and found out
 * only by going looking for the money (2026-11-19). The Payments page lists
 * what Stripe wants; this banner is how a barber knows to go there.
 *
 * Not dismissible: it is about money, and it goes away by itself once Stripe
 * has what it needs. Renders nothing for a null alert. No hooks, so the layout
 * renders it on the server.
 */

const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** The banner's words for one alert. Exported for the tests. */
export function stripeAlertCopy(alert: StripeAlert): { title: string; body: string } {
  switch (alert.kind) {
    case "closed":
      return {
        title: "Stripe closed your payments account",
        body: "Card payments can't go through it any more. Open Payments to see where your money is and what to do next.",
      };
    case "payments_paused":
      return {
        title: "Stripe paused your card payments",
        body: "Clients can't pay by card until you finish what Stripe asks for. Payments lists it.",
      };
    case "payouts_paused":
      return {
        title: "Stripe is holding your payouts",
        body: "Card money stays in your Stripe balance and won't reach your bank until you finish what Stripe asks for.",
      };
    case "details_due":
      // Only ever a deadline still ahead (api stripeAlertFor).
      return {
        title: "Stripe needs details from you by",
        body: "Payments lists what Stripe is asking for. Finish them before the deadline.",
      };
  }
}

export function StripeAlertBanner({ alert }: { alert: StripeAlert | null }) {
  if (!alert) return null;
  const { title, body } = stripeAlertCopy(alert);
  const urgent = alert.kind !== "details_due";
  const dueBy = alert.kind === "details_due" ? alert.dueBy : null;
  return (
    <section aria-label="Stripe account" className="mx-auto mt-3 w-full max-w-6xl px-4">
      <div
        role="status"
        data-qa="stripe-alert"
        data-kind={alert.kind}
        className={`flex flex-col gap-2 rounded-2xl border px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
          urgent ? "border-danger-soft/40 bg-danger-soft/10" : "border-warning-soft/40 bg-warning-soft/10"
        }`}
      >
        {/* min-w-0 so the copy wraps instead of widening the page at 320px. */}
        <div className="min-w-0 flex-1 text-xs sm:text-sm">
          <p className="font-semibold text-offwhite">
            {title}
            {dueBy && (
              <>
                {" "}
                <LocalDate iso={dueBy} options={DATE} />
              </>
            )}
          </p>
          <p className="mt-0.5 text-muted">{body}</p>
        </div>
        <Link
          href="/dashboard/payments"
          className="inline-flex min-h-[44px] shrink-0 items-center justify-center self-start rounded-xl bg-primary px-4 text-sm font-semibold text-on-primary sm:self-auto"
        >
          Open Payments
        </Link>
      </div>
    </section>
  );
}
