/**
 * Infinite horizontal marquee of capability chips. Pure CSS animation
 * (keyframes in globals.css), edge-faded with a mask, paused for
 * prefers-reduced-motion.
 */
export function Marquee({ items }: { items: readonly string[] }) {
  // Track is duplicated so translateX(-50%) loops seamlessly.
  const row = [...items, ...items];
  return (
    <div className="marquee-mask relative overflow-hidden py-1" aria-hidden>
      <div className="marquee-track flex w-max items-center gap-3 pr-3">
        {row.map((t, i) => (
          <span
            key={i}
            className="whitespace-nowrap rounded-full border border-subtle bg-charcoal-800/70 px-4 py-2 text-xs text-muted"
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
