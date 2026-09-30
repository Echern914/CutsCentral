"use client";

import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { PrimaryCta, ShopFooter, TextToBookBlock } from "../pageChrome";
import type { PagePhoto, PageService } from "../page";
import { photosToShow } from "./examples";
import { bookPickedHref, durationText, priceText, sectionsBelow, servicePhotos, type DesignCtx } from "./model";
import {
  DesignFrame,
  ExamplesNote,
  PhotoTile,
  RewardsPill,
  RowHeader,
  TitleRow,
  WaitlistBlock,
  photoLabel,
  useViewer,
} from "./parts";

/**
 * LOOKBOOK. The menu, with pictures: every service shows the photos tagged to
 * it, so a client picks by the look and books that service in one tap. Photos
 * that name no service follow under "More work". A shop with no menu here (it
 * books elsewhere) gets its photos as a grid instead.
 */
export function LookbookDesign({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, accent, preview } = ctx;
  const { photos, examples } = photosToShow(data, preview);
  const viewer = useViewer(ctx, examples);
  const services = data.services ?? [];
  const menuIds = new Set(services.map((s) => s.id));

  // In the editor preview the example photos are dealt across the services,
  // so the owner sees the idea before tagging anything.
  const cards = services.map((service, i) => ({
    service,
    photos: examples ? [0, 1, 2].map((k) => photos[(i * 3 + k) % photos.length]!) : servicePhotos(service, photos),
  }));
  const untagged = examples ? [] : photos.filter((p) => !p.serviceId || !menuIds.has(p.serviceId));
  const anyStrip = cards.some((c) => c.photos.length > 1);

  return (
    <DesignFrame ctx={ctx} after={viewer.node}>
      <RowHeader ctx={ctx} />
      <TextToBookBlock data={data} accent={accent} theme={theme} className="mt-5" />
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
      <RewardsPill ctx={ctx} />

      {cards.length > 0 ? (
        <motion.section variants={fadeUp} className="mt-8">
          <TitleRow
            ctx={ctx}
            title="Services"
            right={
              anyStrip ? (
                <span className="text-xs" style={{ color: theme.muted }}>
                  Swipe for more photos
                </span>
              ) : null
            }
          />
          {examples && <ExamplesNote ctx={ctx} />}
          <div className="flex flex-col gap-3">
            {cards.map(({ service, photos: shots }) => (
              <ServiceCard
                key={service.id}
                ctx={ctx}
                service={service}
                photos={shots}
                onOpen={(i) => viewer.show(shots, i)}
              />
            ))}
          </div>
        </motion.section>
      ) : (
        photos.length > 0 && (
          <PhotoStripSection ctx={ctx} title="The work" photos={photos} examples={examples} onOpen={viewer.show} />
        )
      )}

      {cards.length > 0 && untagged.length > 0 && (
        <PhotoStripSection ctx={ctx} title="More work" photos={untagged} examples={false} onOpen={viewer.show} />
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

function ServiceCard({
  ctx,
  service,
  photos,
  onOpen,
}: {
  ctx: DesignCtx;
  service: PageService;
  photos: PagePhoto[];
  onOpen: (index: number) => void;
}) {
  const { theme, layout, accent, preview } = ctx;
  const href = bookPickedHref(ctx, { serviceId: service.id });
  const price = priceText(service.price);
  const details = [durationText(service.durationMin), service.description?.trim()].filter(Boolean).join(" · ");
  return (
    <div className="p-3" style={ctx.surface}>
      {photos.length > 0 && (
        <div className="-mx-3 flex snap-x snap-mandatory gap-2 overflow-x-auto px-3 pb-1">
          {photos.map((photo, i) => (
            <PhotoTile
              key={`${photo.url}-${i}`}
              photo={photo}
              label={photoLabel(ctx, photo, i)}
              onOpen={() => onOpen(i)}
              className="h-44 w-36 shrink-0 snap-start"
              style={{ borderRadius: `calc(${layout.radius} * 0.75)` }}
            />
          ))}
        </div>
      )}
      <div className={`${photos.length > 0 ? "mt-3" : ""} flex items-start justify-between gap-3`}>
        <div className="min-w-0">
          <h3 className="text-lg leading-tight" style={{ fontFamily: "var(--page-display)" }}>
            {service.name}
          </h3>
          <p className="mt-1 text-xs" style={{ color: theme.muted }}>
            {details}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {price && <p className="text-base font-semibold">{price}</p>}
          {href && (
            <a
              href={preview ? undefined : href}
              onClick={preview ? (e) => e.preventDefault() : undefined}
              aria-label={`Book ${service.name}`}
              className="mt-1.5 inline-flex min-h-11 items-center px-4 text-sm font-semibold"
              style={{ border: `1px solid ${accent}`, color: accent, borderRadius: layout.buttonRadius }}
            >
              Book
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function PhotoStripSection({
  ctx,
  title,
  photos,
  examples,
  onOpen,
}: {
  ctx: DesignCtx;
  title: string;
  photos: PagePhoto[];
  examples: boolean;
  onOpen: (photos: PagePhoto[], index: number) => void;
}) {
  return (
    <motion.section variants={fadeUp} className="mt-8">
      <TitleRow ctx={ctx} title={title} />
      {examples && <ExamplesNote ctx={ctx} />}
      <div className="-mx-5 flex snap-x snap-mandatory gap-2 overflow-x-auto px-5 pb-1">
        {photos.map((photo, i) => (
          <PhotoTile
            key={`${photo.url}-${i}`}
            photo={photo}
            label={photoLabel(ctx, photo, i)}
            onOpen={() => onOpen(photos, i)}
            className="h-36 w-28 shrink-0 snap-start"
            style={{ borderRadius: `calc(${ctx.layout.radius} * 0.75)` }}
          />
        ))}
      </div>
    </motion.section>
  );
}
