"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { PrimaryCta, ShopFooter, TextToBookBlock } from "../pageChrome";
import { photosToShow } from "./examples";
import { sectionsBelow, type DesignCtx } from "./model";
import {
  Chip,
  Coin,
  DesignFrame,
  ExamplesNote,
  PhotoTile,
  RatingLine,
  RewardsPill,
  TitleRow,
  WaitlistBlock,
  photoLabel,
  useViewer,
} from "./parts";

/** How many photos the grid shows before "+N" (three rows of three). */
const GRID_SHOWN = 9;

/**
 * PHOTOS FIRST. The page as it was, with the work moved right under Book: a
 * three-across grid, filterable by service when the photos show at least two,
 * each photo opening full screen with "Book this look".
 */
export function GridDesign({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, accent, preview } = ctx;
  const { photos, examples } = photosToShow(data, preview);
  const viewer = useViewer(ctx, examples);
  const [serviceFilter, setServiceFilter] = useState<string | null>(null);

  // Filter chips: the services the photos show, in menu order - offered only
  // when there are at least two to choose between.
  const shownServices = (data.services ?? []).filter((s) => photos.some((p) => p.serviceId === s.id));
  const filtered = serviceFilter ? photos.filter((p) => p.serviceId === serviceFilter) : photos;
  const visible = filtered.slice(0, GRID_SHOWN);
  const more = filtered.length - visible.length;

  return (
    <DesignFrame ctx={ctx} after={viewer.node}>
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
        <div className="relative z-10 -mt-10 flex justify-center">
          <Coin ctx={ctx} size={68} />
        </div>
        <div className="mt-3 text-center">
          <h1 className="text-3xl tracking-tight" style={{ fontFamily: "var(--page-display)" }}>
            {data.name}
          </h1>
          <RatingLine ctx={ctx} center className="mt-2" />
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
              className="mt-2 inline-block text-sm font-medium hover:underline"
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
        bookHref={ctx.bookHref}
        hasBooking={ctx.hasBooking}
        showRequestForm={ctx.showRequestForm}
      />
      <RewardsPill ctx={ctx} />

      {photos.length > 0 && (
        <motion.section variants={fadeUp} className="mt-8">
          <TitleRow
            ctx={ctx}
            title="The work"
            right={
              filtered.length > 1 ? (
                <button
                  type="button"
                  onClick={() => viewer.show(filtered, 0)}
                  className="min-h-11 text-sm font-semibold"
                  style={{ color: accent }}
                >
                  See all
                </button>
              ) : null
            }
          />
          {examples && <ExamplesNote ctx={ctx} />}
          {shownServices.length >= 2 && (
            <div className="-mx-5 mb-3 flex gap-2 overflow-x-auto px-5 pb-1" role="group" aria-label="Show photos of">
              <Chip ctx={ctx} active={serviceFilter === null} onClick={() => setServiceFilter(null)}>
                All
              </Chip>
              {shownServices.map((s) => (
                <Chip key={s.id} ctx={ctx} active={serviceFilter === s.id} onClick={() => setServiceFilter(s.id)}>
                  {s.name}
                </Chip>
              ))}
            </div>
          )}
          <div className="grid grid-cols-3 gap-1 overflow-hidden" style={{ borderRadius: layout.radius }}>
            {visible.map((photo, i) => {
              const last = i === visible.length - 1 && more > 0;
              return (
                <PhotoTile
                  key={`${photo.url}-${i}`}
                  photo={photo}
                  label={last ? `${photoLabel(ctx, photo, i)}, and ${more} more` : photoLabel(ctx, photo, i)}
                  onOpen={() => viewer.show(filtered, i)}
                  className="aspect-square"
                >
                  {last && (
                    <span
                      className="absolute inset-0 grid place-items-center text-2xl font-bold"
                      style={{ backgroundColor: "rgba(0,0,0,0.55)", color: "#FFFFFF", fontFamily: "var(--page-display)" }}
                      aria-hidden
                    >
                      +{more}
                    </span>
                  )}
                </PhotoTile>
              );
            })}
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
