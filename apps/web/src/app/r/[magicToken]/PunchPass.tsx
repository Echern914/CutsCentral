"use client";

import type { CSSProperties } from "react";
import { CountUp } from "@/components/motion/CountUp";
import { contrastRatio, readableOn } from "@/lib/contrast";
import type { RewardsTheme } from "./theme";

/** The most punches drawn as dots; a longer card shows a bar instead. */
export const PASS_MAX_DOTS = 20;

export interface PunchPassProps {
  theme: RewardsTheme;
  shopName: string;
  /** What the card is called, beside the coin: the shop's name unless a card has its own. */
  title?: string;
  logoUrl: string | null;
  firstName: string | null;
  balance: number;
  next: { name: string; punchCost: number; remaining: number } | null;
  /** Rewards the client can claim now. */
  ready: { name: string }[];
  /** Whether the shop offers any reward at all. */
  hasRewards: boolean;
  /** The corner badge: the loyalty tier they hold, or VIP on an exclusive card. */
  badge: { label: string; color: string | null } | null;
  visits: number;
  /** The shop's "Punch grid" section: off hides the dots, never the count. */
  showDots: boolean;
}

/**
 * The colours a pass is printed in: always a dark card, like a card in a
 * wallet, whatever the page around it. A light page's own ink is dark, so the
 * card takes the ink and the page's paper colour becomes its print; a dark
 * page's raised surface is already dark. A filled punch takes the shop's
 * accent unless the accent would vanish on the card, when it takes the print.
 */
export function passColours(t: RewardsTheme): { card: string; ink: string; punch: string; onPunch: string } {
  const card = t.scheme === "light" ? t.text : t.surface;
  const ink = t.scheme === "light" ? t.bg : t.text;
  const visible = contrastRatio(t.accent, card) >= 2;
  return {
    card,
    ink,
    punch: visible ? t.accent : ink,
    onPunch: visible ? readableOn(t.accent) : card,
  };
}

/** The line under the count: what is ready, what is next, or how it works. */
export function passMessage(p: Pick<PunchPassProps, "ready" | "next" | "hasRewards">): string {
  if (p.ready.length > 0) {
    return p.ready.length === 1 ? `Your ${p.ready[0]!.name} is ready!` : `${p.ready.length} rewards ready to claim!`;
  }
  if (p.next) return `${p.next.remaining} more to your ${p.next.name}`;
  return p.hasRewards ? "Keep visiting to stack up punches" : "Every visit earns punches";
}

/**
 * THE PUNCH CARD AS A PASS. The client's balance printed on a card: the shop's
 * coin and name, their tier, "7 of 10" toward the next reward with a punch for
 * each one, and their name and visits along the foot - the thing they would
 * show at the counter.
 */
export function PunchPass(props: PunchPassProps) {
  const { theme: t, shopName, title, logoUrl, firstName, balance, next, ready, badge, visits, showDots } = props;
  const c = passColours(t);
  const filled = next ? Math.max(0, Math.min(next.punchCost, next.punchCost - next.remaining)) : 0;
  const dots = showDots && next && next.punchCost <= PASS_MAX_DOTS ? next.punchCost : 0;
  const fine: CSSProperties = { color: c.ink, opacity: 0.6 };

  return (
    <div
      className={`relative overflow-hidden p-5 text-left ${ready.length > 0 ? "ring-conic" : ""}`}
      style={{
        color: c.ink,
        background: `radial-gradient(120% 90% at 0% 0%, ${t.accent}38, transparent 60%), ${c.card}`,
        border: `1px solid ${t.border}`,
        borderRadius: `calc(${t.radius} + 0.25rem)`,
        boxShadow: "0 18px 40px -22px rgba(0,0,0,0.55)",
      }}
      data-qa="punch-pass"
    >
      <div className="flex items-center gap-3">
        {logoUrl ? (
          // alt="" on purpose: the shop's name is printed beside it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" style={{ border: `1px solid ${c.ink}33` }} />
        ) : (
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold"
            style={{ backgroundColor: `${c.ink}14`, border: `1px solid ${c.ink}33`, fontFamily: "var(--page-display)" }}
          >
            {shopName.trim().charAt(0).toUpperCase()}
          </span>
        )}
        <p className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-[0.18em]">{title ?? shopName}</p>
        {badge && (
          <span
            className="shrink-0 rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
            style={{
              color: badge.color ?? c.punch,
              backgroundColor: `${badge.color ?? c.punch}24`,
              border: `1px solid ${badge.color ?? c.punch}66`,
            }}
          >
            {badge.label}
          </span>
        )}
      </div>

      <div className="mt-6 flex items-baseline gap-2" style={{ fontFamily: "var(--page-display)" }}>
        {next ? (
          <>
            <span className="text-5xl leading-none tabular-nums">
              <CountUp value={filled} />
            </span>
            <span className="text-xl" style={fine}>
              of {next.punchCost}
            </span>
          </>
        ) : (
          <>
            <span className="text-5xl leading-none tabular-nums">
              <CountUp value={balance} />
            </span>
            <span className="text-xl" style={fine}>
              {balance === 1 ? "punch" : "punches"}
            </span>
          </>
        )}
      </div>
      <p className="mt-2 text-sm font-medium">{passMessage(props)}</p>

      {dots > 0 && (
        <ol
          className="mt-5 flex flex-wrap gap-2"
          aria-label={`${filled} of ${next!.punchCost} punches toward your ${next!.name}`}
        >
          {Array.from({ length: dots }, (_, i) => {
            const done = i < filled;
            const prize = i === dots - 1;
            return (
              <li
                key={i}
                aria-hidden
                className="grid h-[22px] w-[22px] place-items-center rounded-full"
                style={
                  done
                    ? { backgroundColor: c.punch, color: c.onPunch }
                    : { border: `1.5px ${prize ? "dashed" : "solid"} ${c.ink}55`, color: c.ink }
                }
              >
                {done ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                ) : prize ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.7">
                    <rect x="4" y="9" width="16" height="11" rx="1.5" />
                    <path d="M12 9v11M3 9h18M12 9c-1.5-3-5-3.5-5-1.5S10 9 12 9zm0 0c1.5-3 5-3.5 5-1.5S14 9 12 9z" />
                  </svg>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {showDots && next && next.punchCost > PASS_MAX_DOTS && (
        <div
          className="mt-5 h-1.5 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: `${c.ink}22` }}
          role="progressbar"
          aria-label={`Progress toward ${next.name}`}
          aria-valuemin={0}
          aria-valuemax={next.punchCost}
          aria-valuenow={filled}
        >
          <div className="h-full rounded-full" style={{ width: `${(filled / next.punchCost) * 100}%`, backgroundColor: c.punch }} />
        </div>
      )}

      <div className="mt-6 flex items-end justify-between gap-3 pt-4" style={{ borderTop: `1px dashed ${c.ink}33` }}>
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.18em]" style={fine}>
            Member
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold">{firstName?.trim() || "You"}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[10px] uppercase tracking-[0.18em]" style={fine}>
            Visits
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums">{visits}</p>
        </div>
      </div>
    </div>
  );
}
