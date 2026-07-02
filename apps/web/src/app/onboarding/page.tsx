"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { motion } from "framer-motion";
import {
  INDUSTRIES,
  INDUSTRY_KEYS,
  type IndustryKey,
} from "@chairback/config/constants";
import { createShopAction } from "./actions";
import { fadeUp } from "@/components/motion/variants";
import { Card } from "@/components/ui/Card";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
    >
      {pending ? "Creating…" : "Continue"}
    </button>
  );
}

export default function OnboardingShopPage() {
  const [state, action] = useFormState(createShopAction, {});
  // No default vertical: force an explicit pick so a non-barber shop never
  // silently inherits "barber" (which would wrong-foot its seeded reward + SMS).
  const [industry, setIndustry] = useState<IndustryKey | "">("");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <p className="text-center text-xs uppercase tracking-[0.2em] text-muted">
          Step 1 of 3
        </p>
        <h1 className="mb-6 mt-2 text-center font-display text-3xl tracking-tight">
          Set up your shop
        </h1>
        <Card className="p-6">
          <form action={action} className="flex flex-col gap-3">
            <input name="name" placeholder="Shop or studio name" required className={field} />
            <select
              name="industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value as IndustryKey)}
              required
              className={field}
            >
              <option value="" disabled>
                What kind of business?
              </option>
              {INDUSTRY_KEYS.map((k) => (
                <option key={k} value={k}>
                  {INDUSTRIES[k].label}
                </option>
              ))}
            </select>
            <input
              name="bookingUrl"
              type="url"
              placeholder="Booking link (optional — Acuity, Booksy, Square…)"
              className={field}
            />
            <p className="-mt-1 text-xs text-muted">
              No booking link? Leave this blank — you can run booking right here
              on ChairBack (set it up in the Booking tab after signup).
            </p>
            <select name="timezone" defaultValue="America/New_York" className={field}>
              {/* Quiet-hours (TCPA) enforcement keys off this - cover every US
                  zone so no shop has to pick a wrong one. */}
              <option value="America/New_York">Eastern (New York)</option>
              <option value="America/Chicago">Central (Chicago)</option>
              <option value="America/Denver">Mountain (Denver)</option>
              <option value="America/Phoenix">Arizona (Phoenix, no DST)</option>
              <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
              <option value="America/Anchorage">Alaska (Anchorage)</option>
              <option value="Pacific/Honolulu">Hawaii (Honolulu)</option>
              <option value="America/Puerto_Rico">Atlantic (Puerto Rico)</option>
            </select>
            <div>
              <p className="mb-2 text-xs text-muted">
                Your first reward (you can build a full menu later in the Rewards tab)
              </p>
              <div className="grid grid-cols-2 gap-3">
                <input
                  name="rewardThreshold"
                  type="number"
                  min={1}
                  defaultValue={10}
                  placeholder="Punches needed"
                  className={field}
                />
                <input
                  name="rewardLabel"
                  key={industry}
                  defaultValue={industry ? INDUSTRIES[industry].defaultReward : ""}
                  placeholder="Reward name"
                  className={field}
                />
              </div>
            </div>
            <label className="mt-1 flex items-start gap-2.5 text-xs leading-relaxed text-muted">
              <input
                type="checkbox"
                name="smsAttested"
                required
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-subtle bg-charcoal-700 accent-gold"
              />
              <span>
                I&apos;ll only add and text clients who agreed to receive
                messages from my shop, and I&apos;m authorized to send on their
                behalf.
              </span>
            </label>
            {state.error && (
              <p className="text-sm text-danger-soft">{state.error}</p>
            )}
            <div className="mt-1">
              <Submit />
            </div>
          </form>
        </Card>
      </motion.div>
    </main>
  );
}
