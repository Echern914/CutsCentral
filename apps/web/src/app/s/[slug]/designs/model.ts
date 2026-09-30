import type { CSSProperties } from "react";
import type { PageSectionKey } from "@chairback/config/constants";
import type { Layout, Theme } from "../pageSections";
import type { PagePhoto, PageService, PageStaff, ShopPageData } from "../page";

/**
 * Everything ShopPageClient works out once - theme, booking destination, the
 * rendered sections - handed to whichever design the shop picked, so no design
 * can disagree with another (or with classic) about where Book goes.
 */
export interface DesignCtx {
  data: ShopPageData;
  preview: boolean;
  /** useIsNativeApp: null until known, read as "not in the app" - as classic does. */
  inApp: boolean | null;
  /** Clock-relative words ("2 days ago") wait for this: hydration safety. */
  mounted: boolean;
  theme: Theme;
  accent: string;
  layout: Layout;
  surface: CSSProperties;
  rootStyle: CSSProperties;
  /** Where Book goes, or null when the shop has no booking destination. */
  bookHref: string | null;
  bookIsNative: boolean;
  hasBooking: boolean;
  showRequestForm: boolean;
  bookQuery?: string;
  rewardsHref?: string;
  rewardsLabel: string;
  /** The movable sections, rendered - a design shows the ones below its own top. */
  sections: Record<PageSectionKey, React.ReactNode>;
  /** The shop's section order (which also hides the ones left out). */
  order: PageSectionKey[];
}

// ---------------------------------------------------------------------------
// Booking links
// ---------------------------------------------------------------------------

/**
 * Booking with this service (and who did it) already picked. A prefill, never
 * a permission: the booking page validates both ids against what the shop
 * offers and ignores anything else (book/[slug]/page.tsx). An outside booking
 * site can't take our ids, so it gets its own link as it is; a custom-domain
 * visit keeps its same-shop marker.
 */
export function bookPickedHref(
  ctx: Pick<DesignCtx, "bookHref" | "bookIsNative" | "bookQuery" | "data">,
  pick: { serviceId?: string; staffId?: string },
): string | null {
  if (!ctx.bookHref) return null;
  if (!ctx.bookIsNative) return ctx.bookHref;
  const query = new URLSearchParams(ctx.bookQuery?.replace(/^\?/, "") ?? "");
  if (pick.serviceId) query.set("service", pick.serviceId);
  if (pick.staffId) query.set("staff", pick.staffId);
  const q = query.toString();
  return `/book/${ctx.data.slug}${q ? `?${q}` : ""}`;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export function priceText(price: number | null | undefined): string | null {
  if (price == null) return null;
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

export function durationText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** When a photo went up, as a person says it: "Today", "3 days ago", then the date. */
export function addedLabel(addedAt: string | undefined, now: Date): string | null {
  if (!addedAt) return null;
  const at = new Date(addedAt);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 28) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export function serviceOf(data: ShopPageData, photo: PagePhoto): PageService | null {
  return (photo.serviceId && data.services?.find((s) => s.id === photo.serviceId)) || null;
}

export function staffOf(data: ShopPageData, photo: PagePhoto): PageStaff | null {
  return (photo.staffId && data.staff?.find((s) => s.id === photo.staffId)) || null;
}

/** A photo's title: its caption, else the name of the service it shows. */
export function photoTitle(data: ShopPageData, photo: PagePhoto): string | null {
  return photo.caption?.trim() || serviceOf(data, photo)?.name || null;
}

/** What a photo is, in one line: "Haircut · 30 min · $35 · by Marcus". */
export function photoMeta(data: ShopPageData, photo: PagePhoto): string | null {
  const service = serviceOf(data, photo);
  const staff = staffOf(data, photo);
  const parts: string[] = [];
  if (service) {
    parts.push(service.name, durationText(service.durationMin));
    const price = priceText(service.price);
    if (price) parts.push(price);
  }
  if (staff) parts.push(`by ${staff.name}`);
  return parts.length ? parts.join(" · ") : null;
}

/** One service's photos: the service's own picture first, then the gallery's photos of it. */
export function servicePhotos(service: PageService, photos: PagePhoto[]): PagePhoto[] {
  const tagged = photos.filter((p) => p.serviceId === service.id);
  const own =
    service.imageUrl && !tagged.some((p) => p.url === service.imageUrl)
      ? [{ url: service.imageUrl, serviceId: service.id }]
      : [];
  return [...own, ...tagged];
}

const dated = (p: PagePhoto) => Boolean(p.addedAt && !Number.isNaN(Date.parse(p.addedAt)));

/**
 * Newest work first: dated photos newest to oldest, then the undated ones
 * (added before dates existed) in the order the owner arranged them.
 */
export function newestFirst(photos: PagePhoto[]): PagePhoto[] {
  const withDates = photos.filter(dated).sort((a, b) => Date.parse(b.addedAt!) - Date.parse(a.addedAt!));
  return [...withDates, ...photos.filter((p) => !dated(p))];
}

export type Review = ShopPageData["reviews"][number];

export type FeedItem =
  | { kind: "photo"; photo: PagePhoto; index: number }
  | { kind: "review"; review: Review };

/**
 * The Fresh feed: the photos in the order given, a written review after every
 * `every` photos, and any reviews still unshown after the last photo (up to
 * `maxReviews` in all). `index` is the photo's place in `photos`, for the viewer.
 */
export function feedWithReviews(photos: PagePhoto[], reviews: Review[], every = 2, maxReviews = 6): FeedItem[] {
  const words = reviews.filter((r) => r.body?.trim()).slice(0, maxReviews);
  const items: FeedItem[] = [];
  let next = 0;
  photos.forEach((photo, index) => {
    items.push({ kind: "photo", photo, index });
    if ((index + 1) % every === 0 && next < words.length) items.push({ kind: "review", review: words[next++]! });
  });
  while (next < words.length) items.push({ kind: "review", review: words[next++]! });
  return items;
}

/** The sections a design shows below its own top, in the shop's order. */
export function sectionsBelow(ctx: Pick<DesignCtx, "order" | "sections">, leaveOut: PageSectionKey[]): React.ReactNode[] {
  return ctx.order.filter((k) => !leaveOut.includes(k)).map((k) => ctx.sections[k]);
}

/** A shop's monogram for a coin with no logo: "Fade District" -> "FD". */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}
