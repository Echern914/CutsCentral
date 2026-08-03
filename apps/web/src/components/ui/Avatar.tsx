import { cn } from "@/lib/cn";

/**
 * Round avatar with a generated initials fallback.
 *
 * Clients have no accounts (their magic link IS their auth) and no photo
 * column, so there is nothing to upload a picture from — the initials chip is
 * the real rendering for almost every client, not a placeholder waiting on
 * images. It does the job a photo does here: giving each row a stable, glanceable
 * identity. The tint is derived from the name, so the same person is always the
 * same color and a list of clients reads as distinct faces.
 */

const SIZES = {
  sm: "h-8 w-8 text-[11px]",
  md: "h-11 w-11 text-sm",
  lg: "h-20 w-20 text-xl",
} as const;

/**
 * Gold is the brand/action color, so it is deliberately absent here: an avatar
 * must never read as a button. These are muted, equal-weight tints that sit
 * back against the charcoal surface.
 */
const TINTS = [
  "bg-[#2E3A56] text-[#B6C6E8]",
  "bg-[#3A2E4A] text-[#CBB6E0]",
  "bg-[#25443C] text-[#A9D8C6]",
  "bg-[#4A362B] text-[#E0BFA0]",
  "bg-[#2B3F4A] text-[#A8CBDB]",
  "bg-[#46303A] text-[#E2B2C0]",
] as const;

/**
 * Initials from a display name: "Marcus Dean" -> "MD", "Cher" -> "C".
 * Spread-then-index rather than charAt so an emoji or accented glyph counts as
 * one character instead of splitting into half a surrogate pair.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const firstWord = words[0];
  if (!firstWord) return "?";
  const first = [...firstWord][0] ?? "";
  const lastWord = words.length > 1 ? words[words.length - 1] : undefined;
  const last = lastWord ? ([...lastWord][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Stable name -> tint index. Same name always lands on the same color. */
function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length] ?? TINTS[0];
}

export function Avatar({
  name,
  src,
  size = "md",
  className,
}: {
  name: string;
  /** Photo URL when one exists (barbers have one; clients don't). */
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const label = name.trim() || "Unknown";
  const base = cn(
    "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
    SIZES[size],
    className,
  );

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className={cn(base, "object-cover")}
        // Decorative: the name it stands for is always rendered next to it, so
        // announcing initials again would just be noise for a screen reader.
        aria-hidden
      />
    );
  }

  return (
    <span className={cn(base, tintFor(label))} aria-hidden>
      {initialsOf(label)}
    </span>
  );
}
