"use client";

import type { CSSProperties } from "react";
import { motion } from "framer-motion";
import {
  serviceNounForShop,
  LAYOUT_STYLES,
  PAGE_THEMES,
  type LayoutStyleKey,
  type PageThemeKey,
} from "@chairback/config/constants";
import { fadeUp } from "@/components/motion/variants";
import { ReviewForm } from "./ReviewForm";
import type { ShopPageData } from "./page";

/**
 * The movable sections of the public page, shared by every page design. The
 * classic page renders them in the shop's chosen order; the other designs
 * render them below their own top (designs/). Moved here unchanged from
 * ShopPageClient so both can use them without importing each other.
 */

export type Theme = (typeof PAGE_THEMES)[PageThemeKey];
export type Layout = (typeof LAYOUT_STYLES)[LayoutStyleKey];

export function Promotions({
  data,
  accent,
  theme,
  layout,
  mounted,
}: {
  data: ShopPageData;
  accent: string;
  theme: Theme;
  layout: Layout;
  mounted: boolean;
}) {
  if (data.promotions.length === 0) return null;
  return (
    <motion.section variants={fadeUp} className="mt-8" data-tour="promotions">
      <SectionTitle muted={theme.muted}>Right now</SectionTitle>
      <div className="flex flex-col gap-3">
        {data.promotions.map((promo) => {
          const value = promoValue(promo);
          const ends = mounted ? endsLabel(promo.endsAt) : null;
          return (
            <div
              key={promo.id}
              className="relative overflow-hidden p-5"
              style={{ backgroundColor: theme.surface, border: `1px solid ${theme.border}`, borderRadius: layout.radius }}
            >
              <div className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: accent }} aria-hidden />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {promo.title}
                    {value && <span className="ml-2" style={{ color: accent }}>{value}</span>}
                  </p>
                  {promo.description && (
                    <p className="mt-1 text-xs" style={{ color: theme.muted }}>{promo.description}</p>
                  )}
                  <p className="mt-1.5 min-h-4 text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
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
  );
}

export function Rewards({
  data,
  accent,
  theme,
  surface,
}: {
  data: ShopPageData;
  accent: string;
  theme: Theme;
  surface: CSSProperties;
}) {
  if (data.rewards.length === 0) return null;
  return (
    <motion.section variants={fadeUp} className="mt-8" data-tour="rewards-menu">
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
                <p className="mt-0.5 truncate text-xs" style={{ color: theme.muted }}>{reward.description}</p>
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
          Every visit earns {data.punchesPerVisit} {data.punchesPerVisit === 1 ? "punch" : "punches"}. Members get a
          personal rewards link by text after their first visit.
        </p>
      </div>
    </motion.section>
  );
}

/** Static, clearly-labeled sample reviews. Shown ONLY in the editor preview when
 *  a shop has no approved reviews yet, so the barber can see how the section will
 *  look. These are NEVER rendered on the live public page (guarded by `preview`),
 *  so real visitors never see fabricated reviews presented as real. */
const exampleReviews = (serviceNoun: string) => [
  { id: "ex1", rating: 5, authorName: "Jordan M.", body: `Best ${serviceNoun} I've had in years. In and out, super clean.` },
  { id: "ex2", rating: 5, authorName: "Sam R.", body: "Great with my kids and always on time. Highly recommend." },
  { id: "ex3", rating: 4, authorName: "Alex P.", body: `Solid ${serviceNoun} and good conversation. Will be back.` },
];

export function Reviews({
  data,
  accent,
  theme,
  layout,
  surface,
  preview,
}: {
  data: ShopPageData;
  accent: string;
  theme: Theme;
  layout: Layout;
  surface: CSSProperties;
  preview: boolean;
}) {
  // 🔴 A CARD NEEDS WORDS (Drick: "only show the ones with words"). The API
  // already sends only reviews with text; this says the same thing for a
  // payload from an API deploy that predates it, since the two ship
  // separately - otherwise a star-only rating is a card with nothing to read.
  const real = data.reviews.filter((r) => r.body?.trim());
  const hasReal = real.length > 0;
  // In the editor preview with no real reviews yet, show labeled examples so the
  // barber sees the layout. Live page with no reviews: just the form, no examples.
  const showExamples = preview && !hasReal;
  const list = hasReal ? real : showExamples ? exampleReviews(serviceNounForShop(data)) : [];
  const avg = data.reviewSummary.avgRating;
  // ...but the stars count EVERY approved rating, words or not. So the header
  // stands on its own - a shop whose ratings are all star-only still shows its
  // average - and it says "ratings", which is why "4.9 · 37 ratings" over
  // fewer than 37 cards is not a contradiction.
  const ratingCount = data.reviewSummary.count;

  return (
    <motion.section variants={fadeUp} className="mt-8" data-tour="reviews">
      <SectionTitle muted={theme.muted}>Reviews</SectionTitle>

      {/* Average rating header (real data only). */}
      {ratingCount > 0 && avg != null && (
        <div className="mb-3 flex items-center gap-2 px-1">
          <Stars value={Math.round(avg)} accent={accent} border={theme.border} />
          <span className="text-sm font-semibold">{avg.toFixed(1)}</span>
          <span className="text-xs" style={{ color: theme.muted }}>
            · {ratingCount} {ratingCount === 1 ? "rating" : "ratings"}
          </span>
        </div>
      )}

      {showExamples && (
        <p className="mb-3 px-1 text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
          Example — your approved written reviews will appear here
        </p>
      )}

      {list.length > 0 && (
        <div className="flex flex-col gap-3">
          {list.map((r) => (
            <div
              key={r.id}
              className="p-4"
              style={{ ...surface, ...(showExamples ? { opacity: 0.65 } : null) }}
            >
              <div className="flex items-center justify-between gap-2">
                <Stars value={r.rating} accent={accent} border={theme.border} />
                {r.authorName && (
                  <span className="text-xs font-medium" style={{ color: theme.muted }}>
                    {r.authorName}
                  </span>
                )}
              </div>
              {r.body && <p className="mt-2 text-sm">{r.body}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Anyone can leave a review; it lands pending until the barber approves. */}
      <div className="mt-3">
        <ReviewForm
          slug={data.slug}
          shopName={data.name}
          accent={accent}
          googleReviewUrl={data.googleReviewUrl}
          preview={preview}
          theme={{
            surface: theme.surface,
            border: theme.border,
            muted: theme.muted,
            scheme: theme.scheme,
            radius: layout.radius,
            buttonRadius: layout.buttonRadius,
          }}
        />
      </div>
    </motion.section>
  );
}

/** Five stars, filled up to `value`. Presentational only. */
export function Stars({ value, accent, border }: { value: number; accent: string; border: string }) {
  return (
    <span className="text-sm leading-none" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} style={{ color: n <= value ? accent : border }}>
          ★
        </span>
      ))}
    </span>
  );
}

export function Gallery({ data, theme, layout }: { data: ShopPageData; theme: Theme; layout: Layout }) {
  if (data.gallery.length === 0) return null;
  return (
    <motion.section variants={fadeUp} className="mt-8">
      <SectionTitle muted={theme.muted}>The work</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        {data.gallery.map((item, i) => (
          <figure key={i} className="group relative overflow-hidden" style={{ borderRadius: layout.radius }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.url}
              alt={item.caption || `${data.name} work ${i + 1}`}
              loading="lazy"
              className="aspect-square w-full object-cover transition-transform duration-200 ease-out group-hover:scale-105"
              style={{ border: `1px solid ${theme.border}`, borderRadius: layout.radius }}
            />
            {item.caption && (
              <figcaption
                className="absolute inset-x-0 bottom-0 px-3 py-2 text-[11px] font-medium text-white opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100"
                style={{ background: "linear-gradient(0deg, rgba(0,0,0,0.7), transparent)" }}
              >
                {item.caption}
              </figcaption>
            )}
          </figure>
        ))}
      </div>
    </motion.section>
  );
}

export function Hours({
  data,
  theme,
  surface,
}: {
  data: ShopPageData;
  theme: Theme;
  surface: CSSProperties;
}) {
  if (!data.hoursText) return null;
  return (
    <motion.section variants={fadeUp} className="mt-8">
      <SectionTitle muted={theme.muted}>Hours</SectionTitle>
      <div className="whitespace-pre-line p-5 text-sm" style={surface}>
        {data.hoursText}
      </div>
    </motion.section>
  );
}

export function SectionTitle({ children, muted }: { children: React.ReactNode; muted: string }) {
  return (
    <h2
      className="mb-3 px-1 text-xs font-medium uppercase tracking-[0.18em]"
      style={{ color: muted, fontFamily: "var(--page-body)" }}
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
      return p.extraPunches ? `+${p.extraPunches} ${p.extraPunches === 1 ? "punch" : "punches"} per visit` : null;
  }
}

/** Punch-card mark for the client's rewards entry. */
export function StampMark() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <circle cx="8" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="16" cy="12" r="1.4" />
    </svg>
  );
}

function endsLabel(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const days = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return "last day";
  if (days <= 14) return `ends in ${days} days`;
  return `ends ${new Date(endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
