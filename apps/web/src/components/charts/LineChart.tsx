"use client";

import { useId, useState } from "react";

export interface LinePoint {
  label: string;
  value: number;
}

/**
 * Dependency-free single-series SVG line chart (no chart lib in this repo).
 *
 * Single series => NO legend; the `title` names the metric. 2px stroke, points
 * anchored to a baseline, a soft gradient fill under the line, month labels
 * along the x-axis, and a hover dot + tooltip (HTML/SVG charts are interactive
 * by default). Empty state when every value is 0.
 *
 * The SVG uses a fixed viewBox and scales to its container width; coordinates
 * are computed in viewBox units so nothing depends on the rendered pixel size.
 */
export function LineChart({
  title,
  points,
  stroke = "#D4AF37", // gold DEFAULT
  emptyLabel = "No data yet.",
  valueSuffix = "",
}: {
  title: string;
  points: LinePoint[];
  stroke?: string;
  emptyLabel?: string;
  valueSuffix?: string;
}) {
  const gid = useId().replace(/:/g, ""); // gradient id must be valid in url(#...)
  const [hover, setHover] = useState<number | null>(null);

  const hasData = points.some((p) => p.value > 0);
  const total = points.reduce((sum, p) => sum + p.value, 0);

  // viewBox space. Padding leaves room for the line's cap radius + fill.
  const W = 300;
  const H = 90;
  const padX = 6;
  const padY = 8;
  const max = Math.max(1, ...points.map((p) => p.value));
  const n = points.length;

  const x = (i: number) =>
    n <= 1 ? W / 2 : padX + (i / (n - 1)) * (W - padX * 2);
  const y = (v: number) => padY + (1 - v / max) * (H - padY * 2);

  const coords = points.map((p, i) => ({ cx: x(i), cy: y(p.value), ...p }));
  const linePath = coords.map((c) => `${c.cx},${c.cy}`).join(" ");
  // Area path: the line, then down to the baseline and back — for the fill.
  const areaPath =
    coords.length > 0
      ? `M ${coords[0]!.cx},${H - padY} L ${coords
          .map((c) => `${c.cx},${c.cy}`)
          .join(" L ")} L ${coords[coords.length - 1]!.cx},${H - padY} Z`
      : "";

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-xs uppercase tracking-wide text-muted">{title}</p>
        <p className="font-display text-sm text-offwhite">
          {total.toLocaleString()}
          {valueSuffix}
          <span className="ml-1 text-[10px] uppercase tracking-wide text-muted">
            total
          </span>
        </p>
      </div>

      {!hasData ? (
        <p className="flex h-[72px] items-center justify-center text-center text-xs text-muted">
          {emptyLabel}
        </p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-[72px] w-full overflow-visible"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${title}: ${total}${valueSuffix} total over ${n} months`}
          >
            <defs>
              <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>

            {areaPath && <path d={areaPath} fill={`url(#fill-${gid})`} />}

            <polyline
              points={linePath}
              fill="none"
              stroke={stroke}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />

            {/* Hover markers + hit areas. One wide invisible rect per point so the
                hit target is far bigger than the dot. */}
            {coords.map((c, i) => (
              <g key={c.label}>
                {hover === i && (
                  <circle
                    cx={c.cx}
                    cy={c.cy}
                    r={3.5}
                    fill={stroke}
                    stroke="#141416"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                <rect
                  x={c.cx - (W / n) / 2}
                  y={0}
                  width={W / n}
                  height={H}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                />
              </g>
            ))}
          </svg>

          {/* Tooltip (HTML, below the svg to avoid clipping) */}
          <div className="h-4">
            {hover !== null && (
              <p className="text-center text-[11px] text-muted">
                <span className="text-offwhite">{coords[hover]!.label}</span>{" "}
                — {coords[hover]!.value.toLocaleString()}
                {valueSuffix}
              </p>
            )}
          </div>

          {/* X-axis month labels */}
          <div className="flex justify-between">
            {points.map((p) => (
              <span
                key={p.label}
                className="text-[10px] uppercase tracking-wide text-muted"
              >
                {p.label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
