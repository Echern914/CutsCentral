"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export interface PageSettingsInput {
  slug: string;
  publicPageEnabled: boolean;
  theme: string;
  bio: string;
  logoUrl: string;
  accentColor: string;
  heroImageUrl: string;
  instagramHandle: string;
  hoursText: string;
  gallery: { url: string; caption?: string }[];
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
  "slug",
  "publicPageEnabled",
  "theme",
  "bio",
  "logoUrl",
  "accentColor",
  "heroImageUrl",
  "instagramHandle",
  "hoursText",
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
  const res = await apiSend("PATCH", "/api/shops/me", body);
  revalidatePath("/dashboard/site");
  if (res.ok) return { ok: true };
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
        fieldErrors[key] = issue.message;
      }
    }
    if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  }
  return { ok: false, error: "Could not save — check your connection and try again." };
}
