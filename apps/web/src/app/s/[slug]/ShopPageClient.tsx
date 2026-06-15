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
import { RequestForm } from "./RequestForm";
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
    gallery: <Gallery key="gallery" data={data} theme={theme} layout={layout} />,
    hours: <Hours key="hours" data={data} theme={theme} surface={surface} />,
  };

  return (
    <div className="min-h-dvh" style={rootStyle}>
      <motion.main
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-lg px-5 pb-16"
        style={{ fontFamily: "var(--page-body)" }}
      >
        {/* Hero */}
        <motion.header variants={fadeUp} className="relative">
          {data.heroImageUrl ? (
            <div className="relative -mx-5 h-48 overflow-hidden sm:h-56">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={data.heroImageUrl} alt="" className="h-full w-full object-cover" />
              <div
                className="absolute inset-0"
                style={{ background: `linear-gradient(180deg, transparent 30%, ${theme.bg} 100%)` }}
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

          <div className={`text-center ${data.heroImageUrl ? "-mt-10" : "-mt-6"}`}>
            {data.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.logoUrl}
                alt={data.name}
                className="mx-auto h-20 w-20 object-cover shadow-lg"
                style={{ border: `2px solid ${theme.surface}`, borderRadius: layout.radius }}
              />
            ) : (
              <div
                className="mx-auto flex h-20 w-20 items-center justify-center text-3xl font-semibold shadow-lg"
                style={{
                  backgroundColor: theme.surface,
                  border: `1px solid ${theme.border}`,
                  color: accent,
                  borderRadius: layout.radius,
                  fontFamily: "var(--page-display)",
                }}
              >
                {data.name.charAt(0).toUpperCase()}
              </div>
            )}
            <h1 className="mt-4 text-3xl tracking-tight" style={{ fontFamily: "var(--page-display)" }}>
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

        {/* Primary CTA */}
        <motion.div variants={fadeUp} className="mt-6">
          {data.takesRequests ? (
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
              <a
                href={preview ? undefined : data.bookingUrl}
                onClick={preview ? (e) => e.preventDefault() : undefined}
                className="mt-3 block text-center text-xs underline-offset-2 hover:underline"
                style={{ color: theme.muted }}
              >
                Or book online instantly →
              </a>
            </>
          ) : (
            <a
              href={preview ? undefined : data.bookingUrl}
              onClick={preview ? (e) => e.preventDefault() : undefined}
              className="block w-full py-3.5 text-center text-sm font-semibold transition-transform hover:scale-[1.01]"
              style={{
                backgroundColor: accent,
                color: theme.scheme === "light" ? "#FFFFFF" : "#101012",
                boxShadow: `0 8px 30px -10px ${accent}AA`,
                borderRadius: layout.buttonRadius,
              }}
            >
              Book an appointment
            </a>
          )}
        </motion.div>

        {/* Movable sections, in the shop's chosen order */}
        {order.map((key) => sections[key])}

        {/* Bottom CTA + footer */}
        <motion.footer variants={fadeUp} className="mt-10 text-center">
          <a
            href={preview ? undefined : data.bookingUrl}
            onClick={preview ? (e) => e.preventDefault() : undefined}
            className="inline-block px-8 py-3 text-sm font-semibold"
            style={{ border: `1px solid ${accent}`, color: accent, borderRadius: layout.buttonRadius }}
          >
            Book with {data.name}
          </a>
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
              className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-105"
              style={{ border: `1px solid ${theme.border}`, borderRadius: layout.radius }}
            />
            {item.caption && (
              <figcaption
                className="absolute inset-x-0 bottom-0 px-3 py-2 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100"
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
