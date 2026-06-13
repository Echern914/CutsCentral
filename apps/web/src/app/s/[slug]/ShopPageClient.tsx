"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { APP_NAME, PAGE_THEMES, type PageThemeKey } from "@chairback/config/constants";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import type { ShopPageData } from "./page";

/**
 * A barber's public mini-site. Fully theme-driven: every surface reads from the
 * shop's chosen PAGE_THEMES preset (+ optional custom accent), so two shops on
 * different themes share zero visual identity. Self-contained styling - this
 * page deliberately avoids the app's dark-chrome utility classes.
 */
export function ShopPageClient({ data }: { data: ShopPageData }) {
  const theme =
    PAGE_THEMES[(data.theme as PageThemeKey) in PAGE_THEMES ? (data.theme as PageThemeKey) : "classic"];
  const accent = data.accentColor || theme.accent;
  // Clock-relative labels render after mount only (hydration safety).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const surface: CSSProperties = {
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: "1rem",
  };

  return (
    <div
      className="min-h-dvh"
      style={{ backgroundColor: theme.bg, color: theme.text, colorScheme: theme.scheme }}
    >
      <motion.main
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-lg px-5 pb-16"
      >
        {/* Hero */}
        <motion.header variants={fadeUp} className="relative">
          {data.heroImageUrl ? (
            <div className="relative -mx-5 h-48 overflow-hidden sm:h-56">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={data.heroImageUrl}
                alt=""
                className="h-full w-full object-cover"
              />
              <div
                className="absolute inset-0"
                style={{
                  background: `linear-gradient(180deg, transparent 30%, ${theme.bg} 100%)`,
                }}
                aria-hidden
              />
            </div>
          ) : (
            <div
              className="-mx-5 h-28"
              style={{
                background: `radial-gradient(420px 200px at 50% 0%, ${accent}26, transparent 70%)`,
              }}
              aria-hidden
            />
          )}

          <div className={`text-center ${data.heroImageUrl ? "-mt-10" : "-mt-6"}`}>
            {data.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.logoUrl}
                alt={data.name}
                className="mx-auto h-20 w-20 rounded-2xl object-cover shadow-lg"
                style={{ border: `2px solid ${theme.surface}` }}
              />
            ) : (
              <div
                className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl text-3xl font-semibold shadow-lg"
                style={{ backgroundColor: theme.surface, border: `1px solid ${theme.border}`, color: accent }}
              >
                {data.name.charAt(0).toUpperCase()}
              </div>
            )}
            <h1 className="mt-4 font-display text-3xl tracking-tight">{data.name}</h1>
            {data.bio && (
              <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: theme.muted }}>
                {data.bio}
              </p>
            )}
            {data.instagramHandle && (
              <a
                href={`https://instagram.com/${data.instagramHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block text-sm font-medium hover:underline"
                style={{ color: accent }}
              >
                @{data.instagramHandle}
              </a>
            )}
          </div>
        </motion.header>

        {/* Book CTA */}
        <motion.div variants={fadeUp} className="mt-6">
          <a
            href={data.bookingUrl}
            className="block w-full rounded-full py-3.5 text-center text-sm font-semibold transition-transform hover:scale-[1.01]"
            style={{
              backgroundColor: accent,
              color: theme.scheme === "light" ? "#FFFFFF" : "#101012",
              boxShadow: `0 8px 30px -10px ${accent}AA`,
            }}
          >
            Book an appointment
          </a>
        </motion.div>

        {/* Live promotions */}
        {data.promotions.length > 0 && (
          <motion.section variants={fadeUp} className="mt-8">
            <SectionTitle muted={theme.muted}>Right now</SectionTitle>
            <div className="flex flex-col gap-3">
              {data.promotions.map((promo) => {
                const value = promoValue(promo);
                const ends = mounted ? endsLabel(promo.endsAt) : null;
                return (
                  <div key={promo.id} className="relative overflow-hidden p-5" style={surface}>
                    <div
                      className="absolute inset-y-0 left-0 w-1"
                      style={{ backgroundColor: accent }}
                      aria-hidden
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">
                          {promo.title}
                          {value && (
                            <span className="ml-2" style={{ color: accent }}>
                              {value}
                            </span>
                          )}
                        </p>
                        {promo.description && (
                          <p className="mt-1 text-xs" style={{ color: theme.muted }}>
                            {promo.description}
                          </p>
                        )}
                        <p
                          className="mt-1.5 min-h-4 text-[11px] uppercase tracking-wide"
                          style={{ color: theme.muted }}
                        >
                          {ends ?? ""}
                        </p>
                      </div>
                      {promo.code && (
                        <span
                          className="shrink-0 rounded-lg px-2.5 py-1.5 font-mono text-xs"
                          style={{ border: `1px dashed ${theme.border}` }}
                        >
                          {promo.code}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.section>
        )}

        {/* Rewards menu */}
        {data.rewards.length > 0 && (
          <motion.section variants={fadeUp} className="mt-8">
            <SectionTitle muted={theme.muted}>Loyalty rewards</SectionTitle>
            <div className="overflow-hidden" style={surface}>
              {data.rewards.map((reward, i) => (
                <div
                  key={reward.id}
                  className="flex items-center justify-between gap-3 px-5 py-4"
                  style={i > 0 ? { borderTop: `1px solid ${theme.border}` } : undefined}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {reward.emoji ? `${reward.emoji} ` : ""}
                      {reward.name}
                    </p>
                    {reward.description && (
                      <p className="mt-0.5 truncate text-xs" style={{ color: theme.muted }}>
                        {reward.description}
                      </p>
                    )}
                  </div>
                  <span
                    className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
                    style={{ backgroundColor: `${accent}22`, color: accent }}
                  >
                    {reward.punchCost} {reward.punchCost === 1 ? "punch" : "punches"}
                  </span>
                </div>
              ))}
              <p
                className="px-5 py-3 text-[11px]"
                style={{ color: theme.muted, borderTop: `1px solid ${theme.border}` }}
              >
                Every visit earns {data.punchesPerVisit}{" "}
                {data.punchesPerVisit === 1 ? "punch" : "punches"}. Members get a personal
                rewards link by text after their first visit.
              </p>
            </div>
          </motion.section>
        )}

        {/* Gallery */}
        {data.galleryUrls.length > 0 && (
          <motion.section variants={fadeUp} className="mt-8">
            <SectionTitle muted={theme.muted}>The work</SectionTitle>
            <div className="grid grid-cols-2 gap-3">
              {data.galleryUrls.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={url}
                  alt={`${data.name} work ${i + 1}`}
                  loading="lazy"
                  className="aspect-square w-full rounded-2xl object-cover"
                  style={{ border: `1px solid ${theme.border}` }}
                />
              ))}
            </div>
          </motion.section>
        )}

        {/* Hours */}
        {data.hoursText && (
          <motion.section variants={fadeUp} className="mt-8">
            <SectionTitle muted={theme.muted}>Hours</SectionTitle>
            <div className="whitespace-pre-line p-5 text-sm" style={surface}>
              {data.hoursText}
            </div>
          </motion.section>
        )}

        {/* Bottom CTA + footer */}
        <motion.footer variants={fadeUp} className="mt-10 text-center">
          <a
            href={data.bookingUrl}
            className="inline-block rounded-full px-8 py-3 text-sm font-semibold"
            style={{
              border: `1px solid ${accent}`,
              color: accent,
            }}
          >
            Book with {data.name}
          </a>
          {/* Growth loop: every shop page quietly markets the platform. */}
          <a
            href={`/?ref=${encodeURIComponent(data.slug)}`}
            className="mt-6 inline-block text-[11px] underline-offset-2 hover:underline"
            style={{ color: theme.muted }}
          >
            Powered by {APP_NAME} — loyalty for your shop
          </a>
        </motion.footer>
      </motion.main>
    </div>
  );
}

function SectionTitle({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted: string;
}) {
  return (
    <h2
      className="mb-3 px-1 text-xs font-medium uppercase tracking-[0.18em]"
      style={{ color: muted }}
    >
      {children}
    </h2>
  );
}

function promoValue(p: ShopPageData["promotions"][number]): string | null {
  switch (p.kind) {
    case "PERCENT_OFF":
      return p.percentOff ? `${p.percentOff}% off` : null;
    case "AMOUNT_OFF":
      return p.amountOff ? `$${p.amountOff} off` : null;
    case "FREE_ADDON":
      return null;
    case "EXTRA_PUNCHES":
      return p.extraPunches
        ? `+${p.extraPunches} ${p.extraPunches === 1 ? "punch" : "punches"} per visit`
        : null;
  }
}

function endsLabel(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const days = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return "last day";
  if (days <= 14) return `ends in ${days} days`;
  return `ends ${new Date(endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
