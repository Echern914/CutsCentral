"use client";

import { motion } from "framer-motion";

const EASE = [0.21, 0.47, 0.32, 0.98] as const;

const bubble = {
  hidden: { opacity: 0, y: 14, scale: 0.96 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.35, ease: EASE } },
};

/**
 * iPhone-style frame playing the nudge conversation: ChairBack texts the
 * drifting client, the client books. Bubbles stagger in on scroll.
 */
export function PhoneDemo({ className }: { className?: string }) {
  return (
    <div
      className={`relative w-64 overflow-hidden rounded-[2.6rem] border border-subtle-strong bg-charcoal-900 shadow-ambient-lg ${className ?? ""}`}
    >
      {/* Dynamic island */}
      <div className="absolute left-1/2 top-3 z-10 h-5 w-24 -translate-x-1/2 rounded-full bg-charcoal" />

      <div className="px-4 pb-5 pt-12">
        <p className="text-center text-[10px] text-muted">
          Drick&apos;s Barbershop · Today 10:02 AM
        </p>

        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.5 }}
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.55 } } }}
          className="mt-3 flex flex-col gap-2.5"
        >
          <motion.div
            variants={bubble}
            className="max-w-[88%] self-start rounded-2xl rounded-bl-md border border-subtle bg-charcoal-700 px-3.5 py-2.5 text-[12px] leading-snug text-offwhite"
          >
            Hey Marcus, it&apos;s been 4 weeks since your last cut at
            Drick&apos;s. Your usual Thursday slot is open this week. Book here:{" "}
            <span className="text-gold-soft underline decoration-gold/40">
              drx.cut/book
            </span>
          </motion.div>

          <motion.div
            variants={bubble}
            className="max-w-[70%] self-end rounded-2xl rounded-br-md bg-gold-gradient px-3.5 py-2.5 text-[12px] font-medium leading-snug text-charcoal"
          >
            just booked thursday 🙏
          </motion.div>

          <motion.div variants={bubble} className="self-center pt-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-soft/30 bg-emerald-soft/10 px-3 py-1 text-[10px] font-medium text-emerald-soft">
              <CheckIcon className="h-3 w-3" />
              Rebooked: $35 recovered
            </span>
          </motion.div>
        </motion.div>
      </div>

      {/* Home indicator */}
      <div className="mx-auto mb-2 h-1 w-24 rounded-full bg-charcoal-600" />
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}
