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
  galleryUrls: string[];
}

export async function savePageAction(
  input: PageSettingsInput,
): Promise<{ ok: boolean; error?: string }> {
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
    galleryUrls: input.galleryUrls,
  });
  revalidatePath("/dashboard/site");
  if (res.ok) return { ok: true };
  return {
    ok: false,
    error:
      res.error === "slug_taken"
        ? "That page handle is taken — try another."
        : "Could not save. Check the fields (URLs must start with https://).",
  };
}
