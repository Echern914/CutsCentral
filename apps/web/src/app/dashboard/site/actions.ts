"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";
import { SHOP_NAME_EMPTY, SHOP_NAME_TOO_LONG } from "./shopName";

export interface PageSettingsInput {
  /** The shop's name: the heading of the booking page and the shop page. Never re-slugs. */
  name: string;
  slug: string;
  publicPageEnabled: boolean;
  theme: string;
  pageDesign: string;
  bio: string;
  logoUrl: string;
  accentColor: string;
  heroImageUrl: string;
  instagramHandle: string;
  googleReviewUrl: string;
  hoursText: string;
  addressStreet: string;
  addressCity: string;
  addressRegion: string;
  addressPostal: string;
  addressPrivate: boolean;
  // What each photo shows and who did it. No date: the API dates photos itself.
  gallery: { url: string; caption?: string; serviceId?: string; staffId?: string }[];
  fontKey: string;
  layoutStyle: string;
  sectionOrder: string[];
  rewardsWelcome: string;
  rewardsSections: string[];
  takesRequests: boolean;
  waitlistEnabled: boolean;
  notifyPhone: string;
}

export interface SavePageResult {
  ok: boolean;
  /** General failure line (network, unknown error). */
  error?: string;
  /** Per-field messages keyed by PageSettingsInput field name. */
  fieldErrors?: Record<string, string>;
}

/**
 * Whitelist of PATCHable page fields. Server actions are network-callable, so
 * the body is rebuilt from this list — extra keys in `input` never reach the
 * API — and only the keys the caller PROVIDED are forwarded: the editor
 * diff-saves (changed fields only), so a form seeded from stale props can no
 * longer clobber fields the barber never touched (the #142 bug class).
 */
const PAGE_FIELDS = [
  "name",
  "slug",
  "publicPageEnabled",
  "theme",
  "pageDesign",
  "bio",
  "logoUrl",
  "accentColor",
  "heroImageUrl",
  "instagramHandle",
  "googleReviewUrl",
  "hoursText",
  "addressStreet",
  "addressCity",
  "addressRegion",
  "addressPostal",
  "addressPrivate",
  "gallery",
  "fontKey",
  "layoutStyle",
  "sectionOrder",
  "rewardsWelcome",
  "rewardsSections",
  "takesRequests",
  "waitlistEnabled",
  "notifyPhone",
] as const satisfies readonly (keyof PageSettingsInput)[];

export async function savePageAction(
  input: Partial<PageSettingsInput>,
): Promise<SavePageResult> {
  const body: Record<string, unknown> = {};
  for (const key of PAGE_FIELDS) {
    if (key in input && input[key] !== undefined) body[key] = input[key];
  }
  const res = await apiSend<{ slug?: string | null }>("PATCH", "/api/shops/me", body);
  revalidatePath("/dashboard/site");
  if (res.ok) {
    // A new name shows everywhere at once: the dashboard header and shop
    // switcher read it in the layout, and the public pages are cached for a
    // minute, so refresh those too rather than leave the old name up.
    if ("name" in body) revalidatePath("/dashboard", "layout");
    const slug = res.data?.slug;
    if (slug) {
      revalidatePath(`/s/${slug}`);
      revalidatePath(`/book/${slug}`);
    }
    return { ok: true };
  }
  if (res.error === "forbidden_role") {
    return { ok: false, error: "Only the shop owner or a manager can change the page. Ask the shop owner." };
  }
  if (res.error === "slug_taken") {
    return {
      ok: false,
      fieldErrors: { slug: "That page handle is taken. Try another." },
    };
  }
  if (res.error === "invalid_phone") {
    return {
      ok: false,
      fieldErrors: {
        notifyPhone:
          "That number doesn't look valid. Use a US number like (302) 555-0142.",
      },
    };
  }
  // Zod rejections carry the real offending field + an already-human message
  // ("Use a hex color like #D4AF37") — surface those instead of a generic line.
  if (res.error === "invalid_input" && res.issues?.length) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of res.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !(key in fieldErrors)) {
        // The name's rule is zod's bare min/max, whose wording is not for
        // people: say it the way the Settings card does.
        fieldErrors[key] =
          key === "name"
            ? (issue as { code?: string }).code === "too_big"
              ? SHOP_NAME_TOO_LONG
              : SHOP_NAME_EMPTY
            : issue.message;
      }
    }
    if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  }
  return { ok: false, error: "Could not save — check your connection and try again." };
}
