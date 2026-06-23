"use client";

import { useEffect, useState } from "react";

/**
 * Hydration-safe local date. Server HTML and the client's first render both use
 * a deterministic en-US/UTC format (identical strings, so React never sees a
 * mismatch); after mount it re-renders in the visitor's own locale + timezone.
 */
export function LocalDate({
  iso,
  options,
  className,
  style,
}: {
  iso: string;
  options?: Intl.DateTimeFormatOptions;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [text, setText] = useState(() =>
    new Date(iso).toLocaleDateString("en-US", { ...options, timeZone: "UTC" }),
  );
  useEffect(() => {
    setText(new Date(iso).toLocaleDateString(undefined, options));
    // options is a fresh object each render; serializing it would re-run for
    // nothing. The format only meaningfully depends on the date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso]);
  return (
    <time dateTime={iso} className={className} style={style}>
      {text}
    </time>
  );
}
