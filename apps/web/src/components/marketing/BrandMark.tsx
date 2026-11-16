import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";

/** The ChairBack mark: the scissors glyph the marketing pages have always used. */
export function ScissorsMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.12 8.12 20 20M14.47 14.48 20 4M8.12 15.88 12 12" />
    </svg>
  );
}

/**
 * The mark in its ink tile, beside the name, linking home. One lockup for the
 * site header and footer so the two can never drift apart.
 */
export function BrandLockup({ size = "md" }: { size?: "md" | "sm" }) {
  const tile = size === "md" ? "h-8 w-8 rounded-[9px]" : "h-7 w-7 rounded-lg";
  return (
    <Link
      href="/"
      className="inline-flex min-h-[44px] items-center gap-2.5 text-offwhite"
    >
      <span
        className={`${tile} flex shrink-0 items-center justify-center bg-primary text-on-primary`}
      >
        <ScissorsMark className="h-4 w-4" />
      </span>
      <span
        className={`font-display ${size === "md" ? "text-xl" : "text-lg"} tracking-tight`}
      >
        {APP_NAME}
      </span>
    </Link>
  );
}
