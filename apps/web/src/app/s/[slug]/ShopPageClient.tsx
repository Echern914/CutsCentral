"use client";

import { useEffect, useState, type CSSProperties } from "react";
import {
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
import { isUsableBookingLink, showsRequestForm } from "@chairback/config/bookingLinks";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import { useAppHasRewardsTab } from "@/lib/useAppHasRewardsTab";
import { Gallery, Hours, Promotions, Rewards, Reviews } from "./pageSections";
import { StudioDesign } from "./designs/StudioDesign";
import { OriginalDesign } from "./designs/OriginalDesign";
import type { DesignCtx } from "./designs/model";
import type { ShopPageData } from "./page";
import { AppFrameScheme } from "@/components/PageScheme";

/**
 * A barber's public mini-site. Fully identity-driven: every surface reads from
 * the shop's chosen theme + accent + font pairing + layout shape, and the movable
 * sections render in the shop's chosen order. Two shops share zero visual
 * identity. Self-contained styling - deliberately avoids the app's dark-chrome
 * utility classes.
 *
 * Every shop's page is laid out as STUDIO (designs/StudioDesign.tsx). The
 * per-shop page design picker, and the six other layouts, were retired on
 * 2026-11-16 so every client sees the redesigned page.
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
  bookPath,
  platformOrigin = "",
}: {
  data: ShopPageData;
  preview?: boolean;
  /**
   * Appended to the native Book link. Set for a visit that came through a
   * link of the custom-domain redirect days (`?cb_domain=`), so the booking
   * page applies the same same-shop check the landing page just passed - or
   * for a customer's own page opened from the ChairBack app (`?cb_me=`, config
   * bookingHandoff.ts), so their booking shows in the app.
   */
  bookQuery?: string;
  /**
   * Where native booking lives on THIS site: `/book/<slug>` on
   * getchairback.com (the default), `/book` on the shop's own domain, so the
   * address bar there reads drickcuttinup.com/book (lib/customDomainRouting.ts).
   */
  bookPath?: string;
  /**
   * Where this page's links to ChairBack ITSELF point - the powered-by line,
   * the address a share hands on. Empty (this same site) on getchairback.com;
   * the platform's origin when the page is served on the shop's OWN domain,
   * where "/" is this very page. Booking and finding your rewards are not
   * ChairBack's pages: they stay on whichever site this is.
   */
  platformOrigin?: string;
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
  // An app build whose Rewards tab holds the client's whole rewards, timer
  // included: there, "Your rewards" leaves this page (the owner: "the client
  // rewards under book appointment ... to be in rewards in the client side").
  const appRewardsTab = useAppHasRewardsTab();

  const theme =
    PAGE_THEMES[(data.theme as PageThemeKey) in PAGE_THEMES ? (data.theme as PageThemeKey) : "classic"];
  const accent = data.accentColor || theme.accent;

  // Native booking: the CTA points at the in-app slot picker instead of the
  // external bookingUrl, and the lead-request form is replaced by real booking.
  const bookIsNative = data.bookingMode === "native";
  // The shared rule (bookingLinks.ts): an outside link only when a customer
  // could actually open it - a malformed one is no destination, not a dead button.
  const outsideLink = isUsableBookingLink(data.bookingUrl) ? data.bookingUrl : null;
  const bookHref = bookIsNative ? `${bookPath ?? `/book/${data.slug}`}${bookQuery ?? ""}` : outsideLink;
  // A shop may have NO booking destination (no native, no external link). Then
  // we hide the "Book" CTAs and lean on the request form instead.
  const hasBooking = bookIsNative || outsideLink !== null;
  // Show the request form when the barber enabled it OR when there's no booking
  // path at all - so a no-link shop with requests off still gives clients a way
  // to reach out, instead of a dead page with no CTA. The request route reads
  // the same rule (bookingLinks.ts), so a form shown here is one it accepts.
  const showRequestForm = showsRequestForm(data);

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

  // 🔴 EVERY SHOP RENDERS STUDIO unless its barber picked the ORIGINAL look
  // (Shop.pageOriginalLayout, 2026-11-17 - a barber asked for his page back).
  // The owner's call (2026-11-16): the client side is redesigned for every
  // shop, whatever page design it had picked. The shop
  // still dresses it - its theme, accent, fonts, shape, logo, photos and section
  // order all apply - but the layout is no longer a choice. `data.pageDesign` is
  // still stored and sent by the API; nothing here reads it.
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
    bookPath,
    platformOrigin,
    rewardsHref,
    rewardsLabel,
    appRewardsTab,
    sections,
    order,
  };
  return (
    <>
      {/* The iPhone app's bar above this page wears the same scheme. */}
      {!preview && <AppFrameScheme scheme={theme.scheme} />}
      {data.originalLayout === true ? <OriginalDesign ctx={ctx} /> : <StudioDesign ctx={ctx} />}
    </>
  );
}
