import { BUSINESS_TYPES } from "@chairback/config/businessTypes";
import type { PagePhoto } from "../page";

/**
 * EXAMPLE PHOTOS for the editor preview, while a shop has none of its own -
 * so an owner can see what a design does before uploading anything.
 *
 * 🔴 PREVIEW ONLY, the same rule as the example reviews: the live page never
 * shows a photo the shop didn't post as if it were their work. Every caller
 * gates on `preview` (photosToShow), and the page labels them as examples.
 *
 * A shop whose vertical isn't a barbershop gets plain placeholders: pictures of
 * one trade would be wrong for another.
 */
const LOOKS: PagePhoto[] = [
  { url: "/demo/looks/look-1.svg", caption: "Clean taper" },
  { url: "/demo/looks/look-3.svg", caption: "360 waves" },
  { url: "/demo/looks/look-4.svg", caption: "Hard part" },
  { url: "/demo/looks/look-5.svg", caption: "Sponge twists" },
  { url: "/demo/looks/look-2.svg", caption: "Low taper" },
  { url: "/demo/looks/look-7.svg", caption: "Frohawk" },
  { url: "/demo/looks/look-6.svg", caption: "Buzz" },
  { url: "/demo/looks/look-8.svg", caption: "Textured top" },
];

const PLACEHOLDERS: PagePhoto[] = [1, 2, 3, 4].map((n) => ({ url: `/demo/looks/neutral-${n}.svg` }));

export function examplePhotos(industry: string): PagePhoto[] {
  return industry === BUSINESS_TYPES.barber.id ? LOOKS : PLACEHOLDERS;
}

/**
 * The photos a design shows: the shop's own, or - in the editor preview only,
 * and only while it has none - labeled examples.
 */
export function photosToShow(data: { gallery: PagePhoto[]; industry: string }, preview: boolean): {
  photos: PagePhoto[];
  examples: boolean;
} {
  if (data.gallery.length > 0) return { photos: data.gallery, examples: false };
  if (preview) return { photos: examplePhotos(data.industry), examples: true };
  return { photos: [], examples: false };
}
