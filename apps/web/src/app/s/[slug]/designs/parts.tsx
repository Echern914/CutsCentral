"use client";

import { useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import { fadeUp, staggerContainer } from "@/components/motion/variants";
import { ShopWaitlistForm } from "../ShopWaitlistForm";
import { ShopChrome } from "../pageChrome";
import { StampMark, Stars } from "../pageSections";
import type { PagePhoto, PageStaff } from "../page";
import { monogram, photoTitle, type DesignCtx } from "./model";
import { PhotoViewer } from "./PhotoViewer";

/** The frame every design shares: theme and fonts on the root, the corner buttons, the staggered entrance. */
export function DesignFrame({
  ctx,
  children,
  after,
}: {
  ctx: DesignCtx;
  children: React.ReactNode;
  /** Rendered after the page body: the photo viewer, a pinned Book bar. */
  after?: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh" style={ctx.rootStyle}>
      <ShopChrome data={ctx.data} preview={ctx.preview} theme={ctx.theme} layout={ctx.layout} />
      <motion.main
        variants={staggerContainer}
        initial="hidden"
        animate="show"
        className="mx-auto w-full max-w-lg px-5 pb-16"
        style={{ fontFamily: "var(--page-body)" }}
      >
        {children}
      </motion.main>
      {after}
    </div>
  );
}

/** The shop's logo, or - with none uploaded - its initials on the same coin. */
export function Coin({ ctx, size, className }: { ctx: DesignCtx; size: number; className?: string }) {
  const { data, theme, layout, accent } = ctx;
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: theme.surface,
    border: `1px solid ${theme.border}`,
    borderRadius: layout.radius,
  };
  if (data.logoUrl) {
    // alt="" is deliberate: the shop's name always renders beside or below.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={data.logoUrl} alt="" className={`shrink-0 object-cover ${className ?? ""}`} style={style} />;
  }
  return (
    <div
      aria-hidden
      className={`grid shrink-0 place-items-center font-bold ${className ?? ""}`}
      style={{ ...style, color: accent, fontFamily: "var(--page-display)", fontSize: Math.round(size * 0.36) }}
    >
      {monogram(data.name)}
    </div>
  );
}

/**
 * Stars, the average and how many ratings - the Reviews header, lifted to the
 * top where a visitor decides. Nothing at all while there are no ratings.
 */
export function RatingLine({ ctx, className, center }: { ctx: DesignCtx; className?: string; center?: boolean }) {
  const { data, theme, accent } = ctx;
  const avg = data.reviewSummary.avgRating;
  const count = data.reviewSummary.count;
  if (!(count > 0 && avg != null)) return null;
  return (
    <div className={`flex items-center gap-1.5 text-sm ${center ? "justify-center" : ""} ${className ?? ""}`}>
      <Stars value={Math.round(avg)} accent={accent} border={theme.border} />
      <span className="font-semibold">{avg.toFixed(1)}</span>
      <span style={{ color: theme.muted }}>
        · {count} {count === 1 ? "rating" : "ratings"}
      </span>
    </div>
  );
}

/**
 * A known client's way to their punch card, kept small: these designs lead with
 * the work. Left out in the app, whose Rewards tab already holds every shop's
 * card (the owner: "move that to customer side"). On the web it stays - a
 * client without the app has no other way back to their card from here.
 */
export function RewardsPill({ ctx }: { ctx: DesignCtx }) {
  if (!ctx.rewardsHref || ctx.inApp) return null;
  return (
    <motion.div variants={fadeUp} className="mt-3 flex justify-center">
      <a
        href={ctx.rewardsHref}
        className="inline-flex min-h-11 items-center gap-2 px-4 text-xs font-medium"
        style={{ border: `1px solid ${ctx.theme.border}`, color: ctx.theme.text, borderRadius: ctx.layout.buttonRadius }}
      >
        <StampMark />
        {ctx.rewardsLabel}
      </a>
    </motion.div>
  );
}

/**
 * The standing waitlist, moved off the top. A shop that books here needs none
 * on this page - its booking page offers the waitlist when a day is full - so
 * only a shop that books elsewhere keeps it, lower down.
 */
export function WaitlistBlock({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, accent, preview } = ctx;
  if (!data.waitlistEnabled || ctx.showRequestForm || ctx.bookIsNative) return null;
  return (
    <motion.div variants={fadeUp} className="mt-8">
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
  );
}

