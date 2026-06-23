"use client";

import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { pressable } from "@/components/motion/variants";
import { optInAction, optOutAction } from "./actions";
import { surfaceStyle, type RewardsTheme } from "./theme";

type ConsentState = "opted_in" | "needs_consent" | "opted_out";

/**
 * Client-facing SMS consent control on the rewards page. Prominent when there's
 * no consent on file (the main lever for closing the consent gap); collapses to
 * a quiet "manage" line once opted in. Writes flow through the same fields the
 * nudge eligibility gate reads, so an opt-in here makes the client textable.
 *
 * Fully theme-driven: renders against the shop's resolved RewardsTheme so it
 * matches the barber's identity rather than the generic app chrome.
 */
export function ConsentCard({
  magicToken,
  shopName,
  theme,
  initialState,
  initialHasPhone,
}: {
  magicToken: string;
  shopName: string;
  theme: RewardsTheme;
  initialState: ConsentState;
  initialHasPhone: boolean;
}) {
  const [state, setState] = useState<ConsentState>(initialState);
  const [hasPhone, setHasPhone] = useState(initialHasPhone);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function optIn() {
    setError(null);
    if (!hasPhone && !phone.trim()) {
      setError("Enter your mobile number so we can text you.");
      return;
    }
    startTransition(async () => {
      const res = await optInAction(magicToken, hasPhone ? undefined : phone.trim());
      if (!res.ok) {
        setError(
          res.error === "invalid_phone"
            ? "That number doesn't look right. Try a US number like (302) 555-0142."
            : res.error === "needs_phone"
              ? "Enter your mobile number so we can text you."
              : "Something went wrong. Please try again.",
        );
        return;
      }
      setState("opted_in");
      setHasPhone(true);
    });
  }

  function optOut() {
    setError(null);
    startTransition(async () => {
      const res = await optOutAction(magicToken);
      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }
      setState("opted_out");
    });
  }

  // Opted in: quiet confirmation + a way to stop.
  if (state === "opted_in") {
    return (
      <p className="px-1 text-center text-xs" style={{ color: theme.muted }}>
        You&apos;re getting texts from {shopName}.{" "}
        <button
          type="button"
          onClick={optOut}
          disabled={pending}
          className="underline underline-offset-2 transition-colors duration-150 ease-out disabled:opacity-50"
        >
          Stop texts
        </button>
      </p>
    );
  }

  // Opted out: quiet line with a way back in.
  if (state === "opted_out") {
    return (
      <p className="px-1 text-center text-xs" style={{ color: theme.muted }}>
        You&apos;ve opted out of texts.{" "}
        <button
          type="button"
          onClick={optIn}
          disabled={pending}
          className="underline underline-offset-2 transition-colors duration-150 ease-out disabled:opacity-50"
          style={{ color: theme.accent }}
        >
          Resume texts
        </button>
      </p>
    );
  }

  // Needs consent: the prominent opt-in card.
  return (
    <div className="relative overflow-hidden p-5" style={surfaceStyle(theme)}>
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ backgroundColor: theme.accent }}
        aria-hidden
      />
      <p className="text-sm font-semibold">
        Get rebooking reminders &amp; rewards by text
      </p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: theme.muted }}>
        Tap below to let {shopName} text you when it&apos;s time for your next
        visit and when rewards are ready. Message &amp; data rates may apply.
        Message frequency varies. Reply STOP to cancel anytime. Consent is not a
        condition of purchase.
      </p>
      {!hasPhone && (
        <input
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Your mobile number"
          aria-label="Your mobile number"
          className="mt-3 w-full px-4 py-2.5 text-sm focus:outline-none"
          style={{
            backgroundColor: theme.bg,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radius,
            color: theme.text,
            colorScheme: theme.scheme,
          }}
        />
      )}
      {error && (
        <p className="mt-2 text-xs" style={{ color: "#ef4444" }}>
          {error}
        </p>
      )}
      <motion.button
        {...pressable}
        type="button"
        onClick={optIn}
        disabled={pending}
        className="mt-3 w-full px-5 py-2.5 text-sm font-semibold transition-all duration-150 ease-out disabled:pointer-events-none disabled:opacity-50"
        style={{
          backgroundColor: theme.accent,
          color: theme.onAccent,
          borderRadius: theme.buttonRadius,
          boxShadow: `0 8px 30px -10px ${theme.accent}AA`,
        }}
      >
        {pending ? "Saving…" : "Text me reminders & rewards"}
      </motion.button>
    </div>
  );
}
