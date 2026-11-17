"use client";

import { motion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { ShopWaitlistForm } from "../ShopWaitlistForm";
import { StampMark } from "../pageSections";
import { PrimaryCta, ShopChrome, ShopFooter, TextToBookBlock } from "../pageChrome";
import type { DesignCtx } from "./model";

/**
 * The ORIGINAL page: the layout every shop had before the Studio redesign
 * (#771, 2026-11-16), restored as the barber's choice (Shop.pageOriginalLayout)
 * because a barber asked for his page back the way he had it: his name, a
 * big Book button, then his sections. No services list - a client picks the
 * service on the booking page.
 *
 * Studio stays the page every shop gets unless its barber picks this one.
 * Built from the same chrome as before (ShopChrome, PrimaryCta, ShopFooter),
 * and from the ctx ShopPageClient works out once, so Book goes exactly where
 * it goes on the new page.
 */
export function OriginalDesign({ ctx }: { ctx: DesignCtx }) {
  const {
    data,
    preview,
    inApp,
    theme,
    accent,
    layout,
    rootStyle,
    bookHref,
    hasBooking,
    showRequestForm,
    platformOrigin,
    rewardsHref,
    rewardsLabel,
    appRewardsTab,
    sections,
    order,
  } = ctx;
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

          {/* Logo coin. alt="" is deliberate: the shop name renders below. */}
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

        {/* A known client's way to their punch card, secondary to Book. Inside
            an app build whose Rewards tab holds it all, it isn't here at all. */}
        {rewardsHref && !appRewardsTab && (
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

        {/* Standing waitlist entry, for when they're fully booked. Not shown
            with the request form (that's already a "reach out" path). */}
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
          platformOrigin={platformOrigin}
        />
      </motion.main>
    </div>
  );
}
