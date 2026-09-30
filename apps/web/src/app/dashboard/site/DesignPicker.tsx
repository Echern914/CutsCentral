"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  PAGE_DESIGNS,
  PAGE_DESIGN_KEYS,
  PAGE_THEMES,
  type PageDesignKey,
  type PageThemeKey,
} from "@chairback/config/constants";
import { cn } from "@/lib/cn";

type Tokens = (typeof PAGE_THEMES)[PageThemeKey];

/**
 * The page-design picker: one tile per design, each with a sketch of its
 * layout drawn in the shop's own theme colors, so the choice is visual before
 * the preview even updates. Classic - the page every shop already has - is
 * first. Picking one only changes the form; nothing saves until Save.
 */
export function DesignPicker({
  value,
  onChange,
  theme,
  accent,
}: {
  value: PageDesignKey;
  onChange: (next: PageDesignKey) => void;
  theme: Tokens;
  accent: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="group" aria-label="Page design">
      {PAGE_DESIGN_KEYS.map((key) => {
        const d = PAGE_DESIGNS[key];
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={cn(
              "flex flex-col gap-2 rounded-2xl border p-2.5 text-left transition-[border-color,box-shadow] duration-150 ease-out",
              active ? "border-gold/60 shadow-glow-sm" : "border-subtle hover:border-subtle-strong",
            )}
          >
            <div className="h-28 overflow-hidden rounded-xl" style={{ backgroundColor: theme.bg }} aria-hidden>
              <Sketch design={key} t={theme} accent={accent} />
            </div>
            <div className="px-0.5">
              <p className="text-xs font-medium text-offwhite">{d.label}</p>
              <p className="mt-0.5 text-[10px] leading-snug text-muted">{d.hint}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** A few blocks that read as the layout at thumbnail size. */
function Sketch({ design, t, accent }: { design: PageDesignKey; t: Tokens; accent: string }) {
  const photo: CSSProperties = { background: `linear-gradient(160deg, ${accent}66, ${t.surface})` };
  const surface: CSSProperties = { backgroundColor: t.surface, border: `1px solid ${t.border}` };
  const line = (w: string, color: string = t.muted): ReactNode => (
    <div className="h-1 rounded-full" style={{ width: w, backgroundColor: color, opacity: 0.7 }} />
  );
  const book = <div className="h-2 rounded-full" style={{ backgroundColor: accent }} />;
  const coin = (cls = "") => <div className={`h-3.5 w-3.5 rounded ${cls}`} style={surface} />;

  switch (design) {
    case "classic":
      return (
        <div className="flex h-full flex-col gap-1 p-2">
          <div className="h-5 rounded" style={photo} />
          <div className="-mt-2.5 flex justify-center">{coin()}</div>
          <div className="flex justify-center">{line("40%", t.text)}</div>
          {book}
          <div className="h-2 rounded-full" style={surface} />
          <div className="h-2 rounded-full" style={surface} />
          <div className="flex-1 rounded" style={surface} />
        </div>
      );
    case "grid":
      return (
        <div className="flex h-full flex-col gap-1 p-2">
          <div className="h-4 rounded" style={photo} />
          <div className="-mt-2 flex justify-center">{coin()}</div>
          {book}
          <div className="grid flex-1 grid-cols-3 gap-0.5">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="rounded-sm" style={photo} />
            ))}
          </div>
        </div>
      );
    case "lookbook":
      return (
        <div className="flex h-full flex-col gap-1 p-2">
          <div className="flex items-center gap-1">
            {coin()}
            {line("40%", t.text)}
          </div>
          {book}
          {[0, 1].map((r) => (
            <div key={r} className="flex flex-1 flex-col gap-0.5 rounded p-0.5" style={surface}>
              <div className="flex flex-1 gap-0.5">
                <div className="flex-1 rounded-sm" style={photo} />
                <div className="flex-1 rounded-sm" style={photo} />
                <div className="w-1/5 rounded-sm" style={photo} />
              </div>
              {line("50%", t.text)}
            </div>
          ))}
        </div>
      );
    case "reel":
      return (
        <div className="relative h-full">
          <div className="absolute inset-0" style={photo} />
          <div className="absolute inset-x-2 top-1.5 flex gap-0.5">
            {[1, 0.4, 0.4, 0.4].map((o, i) => (
              <div key={i} className="h-0.5 flex-1 rounded-full" style={{ backgroundColor: t.text, opacity: o }} />
            ))}
          </div>
          <div className="absolute inset-x-2 bottom-6 flex items-center gap-1">
            {coin()}
            {line("45%", t.text)}
          </div>
          <div className="absolute inset-x-2 bottom-2">{book}</div>
        </div>
      );
    case "profile":
      return (
        <div className="flex h-full flex-col gap-1 p-2">
          <div className="h-3 rounded" style={photo} />
          <div className="-mt-2">{coin()}</div>
          {book}
          <div className="flex gap-1">
            <div className="h-0.5 flex-1 rounded-full" style={{ backgroundColor: accent }} />
            <div className="h-0.5 flex-1 rounded-full" style={{ backgroundColor: t.border }} />
            <div className="h-0.5 flex-1 rounded-full" style={{ backgroundColor: t.border }} />
          </div>
          <div className="flex flex-1 gap-0.5">
            <div className="flex flex-1 flex-col gap-0.5">
              <div className="flex-[3] rounded-sm" style={photo} />
              <div className="flex-[2] rounded-sm" style={photo} />
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              <div className="flex-[2] rounded-sm" style={photo} />
              <div className="flex-[3] rounded-sm" style={photo} />
            </div>
          </div>
        </div>
      );
    case "fresh":
      return (
        <div className="flex h-full flex-col gap-1 p-2">
          <div className="flex items-center gap-1">
            {coin()}
            {line("40%", t.text)}
          </div>
          {book}
          <div className="flex-1 rounded" style={photo} />
          {line("70%")}
          <div className="h-3 rounded" style={surface} />
        </div>
      );
  }
}
