"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { PrimaryCta, ShopFooter, TextToBookBlock } from "../pageChrome";
import { StampMark } from "../pageSections";
import type { PageService, PageStaff, ShopPageData } from "../page";
import { photosToShow } from "./examples";
import { bookPickedHref, durationText, newestFirst, priceText, sectionsBelow, type DesignCtx } from "./model";
import {
  Coin,
  DesignFrame,
  ExamplesNote,
  PhotoTile,
  RatingLine,
  TitleRow,
  WaitlistBlock,
  bookButtonStyle,
  photoLabel,
  useViewer,
} from "./parts";

/** Recent work shows one row of three; See all opens the rest. */
const RECENT_SHOWN = 3;

/**
 * STUDIO. The page as a storefront: a cover with the shop's coin, quick ways to
 * reach it (directions, a text, Instagram), then the menu as one list - every
 * row books that service - the team, the latest work, and Book pinned to the
 * bottom of the screen the whole way down with the lowest price beside it.
 *
 * A shop that takes requests instead gets its form in the page, as every
 * design does, and no pinned bar.
 */
export function StudioDesign({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, accent, preview } = ctx;
  const { photos, examples } = photosToShow(data, preview);
  const viewer = useViewer(ctx, examples);
  const recent = newestFirst(photos);
  const services = data.services ?? [];
  const team = data.staff ?? [];
  const pinned = ctx.hasBooking && !ctx.showRequestForm;
  const city = [data.addressCity, data.addressRegion].filter(Boolean).join(", ");

  const bookBar = pinned ? <BookBar ctx={ctx} from={lowestPrice(services)} /> : null;

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
      <motion.header variants={fadeUp} className="relative" data-tour="hero">
        {data.heroImageUrl ? (
          <div className="relative -mx-5 h-44 overflow-hidden sm:h-52">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={data.heroImageUrl} alt="" className="h-full w-full object-cover" />
            <div
              className="absolute inset-0"
              style={{ background: `linear-gradient(180deg, transparent 55%, ${theme.bg} 100%)` }}
              aria-hidden
            />
          </div>
        ) : (
          <div
            className="-mx-5 h-32"
            style={{ background: `linear-gradient(160deg, ${accent}33, ${theme.bg} 80%)` }}
            aria-hidden
          />
        )}
        <div className="relative -mt-10 flex items-end justify-between gap-3">
          <Coin ctx={ctx} size={76} className="shadow-lg" />
          <ShareButton ctx={ctx} />
        </div>
        <h1 className="mt-3 text-[30px] leading-tight tracking-tight" style={{ fontFamily: "var(--page-display)" }}>
          {data.name}
        </h1>
        {city && (
          <p className="mt-0.5 text-sm" style={{ color: theme.muted }}>
            {city}
          </p>
        )}
        <RatingLine ctx={ctx} className="mt-2" />
        {data.bio && (
          <p className="mt-3 text-sm" style={{ color: theme.muted }}>
            {data.bio}
          </p>
        )}
        <Actions ctx={ctx} />
      </motion.header>

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
        />
      )}

      {services.length > 0 && (
        <motion.section variants={fadeUp} className="mt-8">
          <TitleRow ctx={ctx} title="Services" />
          <Menu ctx={ctx} services={services} />
        </motion.section>
      )}

      {team.length >= 2 && (
        <motion.section variants={fadeUp} className="mt-8">
          <TitleRow ctx={ctx} title="The team" />
          <Team ctx={ctx} team={team} />
        </motion.section>
      )}

      {recent.length > 0 && (
        <motion.section variants={fadeUp} className="mt-8">
          <TitleRow
            ctx={ctx}
            title="Recent work"
            right={
              recent.length > RECENT_SHOWN ? (
                <button
                  type="button"
                  onClick={() => viewer.show(recent, 0)}
                  className="min-h-11 text-sm font-semibold"
                  style={{ color: accent }}
                >
                  See all {recent.length}
                </button>
              ) : null
            }
          />
          {examples && <ExamplesNote ctx={ctx} />}
          <div className="grid grid-cols-3 gap-1.5">
            {recent.slice(0, RECENT_SHOWN).map((photo, i) => (
              <PhotoTile
                key={`${photo.url}-${i}`}
                photo={photo}
                label={photoLabel(ctx, photo, i)}
                onOpen={() => viewer.show(recent, i)}
                className="aspect-square"
                style={{ borderRadius: `calc(${layout.radius} * 0.75)` }}
              />
            ))}
          </div>
        </motion.section>
      )}

      <RewardsRow ctx={ctx} />
      {sectionsBelow(ctx, ["gallery"])}
      <TextToBookBlock data={data} accent={accent} theme={theme} className="mt-8" />
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

