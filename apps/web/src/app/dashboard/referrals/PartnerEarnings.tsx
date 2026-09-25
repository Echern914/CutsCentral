"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { APP_NAME } from "@chairback/config/constants";
import { PARTNER_PROGRAM } from "@chairback/config/partnerProgram";
import { formatTierMoney as money } from "@chairback/config/tierRules";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { LocalDate } from "@/components/ui/LocalDate";
import { useToast } from "@/components/ui/Toast";
import { requestCashoutAction } from "./actions";

/** GET /api/partner/me - see services/partnerProgram.ts partnerForUser. */
export interface PartnerMe {
  name: string;
  code: string;
  active: boolean;
  standing: {
    signups: number;
    qualified: number;
    unlock: {
      unlocked: boolean;
      unlockedAt: string | null;
      window: { opensAt: string; closesAt: string; count: number; open: boolean } | null;
    };
    earnedCents: number;
    lockedCents: number;
    availableCents: number;
    requestedCents: number;
    paidOutCents: number;
  };
  cashouts: { id: string; amountCents: number; status: "REQUESTED" | "PAID"; requestedAt: string; paidAt: string | null }[];
}

const REFUSAL_COPY: Record<string, string> = {
  locked: "Cashout unlocks once enough of your referrals are paying.",
  insufficient_balance: "That's more than your available balance.",
  invalid_amount: `Cashouts are ${PARTNER_PROGRAM.cashoutAmountsCents.map(money).join(" or ")}.`,
  inactive: `Your referral code is paused, so cashouts are too. Get in touch with ${APP_NAME}.`,
};

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/**
 * A partner's earnings: their code, who signed up with it, what they've earned,
 * how close cashout is, and the $25 / $50 request. Nothing here pays anyone - a
 * request goes to the platform admin, who pays it by hand. The balance shown is only
 * ever what the server just computed; after a request the page re-reads it.
 */
export function PartnerEarnings({ me }: { me: PartnerMe }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = me.standing;
  const { referrals, windowDays } = PARTNER_PROGRAM.unlock;

  async function ask(amountCents: number) {
    if (pending !== null) return;
    setPending(amountCents);
    setError(null);
    try {
      const r = await requestCashoutAction(amountCents);
      if (r.ok) {
        toast(`Cashout of ${money(amountCents)} requested`, "success");
        router.refresh();
      } else {
        setError(REFUSAL_COPY[r.error ?? ""] ?? "Couldn't request that cashout. Nothing was requested.");
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <Card className="mb-6 p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-muted">Affiliate earnings</p>
      <p className="mt-1 font-display text-2xl tracking-tight">
        Your code: <span className="text-gold">{me.code}</span>
      </p>
      <p className="mt-1 text-sm text-muted">
        You earn {money(PARTNER_PROGRAM.rewardCents)}, once, for each business that signs up with your
        code and pays for a plan.
        {me.active ? null : " Your code is paused right now."}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Signed up" value={String(s.signups)} />
        <Stat label="Paying" value={String(s.qualified)} />
        <Stat label="Earned" value={money(s.earnedCents)} />
        <Stat label="Available" value={money(s.availableCents)} accent />
      </dl>

      <p className="mt-4 text-sm" data-testid="unlock-progress">
        {s.unlock.unlocked ? (
          "Cashout is unlocked."
        ) : s.unlock.window === null ? (
          `Cashout unlocks when ${referrals} of your referrals are paying within ${windowDays} days of the first.`
        ) : s.unlock.window.open ? (
          <>
            {s.unlock.window.count} of {referrals} within {windowDays} days, window closes{" "}
            <LocalDate iso={s.unlock.window.closesAt} options={SHORT_DATE} />.
          </>
        ) : (
          <>
            Your last window closed with {s.unlock.window.count} of {referrals}. Your next paying
            referral starts a new {windowDays}-day window.
          </>
        )}
        {s.lockedCents > 0 ? (
          <span className="text-muted"> {money(s.lockedCents)} is waiting for it.</span>
        ) : null}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {PARTNER_PROGRAM.cashoutAmountsCents.map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => void ask(amount)}
            disabled={!s.unlock.unlocked || !me.active || s.availableCents < amount || pending !== null}
            className="rounded-full bg-gold-gradient px-4 py-2 text-sm font-semibold text-charcoal disabled:opacity-40"
          >
            {pending === amount ? "Requesting…" : `Cash out ${money(amount)}`}
          </button>
        ))}
      </div>
      <FormError className="mt-2">{error}</FormError>

      {me.cashouts.length > 0 ? (
        <ul className="mt-4 divide-y divide-subtle/60 text-sm">
          {me.cashouts.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2">
              <span>
                {money(c.amountCents)} ·{" "}
                <LocalDate iso={c.requestedAt} options={SHORT_DATE} className="text-muted" />
              </span>
              <span className={c.status === "PAID" ? "text-emerald-soft" : "text-muted"}>
                {c.status === "PAID" ? "Paid" : "Requested"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-display text-xl ${accent ? "text-gold" : "text-offwhite"}`}>{value}</dd>
    </div>
  );
}
