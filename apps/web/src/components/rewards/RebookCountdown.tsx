"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { surfaceStyle, type RewardsTheme } from "@/app/r/[magicToken]/theme";

/** Urgency colors. Normal countdown uses the shop's accent; urgent/overdue use a
 *  universal danger red and "booked" a universal green - these read as their
 *  meaning regardless of the shop's accent (you don't want "overdue" rendered in
 *  a cheerful brand color). */
const DANGER = "#ef4444";
const SUCCESS = "#10b981";

export interface RebookInfo {
  state: "booked" | "counting" | "overdue" | "none";
  deadline: string | null; // ISO
  windowDays: number;
  upcomingAt: string | null; // ISO
}

interface Remaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
}

function diff(toISO: string): Remaining {
  const totalMs = Math.max(0, new Date(toISO).getTime() - Date.now());
  const s = Math.floor(totalMs / 1000);
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
    totalMs,
  };
}

/**
 * Live rebooking countdown. Ticks every second toward the shop's rebook window
 * deadline. Color/urgency escalates as time runs low. The whole point: nudge the
 * client to rebook inside a tight window so an in-demand barber keeps their chair
 * full. Respects reduced motion (no pulsing). Surfaces are theme-driven; the
 * urgency accents are intentionally fixed (danger/success) so they read clearly
 * on any shop theme.
 */
export function RebookCountdown({
  rebook,
  bookingUrl,
  theme,
}: {
  rebook: RebookInfo;
  bookingUrl: string | null;
  theme: RewardsTheme;
}) {
  const reduce = useReducedMotion();
  const [now, setNow] = useState(0); // tick trigger
  // Live clock math can't render on the server: the SSR HTML's seconds would
  // never match the client's hydration pass (guaranteed hydration error).
  // Render a stable shell first; start the clock after mount.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (rebook.state !== "counting") return;
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [rebook.state]);
  // reference now so the lint/render re-runs each tick
  void now;

  void bookingUrl; // parent renders the booking CTA; kept for API stability.

  // Already rebooked - celebrate, no timer.
  if (rebook.state === "booked" && rebook.upcomingAt) {
    const when = mounted
      ? new Date(rebook.upcomingAt).toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
    return (
      <div
        className="p-5 text-center"
        style={{ ...surfaceStyle(theme), borderColor: `${SUCCESS}4D` }}
      >
        <p className="text-xs uppercase tracking-[0.18em]" style={{ color: SUCCESS }}>
          You&apos;re booked
        </p>
        <p className="mt-1 min-h-5 text-sm">
          {when ? `Next visit: ${when}` : "See you soon."}
        </p>
      </div>
    );
  }

  // No history yet - gentle prompt, no countdown.
  if (rebook.state === "none" || !rebook.deadline) {
    return null;
  }

  if (!mounted) {
    // Same-size placeholder so the card doesn't jump when the clock appears.
    return (
      <div
        className="p-5"
        style={{ ...surfaceStyle(theme), borderColor: `${theme.accent}4D` }}
      >
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.18em]" style={{ color: theme.muted }}>
            Time left to rebook
          </p>
          <div
            className="mx-auto mt-3 h-14 w-64 max-w-full rounded-xl"
            style={{ backgroundColor: theme.border }}
          />
          <p className="mt-3 text-xs" style={{ color: theme.muted }}>
            Rebook within {rebook.windowDays} days to keep your streak.
          </p>
        </div>
      </div>
    );
  }

  const r = diff(rebook.deadline);
  const overdue = rebook.state === "overdue" || r.totalMs === 0;

  // Urgency tiers drive the accent color + label. Normal = shop accent; urgent
  // or overdue = danger red.
  const urgent = !overdue && r.days < 2;
  const urgencyColor = overdue || urgent ? DANGER : theme.accent;

  return (
    <div
      className="p-5"
      style={{ ...surfaceStyle(theme), borderColor: `${urgencyColor}4D` }}
    >
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.18em]" style={{ color: theme.muted }}>
          {overdue ? "It's time for your next visit" : "Time left to rebook"}
        </p>

        {overdue ? (
          <p
            className="mt-2 text-2xl"
            style={{ color: urgencyColor, fontFamily: "var(--page-display)" }}
          >
            Don&apos;t lose your spot
          </p>
        ) : (
          <motion.div
            className="mt-3 flex items-center justify-center gap-3"
            animate={urgent && !reduce ? { scale: [1, 1.03, 1] } : undefined}
            transition={urgent && !reduce ? { duration: 1.4, repeat: Infinity } : undefined}
          >
            <TimeBlock value={r.days} label="days" color={urgencyColor} muted={theme.muted} />
            <Colon muted={theme.muted} />
            <TimeBlock value={r.hours} label="hrs" color={urgencyColor} muted={theme.muted} />
            <Colon muted={theme.muted} />
            <TimeBlock value={r.minutes} label="min" color={urgencyColor} muted={theme.muted} />
            <Colon muted={theme.muted} />
            <TimeBlock value={r.seconds} label="sec" color={urgencyColor} muted={theme.muted} />
          </motion.div>
        )}

        <p className="mt-3 text-xs" style={{ color: theme.muted }}>
          {overdue
            ? `Book now to stay on track.`
            : urgent
              ? `Your window closes soon. Grab a slot.`
              : `Rebook within ${rebook.windowDays} days to keep your streak.`}
        </p>
      </div>
    </div>
  );
}

function TimeBlock({
  value,
  label,
  color,
  muted,
}: {
  value: number;
  label: string;
  color: string;
  muted: string;
}) {
  return (
    <div className="flex w-14 flex-col items-center">
      <span
        className="text-3xl tabular-nums"
        style={{ color, fontFamily: "var(--page-display)" }}
      >
        {String(value).padStart(2, "0")}
      </span>
      <span className="mt-0.5 text-[10px] uppercase tracking-wide" style={{ color: muted }}>
        {label}
      </span>
    </div>
  );
}

function Colon({ muted }: { muted: string }) {
  return (
    <span className="text-2xl" style={{ color: muted, fontFamily: "var(--page-display)" }}>
      :
    </span>
  );
}
