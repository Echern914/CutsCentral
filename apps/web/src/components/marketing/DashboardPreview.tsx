"use client";

import { motion } from "framer-motion";

const EASE = [0.21, 0.47, 0.32, 0.98] as const;

const STATS = [
  { label: "Recovered this month", value: "$1,240", accent: true },
  { label: "Rebook rate", value: "38%" },
  { label: "Nudges sent", value: "86" },
  { label: "At-risk clients", value: "12" },
];

// Six months of demo trend data (0–1 of max).
const BARS = [0.35, 0.48, 0.42, 0.61, 0.74, 0.92];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];

const AT_RISK = [
  { name: "Marcus T.", last: "31 days ago", usual: "every 3 weeks" },
  { name: "Devon R.", last: "26 days ago", usual: "every 2 weeks" },
  { name: "Jalen W.", last: "38 days ago", usual: "every 4 weeks" },
];

/**
 * A faux dashboard rendered with the real design system inside browser
 * chrome — trend bars grow in on scroll. Demo data, clearly a preview.
 */
export function DashboardPreview() {
  return (
    <div className="overflow-hidden rounded-3xl border border-subtle bg-charcoal-900/80 shadow-ambient-lg">
      {/* Browser chrome */}
      <div className="flex items-center gap-3 border-b border-subtle bg-charcoal-800/80 px-4 py-3">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-charcoal-600" />
          <span className="h-2.5 w-2.5 rounded-full bg-charcoal-600" />
          <span className="h-2.5 w-2.5 rounded-full bg-charcoal-600" />
        </div>
        <div className="mx-auto flex items-center gap-2 rounded-full border border-subtle bg-charcoal px-4 py-1 text-[11px] text-muted">
          <LockIcon className="h-3 w-3 text-gold/60" />
          chairback.app/dashboard
        </div>
        <div className="w-10" />
      </div>

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STATS.map((s) => (
              <div
                key={s.label}
                className={`rounded-2xl border p-3.5 ${
                  s.accent
                    ? "border-gold/25 bg-gold/[0.07]"
                    : "border-subtle bg-charcoal-800/70"
                }`}
              >
                <p
                  className={`font-display text-xl leading-none sm:text-2xl ${
                    s.accent ? "text-gradient-gold" : "text-offwhite"
                  }`}
                >
                  {s.value}
                </p>
                <p className="mt-1.5 text-[10px] leading-tight text-muted sm:text-[11px]">
                  {s.label}
                </p>
              </div>
            ))}
          </div>

          {/* Trend chart */}
          <div className="flex-1 rounded-2xl border border-subtle bg-charcoal-800/70 p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-offwhite">
                Revenue recovered
              </p>
              <span className="rounded-full border border-subtle px-2 py-0.5 text-[10px] text-muted">
                6 months
              </span>
            </div>
            <div className="mt-4 flex h-28 items-end gap-2.5 sm:h-32">
              {BARS.map((v, i) => (
                <div key={i} className="flex h-full flex-1 flex-col justify-end gap-1.5">
                  <motion.div
                    initial={{ height: "4%" }}
                    whileInView={{ height: `${v * 100}%` }}
                    viewport={{ once: true, amount: 0.5 }}
                    transition={{ duration: 0.9, delay: i * 0.08, ease: EASE }}
                    className={`w-full rounded-md ${
                      i === BARS.length - 1
                        ? "bg-gold-gradient shadow-glow-sm"
                        : "bg-gold/25"
                    }`}
                  />
                  <p className="text-center text-[9px] text-muted">{MONTHS[i]}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* At-risk list */}
        <div className="rounded-2xl border border-subtle bg-charcoal-800/70 p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-offwhite">At-risk clients</p>
            <span className="rounded-full bg-danger-soft/10 px-2 py-0.5 text-[10px] font-medium text-danger-soft">
              due for a cut
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {AT_RISK.map((c) => (
              <div
                key={c.name}
                className="flex items-center justify-between gap-2 rounded-xl border border-subtle bg-charcoal-900/60 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-offwhite">
                    {c.name}
                  </p>
                  <p className="text-[10px] text-muted">
                    {c.last} · {c.usual}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-gold-gradient px-2.5 py-1 text-[10px] font-semibold text-charcoal">
                  Nudge
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-center text-[10px] leading-relaxed text-muted">
            ChairBack learns each client&apos;s rhythm and flags the ones
            drifting away — one tap texts them back.
          </p>
        </div>
      </div>
    </div>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
