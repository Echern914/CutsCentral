/**
 * The shop's mark in the dashboard chrome: its initials on an ink square, the
 * way an app icon reads. Plain markup with no hooks, so the server layout (top
 * bar) and the client sidebar both render it.
 */

/** Two letters from a name: "Fade District" → "FD". Empty when there is no name. */
export function initials(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function ShopMark({ name }: { name: string | null }) {
  const letters = initials(name);
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-[11px] font-semibold text-on-primary"
    >
      {letters || (
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M8.12 8.12 20 20M14.47 14.48 20 4M8.12 15.88 12 12" />
        </svg>
      )}
    </span>
  );
}
