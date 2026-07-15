"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  CADENCE_KEYS,
  CADENCE_OPTIONS,
  type CadenceKey,
} from "@chairback/config/constants";
import { pressable } from "@/components/motion/variants";
import { setCadenceAction } from "./actions";
import { surfaceStyle, type RewardsTheme } from "./theme";

/** Per-token "skipped" flag so a dismissal sticks on this device. */
const skipKey = (token: string) => `cb:cadence-skipped:${token}`;

/**
 * One-tap cold-start prompt: "How often do you usually get a cut?". Shown once to
 * a brand-new client (no stated cadence and not enough visit history to compute
 * one) so the rebook countdown + reminders can be timed to THEM from day one,
 * instead of the shop's flat default. A single tap writes the answer; "Skip"
 * suppresses it on this device. Fully theme-driven to match the shop's identity.
 *
 * Visibility is decided AFTER mount: the skip flag lives in localStorage
 * (client-only), so rendering it during SSR would risk a hydration mismatch -
 * the card fades in just after hydration instead.
 */
export function CadenceCard({
  magicToken,
  theme,
}: {
  magicToken: string;
  theme: RewardsTheme;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let skipped = false;
    try {
      skipped = localStorage.getItem(skipKey(magicToken)) === "1";
    } catch {
      // localStorage can throw (private mode / disabled). Default to showing it.
    }
    setDismissed(skipped);
    setMounted(true);
  }, [magicToken]);

  function choose(key: CadenceKey) {
    setError(null);
    startTransition(async () => {
      const res = await setCadenceAction(magicToken, key);
      if (!res.ok) {
        setError("Couldn't save that. Please try again.");
        return;
      }
      setDismissed(true);
      // Re-fetch so the personalized rebook countdown reflects the new cadence.
      router.refresh();
    });
  }

  function skip() {
    try {
      localStorage.setItem(skipKey(magicToken), "1");
    } catch {
      // Best-effort: if we can't persist the skip, still hide it this session.
    }
    setDismissed(true);
  }

  if (!mounted || dismissed) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      <div className="relative overflow-hidden p-5" style={surfaceStyle(theme)}>
        <div
          className="absolute inset-y-0 left-0 w-1"
          style={{ backgroundColor: theme.accent }}
          aria-hidden
        />
        <p className="text-sm font-semibold">How often do you usually get a cut?</p>
        <p className="mt-1 text-xs leading-relaxed" style={{ color: theme.muted }}>
          We&apos;ll time your rebooking reminders to match — no guessing.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {CADENCE_KEYS.map((key) => (
            <motion.button
              {...pressable}
              key={key}
              type="button"
              disabled={pending}
              onClick={() => choose(key)}
              className="px-3.5 py-2 text-sm font-medium transition-all duration-150 ease-out disabled:opacity-50"
              style={{
                backgroundColor: theme.bg,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.buttonRadius,
                color: theme.text,
              }}
            >
              {CADENCE_OPTIONS[key].label}
            </motion.button>
          ))}
        </div>
        {error && (
          <p
            role="alert"
            className="mt-2 flex items-start gap-1.5 text-xs"
            style={{ color: "#ef4444" }}
          >
            {/* Non-color cue so the error reads without relying on red (WCAG 1.4.1). */}
            <span aria-hidden="true">⚠</span>
            <span>{error}</span>
          </p>
        )}
        <button
          type="button"
          onClick={skip}
          disabled={pending}
          className="mt-3 w-full text-center text-xs underline underline-offset-2 transition-colors duration-150 ease-out disabled:opacity-50"
          style={{ color: theme.muted }}
        >
          Skip for now
        </button>
      </div>
    </motion.div>
  );
}
