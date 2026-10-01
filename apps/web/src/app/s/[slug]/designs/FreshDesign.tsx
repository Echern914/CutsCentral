"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { PrimaryCta, ShopFooter, TextToBookBlock } from "../pageChrome";
import { SectionTitle, Stars } from "../pageSections";
import { ReviewForm } from "../ReviewForm";
import type { PagePhoto } from "../page";
import { photosToShow } from "./examples";
import {
  addedLabel,
  bookPickedHref,
  feedWithReviews,
  newestFirst,
  photoTitle,
  priceText,
  sectionsBelow,
  serviceOf,
  staffOf,
  type DesignCtx,
  type Review,
} from "./model";
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
 * FRESH WORK. The page reads like a feed: the newest photos first, big, each
 * saying what it is, when it went up and who did it, with written reviews
 * between them - so a page that's kept up looks kept up.
 *
 * Reviews follow the shop's own section choice: hidden there, they stay out of
 * the feed too.
 */
export function FreshDesign({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, accent, preview } = ctx;
  const { photos, examples } = photosToShow(data, preview);
  const viewer = useViewer(ctx, examples);
  const showsReviews = ctx.order.includes("reviews");
  const ordered = useMemo(() => newestFirst(photos), [photos]);
  const feed = feedWithReviews(ordered, showsReviews ? data.reviews : []);
  // Clock-relative words wait for mount (hydration safety), as the deals' "ends in" does.
  const now = useMemo(() => (ctx.mounted ? new Date() : null), [ctx.mounted]);

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

      {feed.length > 0 && (
        <motion.section variants={fadeUp} className="mt-8">
          <TitleRow
            ctx={ctx}
            title="Fresh work"
            right={
              photos.length > 0 ? (
                <span className="text-xs" style={{ color: theme.muted }}>
                  Newest first
                </span>
              ) : null
            }
          />
          {examples && <ExamplesNote ctx={ctx} />}
          <div className="flex flex-col gap-6">
            {feed.map((item, i) =>
              item.kind === "photo" ? (
                <FeedPhoto
                  key={`p-${item.photo.url}-${item.index}`}
                  ctx={ctx}
                  photo={item.photo}
                  index={item.index}
                  now={now}
                  examples={examples}
                  onOpen={() => viewer.show(ordered, item.index)}
                />
              ) : (
                <FeedReview key={`r-${item.review.id}-${i}`} ctx={ctx} review={item.review} />
              ),
            )}
          </div>
        </motion.section>
      )}

      {sectionsBelow(ctx, ["gallery", "reviews"])}

      {showsReviews && (
        <motion.section variants={fadeUp} className="mt-8">
          <SectionTitle muted={theme.muted}>Leave a review</SectionTitle>
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
        </motion.section>
      )}

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
        platformOrigin={ctx.platformOrigin}
      />
    </DesignFrame>
  );
}

function FeedPhoto({
  ctx,
  photo,
  index,
  now,
  examples,
  onOpen,
}: {
  ctx: DesignCtx;
  photo: PagePhoto;
  index: number;
  now: Date | null;
  examples: boolean;
  onOpen: () => void;
}) {
  const { data, theme, layout, accent, preview } = ctx;
  const service = serviceOf(data, photo);
  const staff = staffOf(data, photo);
  const price = priceText(service?.price);
  const caption = photo.caption?.trim();
  const chip = [caption, service ? `${service.name}${price ? ` ${price}` : ""}` : null].filter(Boolean).join(" · ");
  const when = now ? addedLabel(photo.addedAt, now) : null;
  const tagged = Boolean(service || staff);
  const href = examples || !tagged ? null : bookPickedHref(ctx, { serviceId: service?.id, staffId: staff?.id });
  const label = photoLabel(ctx, photo, index);

  const pill = {
    borderRadius: "9999px",
    backgroundColor: `${theme.bg}B3`,
    border: `1px solid ${theme.border}`,
    color: theme.text,
  };

  return (
    <article>
      <PhotoTile photo={photo} label={label} onOpen={onOpen} className="h-80 w-full" style={{ borderRadius: layout.radius }}>
        {chip && (
          <span className="absolute left-3 top-3 max-w-[70%] truncate px-3 py-1.5 text-xs font-semibold" style={pill}>
            {chip}
          </span>
        )}
        {when && (
          <span className="absolute right-3 top-3 px-3 py-1.5 text-xs" style={pill}>
            {when}
          </span>
        )}
      </PhotoTile>
      {(staff || href) && (
        <div className="mt-2 flex min-h-11 items-center justify-between gap-3 px-1">
          <span className="text-sm" style={{ color: theme.muted }}>
            {staff ? `by ${staff.name}` : ""}
          </span>
          {href && (
            <a
              href={preview ? undefined : href}
              onClick={preview ? (e) => e.preventDefault() : undefined}
              aria-label={`Book this look: ${photoTitle(data, photo) ?? label}`}
              className="text-sm font-semibold"
              style={{ color: accent }}
            >
              Book this look →
            </a>
          )}
        </div>
      )}
    </article>
  );
}

function FeedReview({ ctx, review }: { ctx: DesignCtx; review: Review }) {
  const { theme, accent } = ctx;
  return (
    <figure className="px-5 py-5" style={ctx.surface}>
      <Stars value={review.rating} accent={accent} border={theme.border} />
      <blockquote className="mt-2 text-base leading-relaxed">“{review.body}”</blockquote>
      {review.authorName && (
        <figcaption className="mt-2 text-xs" style={{ color: theme.muted }}>
          {review.authorName}
        </figcaption>
      )}
    </figure>
  );
}
