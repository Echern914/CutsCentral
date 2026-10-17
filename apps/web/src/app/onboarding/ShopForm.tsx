"use client";

import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { motion } from "framer-motion";
import {
  BUSINESS_TYPES,
  SELECTABLE_BUSINESS_TYPE_IDS,
  type BusinessTypeId,
} from "@chairback/config/businessTypes";
import { createShopAction } from "./actions";
import { saveThemeAction } from "../dashboard/actions";
import { ThemePicker } from "@/components/ThemePicker";
import { fadeUp } from "@/components/motion/variants";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { TrackConversion } from "@/components/TrackConversion";

// Keep the global :focus-visible ring (WCAG 2.4.7): no `outline-none`, and the
// border tint is a supplement to that ring, not the sole focus indicator.
const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";

/** Quiet-hours (TCPA) enforcement keys off the shop's zone - every US zone is listed. */
const US_ZONES: [string, string][] = [
  ["America/New_York", "Eastern (New York)"],
  ["America/Chicago", "Central (Chicago)"],
  ["America/Denver", "Mountain (Denver)"],
  ["America/Phoenix", "Arizona (Phoenix, no DST)"],
  ["America/Los_Angeles", "Pacific (Los Angeles)"],
  ["America/Anchorage", "Alaska (Anchorage)"],
  ["Pacific/Honolulu", "Hawaii (Honolulu)"],
  ["America/Puerto_Rico", "Atlantic (Puerto Rico)"],
];

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-on-gold shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
    >
      {pending ? "Creating…" : "Continue"}
    </button>
  );
}

/**
 * Setup, step 1: the shop. Only what can't be known already - its name and
 * what kind of business it is (pre-picked when they came from that business
 * type's page). The time zone is read from their device; the texting
 * agreement is asked only of someone who hasn't given it at signup (Google
 * and Apple sign-in skip that form). How clients book, the team, services and
 * hours each get a step of their own after this; rewards are set up when
 * they switch Rewards on.
 */
export function ShopForm({
  smsAttested,
  initialType,
}: {
  /** Agreed to the texting terms at signup: not asked again. */
  smsAttested: boolean;
  /** From the business type page they came in on, when there was one. */
  initialType: BusinessTypeId | "";
}) {
  const [state, action] = useFormState(createShopAction, {});
  // No default vertical unless they arrived from one: a non-barber shop must
  // never silently inherit "barber" (its seeded reward + SMS wording).
  const [industry, setIndustry] = useState<BusinessTypeId | "">(initialType);
  const [timezone, setTimezone] = useState("America/New_York");
  const [detected, setDetected] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone) {
        setDetected(zone);
        setTimezone(zone);
      }
    } catch {
      // Keep the default; the picker is right there.
    }
  }, []);

  const zones = detected && !US_ZONES.some(([z]) => z === detected) ? [[detected, detected.replace(/_/g, " ")] as [string, string], ...US_ZONES] : US_ZONES;
  const codeOpen = showCode || state.field === "partnerCode";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      {/* Signup conversion. /onboarding is the first page after a successful
          signup redirect; fires once per session so a refresh doesn't re-count. */}
      <TrackConversion event="signup" dedupeKey="signup" />
      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <p className="text-center text-xs uppercase tracking-[0.2em] text-muted">Let&apos;s set up your shop</p>
        <h1 className="mb-6 mt-2 text-center font-display text-3xl tracking-tight">Your shop</h1>
        <Card className="p-6">
          <form action={action} className="flex flex-col gap-3">
            <input
              name="name"
              placeholder="Shop or studio name"
              aria-label="Shop or studio name"
              required
              maxLength={120}
              className={field}
            />
            <select
              name="industry"
              aria-label="What kind of business are you setting up?"
              value={industry}
              onChange={(e) => setIndustry(e.target.value as BusinessTypeId)}
              required
              className={field}
            >
              <option value="" disabled>
                What kind of business are you setting up?
              </option>
              {SELECTABLE_BUSINESS_TYPE_IDS.map((k) => (
                <option key={k} value={k}>
                  {BUSINESS_TYPES[k].emoji} {BUSINESS_TYPES[k].label}
                </option>
              ))}
            </select>
            {/* The tagline disambiguates neighbours ("Hair Salon" vs
                "Multi-Service Salon") without making the picker a wall of text. */}
            {industry ? <p className="-mt-1 text-xs text-muted">{BUSINESS_TYPES[industry].tagline}</p> : null}
            <label className="flex flex-col gap-1 text-xs text-muted">
              Time zone{detected ? " (from your device)" : ""}
              <select
                name="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className={field}
                data-testid="timezone"
              >
                {zones.map(([z, label]) => (
                  <option key={z} value={z}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {/* Optional partner code ("ERIC C"). Case and spaces don't matter; a
                code that can't be used is explained right here and nothing is
                created until it is fixed or cleared. */}
            {codeOpen ? (
              <>
                <input
                  name="partnerCode"
                  placeholder="Referral code"
                  aria-label="Referral code (optional)"
                  autoCapitalize="characters"
                  autoComplete="off"
                  maxLength={64}
                  aria-invalid={state.field === "partnerCode" || undefined}
                  aria-describedby={state.field === "partnerCode" ? "partner-code-error" : undefined}
                  className={field}
                />
                {state.field === "partnerCode" ? (
                  <FormError id="partner-code-error" className="-mt-1">
                    {state.error}
                  </FormError>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                onClick={() => setShowCode(true)}
                className="self-start text-xs text-muted underline-offset-4 hover:text-offwhite hover:underline"
              >
                Have a referral code?
              </button>
            )}
            {!smsAttested && (
              <label className="mt-1 flex items-start gap-2.5 text-xs leading-relaxed text-muted">
                <input
                  type="checkbox"
                  name="smsAttested"
                  required
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-subtle bg-charcoal-700 accent-gold"
                />
                <span>
                  I&apos;ll only add and text clients who agreed to receive messages from my shop, and I&apos;m
                  authorized to send on their behalf.
                </span>
              </label>
            )}
            <FormError className="text-sm">{state.field === "partnerCode" ? undefined : state.error}</FormError>
            <div className="mt-1">
              <Submit />
            </div>
          </form>
        </Card>
        {/* Eric: "at the beginning when creating the account should have a
            choose a Dark Mode and Light Mode." Taps apply instantly and persist
            to the account. Below the form rather than a gating step: picking a
            look must never stand between a barber and their first shop. */}
        <div className="mt-5">
          <p className="mb-2 text-center text-xs uppercase tracking-[0.2em] text-muted">Pick your look</p>
          <ThemePicker value="light" onPick={(t) => void saveThemeAction(t)} />
          <p className="mt-2 text-center text-xs text-muted">You can switch anytime in Account.</p>
        </div>
      </motion.div>
    </main>
  );
}
