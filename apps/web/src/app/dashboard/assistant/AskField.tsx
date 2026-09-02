"use client";

import { useMemo, useState } from "react";
import { flagsOffFor } from "@chairback/config/features";
import { useRouter } from "next/navigation";
import type { SeatRole } from "@chairback/config/features";
import {
  actorForSeat,
  resolveSupport,
  resolveSupportAnswerById,
  type SupportResolution,
} from "@chairback/config/supportEngine";
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
 * personal ChatGPT or Claude account is what answers those — this field says so
 * honestly rather than pretending.
 *
 * 🔴 THE ANSWER IS NOT DECIDED HERE. `resolveSupport` in @chairback/config is
 * the one brain: it matches the question, checks this seat may receive the
 * answer, resolves the destination, and — when it cannot answer — attaches the
 * route to a human. This field used to run the matcher itself and render chips
 * with NO way to reach a person, which made the page titled "Assistant" the
 * only dead end in the product. Rendering `resolution.escalation` whenever it
 * is non-null is what keeps that fixed; the invariant is the engine's, so the
 * bubble and this field cannot drift apart again.
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
  affiliateProgramEnabled,
}: {
  role: SeatRole;
  rewardsEnabled: boolean;
  affiliateProgramEnabled: boolean;
}) {
  const router = useRouter();
  const inApp = useIsNativeApp();
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState<{ kind: "text" | "id"; value: string } | null>(null);

  const request = useMemo(
    () => ({
      actor: actorForSeat(role),
      channel: "in_app" as const,
      seat: {
        role,
        inApp: inApp === true,
        flagsOff: flagsOffFor({ rewardsEnabled, affiliateProgramEnabled }),
      },
    }),
    [role, inApp, rewardsEnabled, affiliateProgramEnabled],
  );

  // A tapped chip resolves BY ID rather than by re-typing its question: the
  // corpus guarantees a canonical question matches itself, but going through
  // the matcher again to find a thing we already have is a guess where an
  // exact answer exists.
  const resolution: SupportResolution | null = useMemo(() => {
    if (!asked) return null;
    return asked.kind === "id"
      ? resolveSupportAnswerById(asked.value, request)
      : resolveSupport({ question: asked.value, ...request });
  }, [asked, request]);

  function ask(q: string) {
    const t = q.trim();
    if (!t) return;
    setQuery(t);
    setAsked({ kind: "text", value: t });
  }

  function openTopic(id: string, label: string) {
    setQuery(label);
    setAsked({ kind: "id", value: id });
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

      {resolution ? (
        <Answer
          resolution={resolution}
          onPick={(id, label) => openTopic(id, label)}
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
  resolution,
  onPick,
  onGo,
}: {
  resolution: SupportResolution;
  onPick: (id: string, label: string) => void;
  onGo: (href: string) => void;
}) {
  const { answer, suggestions, escalation } = resolution;

  return (
    <div className="mt-3 rounded-2xl border border-subtle bg-charcoal-800/60 px-4 py-4">
      {answer ? (
        <>
          {answer.body.split("\n\n").map((para, i) => (
            <p key={i} className="mb-2 whitespace-pre-line text-sm leading-relaxed text-offwhite">
              {para}
            </p>
          ))}
          {answer.action && (
            <button
              type="button"
              onClick={() => onGo(answer.action!.href)}
              className="mt-1 rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
            >
              {answer.action.label} →
            </button>
          )}
        </>
      ) : (
        <p className="mb-2 text-sm leading-relaxed text-offwhite">
          I don&apos;t have that one written up exactly. Here&apos;s the closest — or email a
          human and we&apos;ll answer it properly.
        </p>
      )}

      {suggestions.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onPick(s.id, s.question)}
                className="rounded-full border border-subtle px-3 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:border-gold/30 hover:text-offwhite"
              >
                {s.question}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 🔴 THE NO-DEAD-END RULE, rendered. The engine attaches an escalation
          to every outcome except ANSWERED, so if it handed one over, it goes on
          the screen — this field previously offered chips and nothing else. */}
      {escalation && (
        <a
          href={`mailto:${escalation.email}?subject=${encodeURIComponent(
            "ChairBack question",
          )}&body=${encodeURIComponent(escalation.summary)}`}
          className="mt-3 inline-block text-xs font-semibold text-gold underline underline-offset-2"
        >
          Email {escalation.email}
        </a>
      )}
    </div>
  );
}