/** The lowest listed price, for "From $20" beside Book. Null when nothing has a price. */
export function lowestPrice(services: PageService[]): number | null {
  const prices = services.map((s) => s.price).filter((p): p is number => p != null && p > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/** The address in one line for a maps search, or null without a street or a city. */
export function mapsQuery(data: Pick<ShopPageData, "name" | "addressStreet" | "addressCity" | "addressRegion" | "addressPostal">): string | null {
  if (!data.addressStreet && !data.addressCity) return null;
  const place = [data.addressStreet, data.addressCity, data.addressRegion, data.addressPostal].filter(Boolean).join(", ");
  return `${data.name}, ${place}`;
}

/**
 * The link a visitor shares: the shop's page by its slug, never the address
 * bar. This page also renders under a client's own rewards link, and the
 * token in that address is the key to their card - a share must not hand it
 * on. On the shop's own domain the platform link works just the same.
 */
export function shareUrl(ctx: Pick<DesignCtx, "platformOrigin" | "data">, origin: string): string {
  return `${ctx.platformOrigin || origin}/s/${ctx.data.slug}`;
}

/** Directions, a text, Instagram: only the ones this shop has, as equal buttons. */
function Actions({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, preview } = ctx;
  const query = mapsQuery(data);
  const items: { key: string; label: string; aria: string; href: string; external: boolean; icon: React.ReactNode }[] = [];
  if (query) {
    items.push({
      key: "directions",
      label: "Directions",
      aria: `Directions to ${data.name}`,
      href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
      external: true,
      icon: (
        <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />
      ),
    });
  }
  if (data.receptionistNumber) {
    items.push({
      key: "text",
      label: "Text",
      aria: `Text ${data.name}`,
      href: `sms:${data.receptionistNumber}`,
      external: false,
      icon: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
    });
  }
  if (data.instagramHandle) {
    items.push({
      key: "instagram",
      label: "Instagram",
      aria: `${data.name} on Instagram`,
      href: `https://instagram.com/${data.instagramHandle}`,
      external: true,
      icon: (
        <>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" />
        </>
      ),
    });
  }
  if (items.length === 0) return null;
  return (
    <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((item) => (
        <a
          key={item.key}
          href={preview ? undefined : item.href}
          onClick={preview ? (e) => e.preventDefault() : undefined}
          target={item.external ? "_blank" : undefined}
          rel={item.external ? "noopener noreferrer" : undefined}
          aria-label={item.aria}
          className="flex min-h-11 flex-col items-center justify-center gap-1 px-2 py-2.5 text-xs font-medium"
          style={{
            border: `1px solid ${theme.border}`,
            backgroundColor: theme.surface,
            color: theme.text,
            // A tile, not a pill: an icon over a word won't sit in a full round.
            borderRadius: `calc(${layout.radius} * 0.75)`,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {item.icon}
          </svg>
          {item.label}
        </a>
      ))}
    </div>
  );
}

/**
 * Share the page: the phone's share sheet where there is one, else the link
 * copied with a word that it was. Inert in the editor preview.
 */
function ShareButton({ ctx }: { ctx: DesignCtx }) {
  const { theme, preview, data } = ctx;
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function share() {
    if (preview) return;
    const url = shareUrl(ctx, window.location.origin);
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title: data.name, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A closed share sheet or a refused clipboard: nothing to tell anyone.
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="mb-1 inline-flex min-h-11 items-center gap-2 px-4 text-xs font-medium"
      style={{ border: `1px solid ${theme.border}`, backgroundColor: theme.surface, color: theme.text, borderRadius: "9999px" }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
      </svg>
      <span aria-live="polite">{copied ? "Link copied" : "Share"}</span>
    </button>
  );
}

/** The menu as one list: each row books that service, with what it takes and costs. */
function Menu({ ctx, services }: { ctx: DesignCtx; services: PageService[] }) {
  const { theme, preview } = ctx;
  return (
    <ul className="overflow-hidden" style={ctx.surface}>
      {services.map((service, i) => {
        const href = bookPickedHref(ctx, { serviceId: service.id });
        const price = priceText(service.price);
        const body = (
          <>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {href && <span className="sr-only">Book </span>}
                {service.name}
              </p>
              <p className="mt-0.5 line-clamp-2 text-xs" style={{ color: theme.muted }}>
                {[durationText(service.durationMin), service.description?.trim()].filter(Boolean).join(" · ")}
              </p>
            </div>
            {price && <span className="shrink-0 text-sm font-semibold tabular-nums">{price}</span>}
            {href && <Chevron color={theme.muted} />}
          </>
        );
        return (
          <li key={service.id} style={i > 0 ? { borderTop: `1px solid ${theme.border}` } : undefined}>
            {href ? (
              <a
                href={preview ? undefined : href}
                onClick={preview ? (e) => e.preventDefault() : undefined}
                className="flex min-h-14 items-center gap-3 px-4 py-3"
              >
                {body}
              </a>
            ) : (
              <div className="flex min-h-14 items-center gap-3 px-4 py-3">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Everyone who takes bookings, each a way to book with them. */
function Team({ ctx, team }: { ctx: DesignCtx; team: PageStaff[] }) {
  const { theme, preview } = ctx;
  return (
    // Two people share the row; three or more go three across.
    <ul className={`grid gap-2 ${team.length === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
      {team.map((person) => {
        const href = bookPickedHref(ctx, { staffId: person.id });
        const face = person.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={person.imageUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
        ) : (
          <span
            aria-hidden
            className="grid h-16 w-16 place-items-center rounded-full text-xl font-bold"
            style={{ backgroundColor: theme.bg, color: theme.text, border: `1px solid ${theme.border}`, fontFamily: "var(--page-display)" }}
          >
            {person.name.trim().charAt(0).toUpperCase()}
          </span>
        );
        const body = (
          <>
            {face}
            <span className="mt-2 block w-full truncate text-center text-xs font-medium">
              {href && <span className="sr-only">Book with </span>}
              {person.name}
            </span>
          </>
        );
        const cell = "flex min-h-11 flex-col items-center px-2 py-3";
        return (
          <li key={person.id} style={ctx.surface}>
            {href ? (
              <a href={preview ? undefined : href} onClick={preview ? (e) => e.preventDefault() : undefined} className={cell}>
                {body}
              </a>
            ) : (
              <div className={cell}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A known client's way to their card, as a row. Left out inside an app build
 * whose Rewards tab holds the client's whole rewards, as every design does.
 */
function RewardsRow({ ctx }: { ctx: DesignCtx }) {
  const { theme, accent } = ctx;
  if (!ctx.rewardsHref || ctx.appRewardsTab) return null;
  return (
    <motion.div variants={fadeUp} className="mt-8">
      <a href={ctx.rewardsHref} className="flex min-h-14 items-center gap-3 px-4 py-3" style={ctx.surface}>
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
          style={{ backgroundColor: `${accent}1F`, color: accent }}
        >
          <StampMark />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{ctx.rewardsLabel}</span>
        <Chevron color={theme.muted} />
      </a>
    </motion.div>
  );
}

/**
 * Book, pinned to the bottom of the screen the whole way down, with the
 * lowest price beside it when the menu has one.
 */
function BookBar({ ctx, from }: { ctx: DesignCtx; from: number | null }) {
  const { theme, preview } = ctx;
  return (
    <div
      className="sticky bottom-0 z-20"
      style={{
        backgroundColor: theme.bg,
        borderTop: `1px solid ${theme.border}`,
        boxShadow: "0 -10px 30px -18px rgba(0,0,0,0.35)",
      }}
    >
      <div className="mx-auto flex w-full max-w-lg items-center gap-4 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        {from != null && (
          <div className="shrink-0 leading-tight">
            <p className="text-[11px] uppercase tracking-wide" style={{ color: theme.muted }}>
              From
            </p>
            <p className="text-lg font-semibold tabular-nums">{priceText(from)}</p>
          </div>
        )}
        <a
          href={preview ? undefined : ctx.bookHref ?? undefined}
          onClick={preview ? (e) => e.preventDefault() : undefined}
          data-tour="book-cta"
          className="block min-w-0 flex-1 py-3.5 text-center text-sm font-semibold"
          style={bookButtonStyle(ctx)}
        >
          Book an appointment
        </a>
      </div>
    </div>
  );
}

function Chevron({ color }: { color: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
