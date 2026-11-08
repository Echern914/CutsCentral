/**
 * "How did you hear about us?", asked once when an owner sets up their business
 * and counted on /admin. The ids are pinned by Shop_heardAbout_check, so adding
 * one here needs a migration as well.
 */
export const HEARD_ABOUT_IDS = [
  "another_barber",
  "instagram",
  "tiktok",
  "google",
  "friend_family",
  "other",
] as const;

export type HeardAboutId = (typeof HEARD_ABOUT_IDS)[number];

export function isHeardAboutId(value: unknown): value is HeardAboutId {
  return typeof value === "string" && (HEARD_ABOUT_IDS as readonly string[]).includes(value);
}

/**
 * The words for an answer. `another_barber` says the person's own trade, because
 * this form is also filled in by nail techs and detailers. The id keeps its name
 * because it is stored.
 */
export function heardAboutLabel(id: HeardAboutId, providerNoun = "pro"): string {
  switch (id) {
    case "another_barber":
      return `Another ${providerNoun}`;
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "google":
      return "Google";
    case "friend_family":
      return "Friend or family";
    case "other":
      return "Other";
  }
}
