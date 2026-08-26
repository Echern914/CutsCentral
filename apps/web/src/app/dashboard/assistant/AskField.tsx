"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { resolveFeature, type SeatRole } from "@chairback/config/features";
import { findHelp, type HelpResponse } from "@chairback/config/helpMatch";
import type { HelpAnswer } from "@chairback/config/help";
import { useIsNativeApp } from "@/lib/useIsNativeApp";

/**
 * "What do you want to do?" — the Assistant's front door.
 *
 * 🔴 THIS COSTS NOTHING TO RUN. Every answer comes from `findHelp`, the
 * hand-written corpus that already ships in the bundle: no network call, no
 * model, no per-message cost, and it physically cannot invent a feature we
 * don't ship. That is the whole design — ChairBack does not pay for AI, so the
 * common questions have to be answerable without any.
 *
 * The corpus names a FEATURE for its destination and the registry resolves it
 * against this seat, so an employee is never handed a manager-only page and the
 * native shell is never handed a billing page.
 *
 * When a question is genuinely personal ("who should I rebook?", "why is MY
 * sync down?") the corpus can only point at the right screen. Connecting a
 * personal ChatGPT or Claude account is what answers those, and that lands in a
 * later PR — this field says so honestly rather than pretending.
 */

/** The examples under the field. Each one is answerable, or points somewhere real. */
const EXAMPLES = [
  "Finish setting up my shop",
  "Show me tomorrow's appointments",
  "Why is my booking page unavailable?",
  "Help me connect Square",
  "Who should I rebook?",
  "Take me to my services",
  "How do I change my cancellation policy?",
  "What openings do I have Friday?",
  "Why did my integration stop syncing?",
];

export function AskField({
  role,
  rewardsEnabled,
}: {
  role: SeatRole;
  rewardsEnabled: boolean;
}) {
  const router = useRouter();
  const inApp = useIsNativeApp();
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState<string | null>(null);

  const ctx = useMemo(
    () => ({
      role,
      inApp: inApp === true,
      flagsOff: rewardsEnabled ? [] : (["rewardsEnabled"] as const),
    }),
    [role, inApp, rewardsEnabled],
  );

  const response: HelpResponse | null = useMemo(
    () => (asked ? findHelp(asked, { inApp: inApp === true }) : null),
    [asked, inApp],
  );

  function ask(q: string) {
    const t = q.trim();
    if (!t) return;
    setQuery(t);
    setAsked(t);
  }

  return (
    <section className="mb-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(query);
        }}
        className="relative"
      >
        <label htmlFor="assistant-ask" className="sr-only">
          What do you want to do?
        </label>
        <input
          id="assistant-ask"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What do you want to do?"
          // 🔴 text-base, not text-sm: iOS Safari zooms the whole page on focus
          // for anything under 16px, and the barber lands on a viewport they
          // have to pinch back out of.
          className="w-full rounded-2xl border border-subtle bg-charcoal-800 px-4 py-3.5 pr-24 text-base text-offwhite placeholder:text-muted focus:border-gold/50 focus:outline-none focus:ring-2 focus:ring-gold/25"
          autoComplete="off"
        />
        <button
          type="submit"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
        >
          Ask
        </button>
      </form>

      {response ? (
        <Answer
          response={response}
          ctx={ctx}
          onPick={(a) => ask(a.q)}
          onGo={(href) => router.push(href)}
        />
      ) : (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <li key={e}>
              <button
                type="button"
                onClick={() => ask(e)}
                className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:border-gold/30 hover:text-offwhite"
              >
                {e}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Answer({
  response,
  ctx,
  onPick,
  onGo,
}: {
  response: HelpResponse;
  ctx: { role: SeatRole; inApp: boolean; flagsOff: readonly "rewardsEnabled"[] };
  onPick: (a: HelpAnswer) => void;
  onGo: (href: string) => void;
}) {
  const answer = response.answer;
  const resolved = answer?.action
    ? resolveFeature(answer.action.featureId, { ...ctx, flagsOff: [...ctx.flagsOff] })
    : null;
  const destination = resolved?.ok ? resolved : null;

  return (
    <div className="mt-3 rounded-2xl border border-subtle bg-charcoal-800/60 px-4 py-4">
      {answer ? (
        <>
          {answer.a.split("\n\n").map((para, i) => (
            <p key={i} className="mb-2 whitespace-pre-line text-sm leading-relaxed text-offwhite">
              {para}
            </p>
          ))}
          {destination && (
            <button
              type="button"
              onClick={() => onGo(destination.href)}
              className="mt-1 rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
            >
              {answer.action!.label} →
            </button>
          )}
        </>
      ) : (
        // findHelp never dead-ends: when it isn't confident it hands back the
        // closest topics rather than a shrug.
        <p className="mb-2 text-sm leading-relaxed text-offwhite">
          I&apos;m not certain what you meant. These are the closest things I know:
        </p>
      )}

      {response.suggestions.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {response.suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s)}
                className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:border-gold/30 hover:text-offwhite"
              >
                {s.q}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
