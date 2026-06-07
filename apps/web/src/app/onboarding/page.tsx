"use client";

import { useFormState, useFormStatus } from "react-dom";
import { motion } from "framer-motion";
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
      className="w-full rounded-full bg-gold px-5 py-3 text-sm font-semibold text-charcoal shadow-glow hover:bg-gold-muted disabled:opacity-50"
    >
      {pending ? "Creating…" : "Continue"}
    </button>
  );
}

export default function OnboardingShopPage() {
  const [state, action] = useFormState(createShopAction, {});

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
            <input name="name" placeholder="Shop name" required className={field} />
            <input
              name="bookingUrl"
              type="url"
              placeholder="Acuity booking link (https://you.as.me)"
              required
              className={field}
            />
            <select name="timezone" defaultValue="America/New_York" className={field}>
              <option value="America/New_York">Eastern (New York)</option>
              <option value="America/Chicago">Central (Chicago)</option>
              <option value="America/Denver">Mountain (Denver)</option>
              <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
            </select>
            <div className="grid grid-cols-2 gap-3">
              <input
                name="rewardThreshold"
                type="number"
                min={1}
                defaultValue={10}
                placeholder="Cuts for reward"
                className={field}
              />
              <input
                name="rewardLabel"
                defaultValue="Free Cut"
                placeholder="Reward label"
                className={field}
              />
            </div>
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
