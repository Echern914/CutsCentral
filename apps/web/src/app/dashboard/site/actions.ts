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

export async function savePageAction(
  input: PageSettingsInput,
): Promise<SavePageResult> {
  const res = await apiSend("PATCH", "/api/shops/me", {
    slug: input.slug,
    publicPageEnabled: input.publicPageEnabled,
    theme: input.theme,
    bio: input.bio,
    logoUrl: input.logoUrl,
    accentColor: input.accentColor,
    heroImageUrl: input.heroImageUrl,
    instagramHandle: input.instagramHandle,
    hoursText: input.hoursText,
    gallery: input.gallery,
    fontKey: input.fontKey,
    layoutStyle: input.layoutStyle,
    sectionOrder: input.sectionOrder,
    rewardsWelcome: input.rewardsWelcome,
    rewardsSections: input.rewardsSections,
    takesRequests: input.takesRequests,
    waitlistEnabled: input.waitlistEnabled,
    notifyPhone: input.notifyPhone,
  });
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
