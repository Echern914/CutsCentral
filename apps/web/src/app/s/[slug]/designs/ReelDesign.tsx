"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { PrimaryCta, ShopFooter, TextToBookBlock } from "../pageChrome";
import { photosToShow } from "./examples";
import { photoTitle, sectionsBelow, staffOf, type DesignCtx } from "./model";
import {
  Coin,
  DesignFrame,
  ExamplesNote,
  PhotoTile,
  RatingLine,
  RewardsPill,
  TitleRow,
  WaitlistBlock,
  bookButtonStyle,
  photoLabel,
  useViewer,
} from "./parts";

/** How many photos the reel plays, and how long each one holds. */
export const REEL_SLIDES = 5;
export const REEL_SECONDS = 5;

/**
 * THE REEL. The top of the page plays the shop's first photos one after
 * another, story-style, with the name over them - and Book stays pinned at the
 * bottom of the screen the whole way down.
 *
 * Tap the left third to go back, anywhere else to go on; the expand button
 * opens the photo full screen. It advances on its own only for someone who
 * hasn't asked their device for less motion, and never behind an open photo.
 */
export function ReelDesign({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, accent, preview } = ctx;
  const { photos, examples } = photosToShow(data, preview);
  const viewer = useViewer(ctx, examples);
  const reduceMotion = useReducedMotion();
  const slides = photos.slice(0, REEL_SLIDES);
  const count = slides.length;
  const [index, setIndex] = useState(0);
  const current = slides[Math.min(index, Math.max(count - 1, 0))];
  const autoplay = count > 1 && !reduceMotion && !viewer.isOpen;

  useEffect(() => {
    if (!autoplay) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % count), REEL_SECONDS * 1000);
    return () => window.clearTimeout(t);
  }, [autoplay, index, count]);

  const title = current ? photoTitle(data, current) : null;
  const who = current ? staffOf(data, current) : null;
  const chip = [title, who ? `by ${who.name}` : null].filter(Boolean).join(" · ");
  // Book pinned to the bottom - only when there is a place to book. A shop
  // taking requests instead gets its form in the page, as every design does.
  const pinned = ctx.hasBooking && !ctx.showRequestForm;

  const bookBar = pinned ? (
    <div
      className="sticky bottom-0 z-20"
      style={{ background: `linear-gradient(180deg, transparent, ${theme.bg} 45%)` }}
    >
      <div className="mx-auto w-full max-w-lg px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-6">
        <a
          href={preview ? undefined : ctx.bookHref ?? undefined}
          onClick={preview ? (e) => e.preventDefault() : undefined}
          data-tour="book-cta"
          className="block w-full py-3.5 text-center text-sm font-semibold"
          style={bookButtonStyle(ctx)}
        >
          Book an appointment
        </a>
      </div>
    </div>
  ) : null;

  return (
    <DesignFrame
      ctx={ctx}
      after={
        <>
          {bookBar}
          {viewer.node}
        </>
      }
    >
      <motion.header variants={fadeUp} className="relative -mx-5" data-tour="hero">
        <div className="relative h-[68vh] max-h-[640px] min-h-[420px] overflow-hidden">
          {current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={current.url} src={current.url} alt={photoLabel(ctx, current, index)} className="h-full w-full object-cover" />
          ) : data.heroImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.heroImageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div
              className="h-full w-full"
              style={{ background: `radial-gradient(520px 360px at 50% 20%, ${accent}33, ${theme.bg} 75%)` }}
              aria-hidden
            />
          )}

          {count > 1 && (
            <div className="absolute inset-x-3 top-3 z-10 flex gap-1" aria-hidden>
              {slides.map((s, i) => (
                <span
                  key={`${s.url}-${i}`}
                  className="h-[3px] flex-1 overflow-hidden rounded-full"
                  style={{ backgroundColor: "rgba(255,255,255,0.3)" }}
                >
                  {i < index || (i === index && !autoplay) ? (
                    <span className="block h-full w-full" style={{ backgroundColor: "#FFFFFF" }} />
                  ) : i === index ? (
                    <motion.span
                      key={`fill-${index}`}
                      className="block h-full"
                      style={{ backgroundColor: "#FFFFFF" }}
                      initial={{ width: "0%" }}
                      animate={{ width: "100%" }}
                      transition={{ duration: REEL_SECONDS, ease: "linear" }}
                    />
                  ) : null}
                </span>
              ))}
            </div>
          )}

          {count > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous photo"
                onClick={() => setIndex((i) => (i - 1 + count) % count)}
                className="absolute inset-y-0 left-0 w-1/3"
              />
              <button
                type="button"
                aria-label="Next photo"
                onClick={() => setIndex((i) => (i + 1) % count)}
                className="absolute inset-y-0 right-0 w-2/3"
              />
            </>
          )}

          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-72"
            style={{ background: `linear-gradient(180deg, transparent 0%, ${theme.bg}C8 55%, ${theme.bg} 100%)` }}
            aria-hidden
          />
          <div className="pointer-events-none absolute inset-x-5 bottom-5">
            {chip && (
              <span
                className="inline-block px-3 py-1.5 text-xs font-semibold"
                style={{
                  borderRadius: "9999px",
                  backgroundColor: `${theme.bg}B3`,
                  border: `1px solid ${theme.border}`,
                }}
              >
                {chip}
              </span>
            )}
            <div className="mt-3 flex items-center gap-3">
              <Coin ctx={ctx} size={52} />
              <div className="min-w-0">
                <h1 className="text-4xl leading-none tracking-tight" style={{ fontFamily: "var(--page-display)" }}>
                  {data.name}
                </h1>
                <RatingLine ctx={ctx} className="mt-1.5" />
              </div>
            </div>
          </div>
          {current && (
            <button
              type="button"
              onClick={() => viewer.show(slides, index)}
              aria-label="Open this photo"
              className="absolute bottom-5 right-5 z-10 grid h-11 w-11 place-items-center rounded-full"
              style={{ backgroundColor: `${theme.bg}B3`, border: `1px solid ${theme.border}`, color: theme.text }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
              </svg>
            </button>
          )}
        </div>
      </motion.header>

      {examples && <div className="mt-3"><ExamplesNote ctx={ctx} /></div>}
      {data.bio && (
        <motion.p variants={fadeUp} className="mt-4 text-sm" style={{ color: theme.muted }}>
          {data.bio}
        </motion.p>
      )}
      <TextToBookBlock data={data} accent={accent} theme={theme} className="mt-5" />
      {!pinned && (
        <PrimaryCta
          data={data}
          preview={preview}
          theme={theme}
          layout={layout}
          accent={accent}
          bookHref={ctx.bookHref}
          hasBooking={ctx.hasBooking}
          showRequestForm={ctx.showRequestForm}
          className="mt-5"
        />
      )}
      <RewardsPill ctx={ctx} />

      {photos.length > 1 && (
        <motion.section variants={fadeUp} className="mt-8">
          <TitleRow
            ctx={ctx}
            title="More work"
            right={
              <button
                type="button"
                onClick={() => viewer.show(photos, 0)}
                className="min-h-11 text-sm font-semibold"
                style={{ color: accent }}
              >
                See all
              </button>
            }
          />
          <div className="grid grid-cols-4 gap-2">
            {photos.slice(0, 8).map((photo, i) => (
              <PhotoTile
                key={`${photo.url}-${i}`}
                photo={photo}
                label={photoLabel(ctx, photo, i)}
                onOpen={() => viewer.show(photos, i)}
                className="aspect-square"
                style={{ borderRadius: `calc(${layout.radius} * 0.75)` }}
              />
            ))}
          </div>
        </motion.section>
      )}

      {sectionsBelow(ctx, ["gallery"])}
      <WaitlistBlock ctx={ctx} />
      <ShopFooter
        data={data}
        preview={preview}
        inApp={ctx.inApp}
        theme={theme}
        layout={layout}
        accent={accent}
        bookHref={ctx.bookHref}
        hasBooking={ctx.hasBooking}
        rewardsHref={ctx.rewardsHref}
      />
    </DesignFrame>
  );
}
