"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import {
  DEFAULT_LAYOUT_STYLE,
  DEFAULT_PAGE_FONT,
  DEFAULT_SECTION_ORDER,
  LAYOUT_STYLES,
  PAGE_FONTS,
  PAGE_THEMES,
  pageDesignFor,
  type LayoutStyleKey,
  type PageFontKey,
  type PageSectionKey,
  type PageThemeKey,
} from "@chairback/config/constants";
import { isUsableBookingLink } from "@chairback/config/bookingLinks";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import { ShopWaitlistForm } from "./ShopWaitlistForm";
import { Gallery, Hours, Promotions, Rewards, Reviews, StampMark } from "./pageSections";
import { PrimaryCta, ShopChrome, ShopFooter, TextToBookBlock } from "./pageChrome";
import { DesignedPage } from "./designs/DesignedPage";
import type { DesignCtx } from "./designs/model";
import type { ShopPageData } from "./page";

/**
 * A barber's public mini-site. Fully identity-driven: every surface reads from
 * the shop's chosen theme + accent + font pairing + layout shape, and the movable
 * sections render in the shop's chosen order. Two shops share zero visual
 * identity. Self-contained styling - deliberately avoids the app's dark-chrome
 * utility classes.
 *
 * The shop's PAGE DESIGN picks the layout. "classic" - the page every shop had
 * before designs existed, and the default - renders below exactly as it always
 * did; every other design is built from the same pieces in designs/.
 *
 * `preview` renders the exact same page for the in-editor live preview, but
 * neutralizes anything that would navigate or submit (booking link, request
 * form, Instagram, the powered-by link) so editing stays on the page.
 */
export function ShopPageClient({
  data,
  preview = false,
  rewardsHref,
  rewardsLabel = "Your rewards",
  bookQuery,
}: {
  data: ShopPageData;
  preview?: boolean;
  /**
   * Appended to the native Book link. Set only for a visit that came through
   * the shop's custom domain (`?cb_domain=`), so the booking page applies the
   * same same-shop check the landing page just passed.
   */
  bookQuery?: string;
  /**
   * Set only when a KNOWN client is viewing (i.e. rendered from
   * /r/<magicToken>, where the token identifies them). Adds an entry back into
   * their punch card. Anonymous visitors on /s/<slug> pass nothing and see no
   * such link — there'd be no card to show them.
   */
  rewardsHref?: string;
  rewardsLabel?: string;
}) {
  // Clear the native app's WebView spinner (reachable from the rewards page via
  // "More from {shop}"; without this the shell waits for a ready signal forever).
  useSignalNativeReady();
  // In-app, the powered-by footer must not link out to the marketing site (3.1.1).
  const inApp = useIsNativeApp();

  const theme =
    PAGE_THEMES[(data.theme as PageThemeKey) in PAGE_THEMES ? (data.theme as PageThemeKey) : "classic"];
  const accent = data.accentColor || theme.accent;

  // Native booking: the CTA points at the in-app slot picker instead of the
  // external bookingUrl, and the lead-request form is replaced by real booking.
  const bookIsNative = data.bookingMode === "native";
  // The shared rule (bookingLinks.ts): an outside link only when a customer
  // could actually open it - a malformed one is no destination, not a dead button.
  const outsideLink = isUsableBookingLink(data.bookingUrl) ? data.bookingUrl : null;
  const bookHref = bookIsNative ? `/book/${data.slug}${bookQuery ?? ""}` : outsideLink;
  // A shop may have NO booking destination (no native, no external link). Then
  // we hide the "Book" CTAs and lean on the request form instead.
  const hasBooking = bookIsNative || outsideLink !== null;
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

  const design = pageDesignFor(data.pageDesign);
  if (design !== "classic") {
    const ctx: DesignCtx = {
      data,
      preview,
      inApp,
      mounted,
      theme,
      accent,
      layout,
      surface,
      rootStyle,
      bookHref,
      bookIsNative,
      hasBooking,
      showRequestForm,
      bookQuery,
      rewardsHref,
      rewardsLabel,
      sections,
      order,
    };
    return <DesignedPage design={design} ctx={ctx} />;
  }

  return (
    <div className="min-h-dvh" style={rootStyle}>
      <ShopChrome data={data} preview={preview} theme={theme} layout={layout} />
      <motion.main
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-lg px-5 pb-16"
        style={{ fontFamily: "var(--page-body)" }}
      >
        {/* Hero: a full-bleed banner that fades into the page, then the shop's
            logo coin (when uploaded) overlapping the fade, then the name. */}
        <motion.header variants={fadeUp} className="relative" data-tour="hero">
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

          {/* Logo coin — same treatment as the rewards page header. alt="" is
              deliberate: the shop name renders immediately below. */}
          {data.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.logoUrl}
              alt=""
              className="relative z-10 mx-auto -mt-10 h-16 w-16 object-cover"
              style={{
                backgroundColor: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: layout.radius,
              }}
            />
          )}

          <div className={`${data.logoUrl ? "mt-3" : "mt-4"} text-center`}>
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

        <TextToBookBlock data={data} accent={accent} theme={theme} />

        <PrimaryCta
          data={data}
          preview={preview}
          theme={theme}
          layout={layout}
          accent={accent}
          bookHref={bookHref}
          hasBooking={hasBooking}
          showRequestForm={showRequestForm}
        />

        {/* A known client's way to their punch card. Its own block, OUTSIDE the
            data-tour="book-cta" div above - the demo tour spotlights that
            anchor, and this link only exists for real token-holding clients,
            never in the demo. Deliberately secondary to Book: this page exists
            to get them booked; the card is what they check on the way. */}
        {rewardsHref && (
          <motion.div variants={fadeUp} className="mt-3">
            <a
              href={rewardsHref}
              className="flex w-full items-center justify-center gap-2 py-3 text-center text-sm font-medium transition-transform duration-200 ease-out hover:scale-[1.01]"
              style={{
                border: `1px solid ${theme.border}`,
                color: theme.text,
                borderRadius: layout.buttonRadius,
              }}
            >
              <StampMark />
              {rewardsLabel}
            </a>
          </motion.div>
        )}

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

        <ShopFooter
          data={data}
          preview={preview}
          inApp={inApp}
          theme={theme}
          layout={layout}
          accent={accent}
          bookHref={bookHref}
          hasBooking={hasBooking}
          rewardsHref={rewardsHref}
        />
      </motion.main>
    </div>
  );
}
