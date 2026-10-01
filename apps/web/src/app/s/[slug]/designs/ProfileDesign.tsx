"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { PrimaryCta, ShopFooter, TextToBookBlock } from "../pageChrome";
import type { PagePhoto, PageService } from "../page";
import { photosToShow } from "./examples";
import { bookPickedHref, durationText, priceText, sectionsBelow, servicePhotos, type DesignCtx } from "./model";
import {
  Chip,
  Coin,
  DesignFrame,
  ExamplesNote,
  PhotoTile,
  RatingLine,
  RewardsPill,
  WaitlistBlock,
  photoLabel,
  useViewer,
} from "./parts";

type Tab = "work" | "services" | "reviews" | "info";

/**
 * PROFILE. A proper profile page: a short banner, the shop's coin with quick
 * Text and Instagram buttons, Book, then tabs - Work (filterable by who did
 * it), Services, Reviews and Info. A tab with nothing in it isn't offered, and
 * the page opens on the first one that has something.
 */
export function ProfileDesign({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, layout, accent, preview } = ctx;
  const { photos, examples } = photosToShow(data, preview);
  const viewer = useViewer(ctx, examples);
  const services = data.services ?? [];
  const showsReviews = ctx.order.includes("reviews");

  const tabs: { key: Tab; label: string }[] = [
    ...(photos.length > 0 ? [{ key: "work" as const, label: "Work" }] : []),
    ...(services.length > 0 ? [{ key: "services" as const, label: "Services" }] : []),
    ...(showsReviews ? [{ key: "reviews" as const, label: "Reviews" }] : []),
    { key: "info" as const, label: "Info" },
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]!.key);
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0]!.key;

  // Filter the work by who did it - offered once at least two people have photos.
  const people = (data.staff ?? []).filter((s) => photos.some((p) => p.staffId === s.id));
  const [who, setWho] = useState<string | null>(null);
  const shown = who ? photos.filter((p) => p.staffId === who) : photos;

  const roundLink = {
    border: `1px solid ${theme.border}`,
    color: theme.text,
    borderRadius: "9999px",
  };

  return (
    <DesignFrame ctx={ctx} after={viewer.node}>
      <motion.header variants={fadeUp} className="relative" data-tour="hero">
        {data.heroImageUrl ? (
          <div className="relative -mx-5 h-32 overflow-hidden">
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
            className="-mx-5 h-24"
            style={{ background: `radial-gradient(420px 180px at 20% 0%, ${accent}26, transparent 70%)` }}
            aria-hidden
          />
        )}
        <div className="relative -mt-9 flex items-end justify-between gap-3">
          <Coin ctx={ctx} size={76} />
          <div className="flex gap-2 pb-1">
            {data.receptionistNumber && (
              <a
                href={preview ? undefined : `sms:${data.receptionistNumber}`}
                onClick={preview ? (e) => e.preventDefault() : undefined}
                aria-label={`Text ${data.name}`}
                className="grid h-11 w-11 place-items-center"
                style={roundLink}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
                </svg>
              </a>
            )}
            {data.instagramHandle && (
              <a
                href={preview ? undefined : `https://instagram.com/${data.instagramHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={preview ? (e) => e.preventDefault() : undefined}
                aria-label={`${data.name} on Instagram`}
                className="grid h-11 w-11 place-items-center"
                style={roundLink}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="3" width="18" height="18" rx="5" />
                  <circle cx="12" cy="12" r="4" />
                  <circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" />
                </svg>
              </a>
            )}
          </div>
        </div>
        <h1 className="mt-3 text-3xl leading-none tracking-tight" style={{ fontFamily: "var(--page-display)" }}>
          {data.name}
        </h1>
        <RatingLine ctx={ctx} className="mt-2" />
        {data.bio && (
          <p className="mt-2 text-sm" style={{ color: theme.muted }}>
            {data.bio}
          </p>
        )}
      </motion.header>

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

      {active === "work" && people.length >= 2 && (
        <div className="-mx-5 mt-5 flex gap-2 overflow-x-auto px-5 pb-1" role="group" aria-label="Whose work">
          <Chip ctx={ctx} active={who === null} onClick={() => setWho(null)}>
            Everyone
          </Chip>
          {people.map((person) => (
            <Chip key={person.id} ctx={ctx} person={person} active={who === person.id} onClick={() => setWho(person.id)}>
              {person.name}
            </Chip>
          ))}
        </div>
      )}

      <div
        role="tablist"
        aria-label={`${data.name} sections`}
        className="-mx-5 mt-5 flex px-5"
        style={{ borderBottom: `1px solid ${theme.border}` }}
      >
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={on}
              aria-controls={`panel-${t.key}`}
              onClick={() => setTab(t.key)}
              className="min-h-11 flex-1 text-sm"
              style={{
                color: on ? theme.text : theme.muted,
                fontWeight: on ? 600 : 500,
                borderBottom: `2px solid ${on ? accent : "transparent"}`,
                marginBottom: -1,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`} className="pt-4">
        {active === "work" && (
          <>
            {examples && <ExamplesNote ctx={ctx} />}
            <Wall ctx={ctx} photos={shown} onOpen={(i) => viewer.show(shown, i)} />
          </>
        )}
        {active === "services" && (
          <ServiceList ctx={ctx} services={services} photos={examples ? [] : photos} onOpen={viewer.show} />
        )}
        {active === "reviews" && ctx.sections.reviews}
        {active === "info" && <Info ctx={ctx} />}
      </div>

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

/** Two columns of photos, alternating tall and square so it reads as a wall, not a table. */
function Wall({ ctx, photos, onOpen }: { ctx: DesignCtx; photos: PagePhoto[]; onOpen: (index: number) => void }) {
  const columns: { photo: PagePhoto; index: number }[][] = [[], []];
  photos.forEach((photo, index) => columns[index % 2]!.push({ photo, index }));
  return (
    <div className="flex gap-2">
      {columns.map((column, c) => (
        <div key={c} className="flex flex-1 flex-col gap-2">
          {column.map(({ photo, index }, row) => {
            const tall = (row + c) % 2 === 0;
            return (
              <PhotoTile
                key={`${photo.url}-${index}`}
                photo={photo}
                label={photoLabel(ctx, photo, index)}
                onOpen={() => onOpen(index)}
                className={tall ? "h-56 w-full" : "aspect-square w-full"}
                style={{ borderRadius: ctx.layout.radius }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ServiceList({
  ctx,
  services,
  photos,
  onOpen,
}: {
  ctx: DesignCtx;
  services: PageService[];
  photos: PagePhoto[];
  onOpen: (photos: PagePhoto[], index: number) => void;
}) {
  const { theme, layout, accent, preview } = ctx;
  return (
    <div className="overflow-hidden" style={ctx.surface}>
      {services.map((service, i) => {
        const shots = servicePhotos(service, photos);
        const href = bookPickedHref(ctx, { serviceId: service.id });
        const price = priceText(service.price);
        return (
          <div
            key={service.id}
            className="flex items-center gap-3 px-4 py-3"
            style={i > 0 ? { borderTop: `1px solid ${theme.border}` } : undefined}
          >
            {shots[0] && (
              <PhotoTile
                photo={shots[0]}
                label={`${service.name} photos`}
                onOpen={() => onOpen(shots, 0)}
                className="h-14 w-14 shrink-0"
                style={{ borderRadius: `calc(${layout.radius} * 0.6)` }}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{service.name}</p>
              <p className="mt-0.5 text-xs" style={{ color: theme.muted }}>
                {[durationText(service.durationMin), price].filter(Boolean).join(" · ")}
              </p>
            </div>
            {href && (
              <a
                href={preview ? undefined : href}
                onClick={preview ? (e) => e.preventDefault() : undefined}
                aria-label={`Book ${service.name}`}
                className="inline-flex min-h-11 shrink-0 items-center px-4 text-sm font-semibold"
                style={{ border: `1px solid ${accent}`, color: accent, borderRadius: layout.buttonRadius }}
              >
                Book
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Hours, where, deals, the rewards menu - the shop's own section order - then the text line and the waitlist. */
function Info({ ctx }: { ctx: DesignCtx }) {
  const { data, theme, accent } = ctx;
  const where = [data.addressStreet, [data.addressCity, data.addressRegion].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join("\n");
  const below = sectionsBelow(ctx, ["gallery", "reviews"]);
  return (
    <div className="-mt-4">
      {below}
      {where && (
        <section className="mt-8">
          <h2 className="mb-3 px-1 text-xs font-medium uppercase tracking-[0.18em]" style={{ color: theme.muted }}>
            Where
          </h2>
          <p className="whitespace-pre-line p-5 text-sm" style={ctx.surface}>
            {where}
          </p>
        </section>
      )}
      <TextToBookBlock data={data} accent={accent} theme={theme} className="mt-8" />
      <WaitlistBlock ctx={ctx} />
    </div>
  );
}
