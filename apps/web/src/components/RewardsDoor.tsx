import Link from "next/link";

/**
 * The rewards-recovery door for PUBLIC shop surfaces - one quiet line that
 * takes a customer who lost their rewards text to /my-rewards, where the
 * verified PHONE is the identity and the link is re-earned in three taps.
 *
 * One line, muted, below the fold: these pages exist to get someone booked
 * or through the line, and the door must never compete with that. It also
 * says nothing about the customer - /my-rewards is shop-agnostic, reveals
 * nothing until a phone is verified, and this link carries no state at all.
 *
 * Deliberately NOT on the kiosk (Eric's call): a shared tablet is the wrong
 * place to start a personal recovery flow.
 */
export function RewardsDoor() {
  return (
    <p className="mt-6 text-center text-xs text-muted">
      Lost your rewards link?{" "}
      <Link
        href="/my-rewards"
        className="font-medium text-gold underline-offset-2 hover:underline"
      >
        Find my rewards
      </Link>
    </p>
  );
}
