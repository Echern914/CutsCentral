"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Card } from "@/components/ui/Card";

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
 * full. Respects reduced motion (no pulsing).
 */
export function RebookCountdown({
  rebook,
  bookingUrl,
}: {
  rebook: RebookInfo;
  bookingUrl: string;
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
      <Card className="border-emerald-soft/30 p-5 text-center">
        <p className="text-xs uppercase tracking-[0.18em] text-emerald-soft">
          You&apos;re booked
        </p>
        <p className="mt-1 min-h-5 text-sm text-offwhite">
          {when ? `Next visit: ${when}` : "See you soon."}
        </p>
      </Card>
    );
  }

  // No history yet - gentle prompt, no countdown.
  if (rebook.state === "none" || !rebook.deadline) {
    return null;
  }

  if (!mounted) {
    // Same-size placeholder so the card doesn't jump when the clock appears.
    return (
      <Card className="border-gold/30 p-5">
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.18em] text-muted">
            Time left to rebook
          </p>
          <div className="skeleton mx-auto mt-3 h-14 w-64 max-w-full rounded-xl" />
          <p className="mt-3 text-xs text-muted">
            Rebook within {rebook.windowDays} days to keep your streak.
          </p>
        </div>
      </Card>
    );
  }

  const r = diff(rebook.deadline);
  const overdue = rebook.state === "overdue" || r.totalMs === 0;

  // Urgency tiers drive the accent color + label.
  const urgent = !overdue && r.days < 2;
  const accent = overdue
    ? "text-danger-soft"
    : urgent
      ? "text-danger-soft"
      : "text-gold";
  const ring = overdue
    ? "border-danger-soft/40"
    : urgent
      ? "border-danger-soft/40"
      : "border-gold/30";

  return (
    <Card className={`${ring} p-5`}>
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.18em] text-muted">
          {overdue ? "It's time for your next cut" : "Time left to rebook"}
        </p>

        {overdue ? (
          <p className={`mt-2 font-display text-2xl ${accent}`}>
            Don&apos;t lose your spot
          </p>
        ) : (
          <motion.div
            className="mt-3 flex items-center justify-center gap-3"
            animate={urgent && !reduce ? { scale: [1, 1.03, 1] } : undefined}
            transition={urgent && !reduce ? { duration: 1.4, repeat: Infinity } : undefined}
          >
            <TimeBlock value={r.days} label="days" accent={accent} />
            <Colon />
            <TimeBlock value={r.hours} label="hrs" accent={accent} />
            <Colon />
            <TimeBlock value={r.minutes} label="min" accent={accent} />
            <Colon />
            <TimeBlock value={r.seconds} label="sec" accent={accent} />
          </motion.div>
        )}

        <p className="mt-3 text-xs text-muted">
          {overdue
            ? `Book now to stay on track.`
            : urgent
              ? `Your window closes soon. Grab a slot.`
              : `Rebook within ${rebook.windowDays} days to keep your streak.`}
        </p>
      </div>
    </Card>
  );
}

function TimeBlock({
  value,
  label,
  accent,
}: {
  value: number;
  label: string;
  accent: string;
}) {
  return (
    <div className="flex w-14 flex-col items-center">
      <span className={`font-display text-3xl tabular-nums ${accent}`}>
        {String(value).padStart(2, "0")}
      </span>
      <span className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">
        {label}
      </span>
    </div>
  );
}

function Colon() {
  return <span className="font-display text-2xl text-muted/50">:</span>;
}
