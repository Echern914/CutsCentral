"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import {
  APP_NAME,
  DEFAULT_LAYOUT_STYLE,
  DEFAULT_PAGE_FONT,
  DEFAULT_SECTION_ORDER,
  LAYOUT_STYLES,
  PAGE_FONTS,
  PAGE_THEMES,
  type LayoutStyleKey,
  type PageFontKey,
  type PageSectionKey,
  type PageThemeKey,
} from "@chairback/config/constants";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { BackToDashboard } from "@/components/BackToDashboard";
import { RequestForm } from "./RequestForm";
import { ShopWaitlistForm } from "./ShopWaitlistForm";
import { ReviewForm } from "./ReviewForm";
import type { ShopPageData } from "./page";

/**
 * A barber's public mini-site. Fully identity-driven: every surface reads from
 * the shop's chosen theme + accent + font pairing + layout shape, and the movable
 * sections render in the shop's chosen order. Two shops share zero visual
 * identity. Self-contained styling - deliberately avoids the app's dark-chrome
 * utility classes.
 *
 * `preview` renders the exact same page for the in-editor live preview, but
 * neutralizes anything that would navigate or submit (booking link, request
 * form, Instagram, the powered-by link) so editing stays on the page.
 */
export function ShopPageClient({
  data,
  preview = false,
}: {
  data: ShopPageData;
  preview?: boolean;
}) {
  const theme =
    PAGE_THEMES[(data.theme as PageThemeKey) in PAGE_THEMES ? (data.theme as PageThemeKey) : "classic"];
  const accent = data.accentColor || theme.accent;

  // Native booking: the CTA points at the in-app slot picker instead of the
  // external bookingUrl, and the lead-request form is replaced by real booking.
  const bookIsNative = data.bookingMode === "native";
  const bookHref = bookIsNative ? `/book/${data.slug}` : data.bookingUrl;
  // A shop may have NO booking destination (no native, no external link). Then
  // we hide the "Book" CTAs and lean on the request form instead.
  const hasBooking = bookIsNative || Boolean(data.bookingUrl);
  // Show the request form when the barber enabled it OR when there's no booking
  // path at all - so a no-link shop with requests off still gives clients a way
  // to reach out, instead of a dead page with no CTA. (Native booking replaces
  // the form entirely - it IS self-serve booking.)
  const showRequestForm = !bookIsNative && (data.takesRequests || !hasBooking);

  const fontKey: PageFontKey =
    (data.fontKey as PageFontKey) in PAGE_FONTS ? (data.fontKey as PageFontKey) : DEFAULT_PAGE_FONT;
  const font = PAGE_FONTS[fontKey];
  const layoutKey: LayoutStyleKey =
    (data.layoutStyle as LayoutStyleKey) in LAYOUT_STYLES
      ? (data.layoutStyle as LayoutStyleKey)
      : DEFAULT_LAYOUT_STYLE;
  const layout = LAYOUT_STYLES[layoutKey];

  // Section order: stored list (validated keys) or the default. De-dupe defensively.
  const order = (data.sectionOrder?.length ? data.sectionOrder : DEFAULT_SECTION_ORDER).filter(
    (s, i, a): s is PageSectionKey => a.indexOf(s) === i,
  ) as PageSectionKey[];

  // Clock-relative labels render after mount only (hydration safety).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const surface: CSSProperties = {
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: layout.radius,
  };

  // Root style: theme colors + the chosen font families exposed as locals the
  // page reads via `fontFamily: "var(--page-display)"` etc.
  const rootStyle: CSSProperties = {
    backgroundColor: theme.bg,
    color: theme.text,
    colorScheme: theme.scheme,
    // @ts-expect-error - CSS custom properties are valid in style objects.
    "--page-display": `var(${font.displayVar}), Georgia, serif`,
    "--page-body": `var(${font.bodyVar}), system-ui, sans-serif`,
  };

  const sections: Record<PageSectionKey, React.ReactNode> = {
    promotions: <Promotions key="promotions" data={data} accent={accent} theme={theme} layout={layout} mounted={mounted} />,
    rewards: <Rewards key="rewards" data={data} accent={accent} theme={theme} surface={surface} />,
    reviews: <Reviews key="reviews" data={data} accent={accent} theme={theme} layout={layout} surface={surface} preview={preview} />,
    gallery: <Gallery key="gallery" data={data} theme={theme} layout={layout} />,
    hours: <Hours key="hours" data={data} theme={theme} surface={surface} />,
  };

  return (
    <div className="min-h-dvh" style={rootStyle}>
      {/* Barber-only "back to dashboard" - shows only when opened from the
          dashboard (?from=dashboard), never for customers, never in the editor
          preview. */}
      {!preview && (
        <BackToDashboard
          fallbackHref="/dashboard/site"
          className="fixed left-4 top-4 z-20 px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur transition-transform duration-200 ease-out hover:scale-[1.03]"
          style={{
            backgroundColor: theme.surface,
            border: `1px solid ${theme.border}`,
            color: theme.text,
            borderRadius: layout.buttonRadius,
          }}
        />
      )}
      <motion.main
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-lg px-5 pb-16"
        style={{ fontFamily: "var(--page-body)" }}
      >
        {/* Hero: a full-bleed banner that fades into the page, then the shop name.
            No logo coin - the banner + name carry the identity. */}
        <motion.header variants={fadeUp} className="relative">
          {data.heroImageUrl ? (
            <div className="relative -mx-5 h-48 overflow-hidden sm:h-56">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.heroImageUrl} alt="" className="h-full w-full object-cover" />
              {/* Fade the bottom of the banner into the page background so it
                  blends in and the name sits on a clean surface. */}
              <div
                className="absolute inset-0"
                style={{ background: `linear-gradient(180deg, transparent 45%, ${theme.bg} 100%)` }}
                aria-hidden
              />
            </div>
          ) : (
            <div
              className="-mx-5 h-28"
              style={{ background: `radial-gradient(420px 200px at 50% 0%, ${accent}26, transparent 70%)` }}
              aria-hidden
            />
          )}

          <div className="mt-4 text-center">
            <h1 className="text-3xl tracking-tight" style={{ fontFamily: "var(--page-display)" }}>
              {data.name}
            </h1>
            {data.bio && (
              <p className="mx-auto mt-2 max-w-sm text-sm" style={{ color: theme.muted }}>
                {data.bio}
              </p>
            )}
            {data.instagramHandle && (
              <a
                href={preview ? undefined : `https://instagram.com/${data.instagramHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={preview ? (e) => e.preventDefault() : undefined}
                className="mt-3 inline-block text-sm font-medium hover:underline"
                style={{ color: accent }}
              >
                @{data.instagramHandle}
              </a>
            )}
          </div>
        </motion.header>

        {/* Primary CTA. Native booking and the lead form are mutually exclusive:
            native is real self-serve booking, so it replaces the request form. */}
        <motion.div variants={fadeUp} className="mt-6">
          {showRequestForm ? (
            <>
              <RequestForm
                slug={data.slug}
                shopName={data.name}
                accent={accent}
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
              {/* The "or book online" shortcut only makes sense with a real link. */}
              {hasBooking && (
                <a
                  href={preview ? undefined : bookHref ?? undefined}
                  onClick={preview ? (e) => e.preventDefault() : undefined}
                  className="mt-3 block text-center text-xs underline-offset-2 hover:underline"
                  style={{ color: theme.muted }}
                >
                  Or book online instantly →
                </a>
              )}
            </>
          ) : hasBooking ? (
            <a
              href={preview ? undefined : bookHref ?? undefined}
              onClick={preview ? (e) => e.preventDefault() : undefined}
              className="block w-full py-3.5 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01]"
              style={{
                backgroundColor: accent,
                color: theme.scheme === "light" ? "#FFFFFF" : "#101012",
                boxShadow: `0 8px 30px -10px ${accent}AA`,
                borderRadius: layout.buttonRadius,
              }}
            >
              Book an appointment
            </a>
          ) : null}
        </motion.div>

        {/* Standing waitlist entry: for when they're fully booked. Not shown with
            the request form (that's already a "reach out" path). */}
        {data.waitlistEnabled && !showRequestForm && (
          <motion.div variants={fadeUp} className="mt-3">
            <ShopWaitlistForm
              slug={data.slug}
              shopName={data.name}
              accent={accent}
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
          </motion.div>
        )}

        {/* Movable sections, in the shop's chosen order */}
        {order.map((key) => sections[key])}

        {/* Bottom CTA + footer */}
        <motion.footer variants={fadeUp} className="mt-10 text-center">
          {hasBooking && (
            <a
              href={preview ? undefined : bookHref ?? undefined}
              onClick={preview ? (e) => e.preventDefault() : undefined}
              className="inline-block px-8 py-3 text-sm font-semibold"
              style={{ border: `1px solid ${accent}`, color: accent, borderRadius: layout.buttonRadius }}
            >
              Book with {data.name}
            </a>
          )}
          {/* Growth loop: every shop page quietly markets the platform. */}
          <a
            href={preview ? undefined : `/?ref=${encodeURIComponent(data.slug)}`}
            onClick={preview ? (e) => e.preventDefault() : undefined}
            className="mt-6 inline-block text-[11px] underline-offset-2 hover:underline"
            style={{ color: theme.muted }}
          >
            Powered by {APP_NAME}, loyalty for your shop
          </a>
        </motion.footer>
      </motion.main>
    </div>
  );
}

type Theme = (typeof PAGE_THEMES)[PageThemeKey];
type Layout = (typeof LAYOUT_STYLES)[LayoutStyleKey];

function Promotions({
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
    <motion.section variants={fadeUp} className="mt-8">
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

function Rewards({
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
const EXAMPLE_REVIEWS = [
  { id: "ex1", rating: 5, authorName: "Jordan M.", body: "Best fade I've gotten in years. In and out, super clean." },
  { id: "ex2", rating: 5, authorName: "Sam R.", body: "Great with my kids and always on time. Highly recommend." },
  { id: "ex3", rating: 4, authorName: "Alex P.", body: "Solid cut and good conversation. Will be back." },
];

function Reviews({
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
  const real = data.reviews;
  const hasReal = real.length > 0;
  // In the editor preview with no real reviews yet, show labeled examples so the
  // barber sees the layout. Live page with no reviews: just the form, no examples.
  const showExamples = preview && !hasReal;
  const list = hasReal ? real : showExamples ? EXAMPLE_REVIEWS : [];
  const avg = data.reviewSummary.avgRating;

  return (
    <motion.section variants={fadeUp} className="mt-8">
      <SectionTitle muted={theme.muted}>Reviews</SectionTitle>

      {/* Average rating header (real data only). */}
      {hasReal && avg != null && (
        <div className="mb-3 flex items-center gap-2 px-1">
          <Stars value={Math.round(avg)} accent={accent} border={theme.border} />
          <span className="text-sm font-semibold">{avg.toFixed(1)}</span>
          <span className="text-xs" style={{ color: theme.muted }}>
            ({data.reviewSummary.count} {data.reviewSummary.count === 1 ? "review" : "reviews"})
          </span>
        </div>
      )}

      {showExamples && (
        <p className="mb-3 px-1 text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
          Example — your approved reviews will appear here
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
function Stars({ value, accent, border }: { value: number; accent: string; border: string }) {
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

function Gallery({ data, theme, layout }: { data: ShopPageData; theme: Theme; layout: Layout }) {
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

function Hours({
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

function SectionTitle({ children, muted }: { children: React.ReactNode; muted: string }) {
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

function endsLabel(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const days = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return null;
  if (days === 1) return "last day";
  if (days <= 14) return `ends in ${days} days`;
  return `ends ${new Date(endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