/** A photo that opens the viewer. The button carries the name; the image is decoration. */
export function PhotoTile({
  photo,
  label,
  onOpen,
  className,
  style,
  children,
}: {
  photo: PagePhoto;
  label: string;
  onOpen: () => void;
  className?: string;
  style?: CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={`group relative block overflow-hidden ${className ?? ""}`}
      style={style}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.url}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
      />
      {children}
    </button>
  );
}

/** What a photo is called for someone who can't see it. */
export function photoLabel(ctx: DesignCtx, photo: PagePhoto, i: number): string {
  return photoTitle(ctx.data, photo) ?? `${ctx.data.name} photo ${i + 1}`;
}

/** A filter chip: a real toggle button, pressed when active. */
export function Chip({
  ctx,
  active,
  onClick,
  person,
  children,
}: {
  ctx: DesignCtx;
  active: boolean;
  onClick: () => void;
  person?: PageStaff;
  children: React.ReactNode;
}) {
  const { theme } = ctx;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap px-4 text-xs font-medium"
      style={{
        borderRadius: "9999px",
        border: `1px solid ${active ? theme.text : theme.border}`,
        backgroundColor: active ? theme.text : "transparent",
        color: active ? theme.bg : theme.text,
        paddingLeft: person ? 6 : undefined,
      }}
    >
      {person &&
        (person.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={person.imageUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
        ) : (
          <span
            aria-hidden
            className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold"
            style={{ backgroundColor: theme.surface, color: theme.text, border: `1px solid ${theme.border}` }}
          >
            {person.name.trim().charAt(0).toUpperCase()}
          </span>
        ))}
      {children}
    </button>
  );
}

/** The small label over example photos in the editor preview. */
export function ExamplesNote({ ctx }: { ctx: DesignCtx }) {
  return (
    <p className="mb-3 px-1 text-[11px] uppercase tracking-wide" style={{ color: ctx.theme.muted }}>
      Example photos — yours will appear here
    </p>
  );
}

/** A section heading with an optional action on the right ("See all"). */
export function TitleRow({ ctx, title, right }: { ctx: DesignCtx; title: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3 px-1">
      <h2 className="text-xs font-medium uppercase tracking-[0.18em]" style={{ color: ctx.theme.muted }}>
        {title}
      </h2>
      {right}
    </div>
  );
}

/** The photo viewer, opened from any tile; `node` goes after the page body. */
export function useViewer(ctx: DesignCtx, examples: boolean) {
  const [open, setOpen] = useState<{ photos: PagePhoto[]; index: number } | null>(null);
  const node = open ? (
    <PhotoViewer ctx={ctx} photos={open.photos} start={open.index} examples={examples} onClose={() => setOpen(null)} />
  ) : null;
  return { show: (photos: PagePhoto[], index: number) => setOpen({ photos, index }), node, isOpen: open !== null };
}

/**
 * The compact top the content-first designs use: coin, name and rating on one
 * row, the bio under it. Padded down so the corner back button (fixed, top
 * left) never sits on the coin.
 */
export function RowHeader({ ctx }: { ctx: DesignCtx }) {
  const { data, theme } = ctx;
  return (
    <motion.header variants={fadeUp} className="pt-16" data-tour="hero">
      <div className="flex items-center gap-3.5">
        <Coin ctx={ctx} size={56} />
        <div className="min-w-0">
          <h1 className="text-[28px] leading-none tracking-tight" style={{ fontFamily: "var(--page-display)" }}>
            {data.name}
          </h1>
          <RatingLine ctx={ctx} className="mt-1.5" />
        </div>
      </div>
      {data.bio && (
        <p className="mt-3 text-sm" style={{ color: theme.muted }}>
          {data.bio}
        </p>
      )}
    </motion.header>
  );
}

/** Book button styling shared by the designs' own Book links. */
export function bookButtonStyle(ctx: DesignCtx): CSSProperties {
  return {
    backgroundColor: ctx.accent,
    color: ctx.theme.scheme === "light" ? "#FFFFFF" : "#101012",
    boxShadow: `0 8px 30px -10px ${ctx.accent}AA`,
    borderRadius: ctx.layout.buttonRadius,
  };
}
