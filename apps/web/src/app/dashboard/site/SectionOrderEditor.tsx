"use client";

import { useState, type DragEvent } from "react";
import {
  DEFAULT_SECTION_ORDER,
  PAGE_SECTIONS,
  PAGE_SECTION_KEYS,
  type PageSectionKey,
} from "@chairback/config/constants";
import { cn } from "@/lib/cn";

/**
 * Choose which page sections show and in what order. `value` is the ordered list
 * of VISIBLE section keys; anything not in the list is hidden. Drag rows to
 * reorder; toggle the switch to show/hide. Hidden sections sink to the bottom.
 */
export function SectionOrderEditor({
  value,
  onChange,
}: {
  value: PageSectionKey[];
  onChange: (next: PageSectionKey[]) => void;
}) {
  const [dragKey, setDragKey] = useState<PageSectionKey | null>(null);
  const [overKey, setOverKey] = useState<PageSectionKey | null>(null);

  const visible = (value.length ? value : DEFAULT_SECTION_ORDER).filter(
    (k): k is PageSectionKey => PAGE_SECTION_KEYS.includes(k as PageSectionKey),
  );
  const hidden = PAGE_SECTION_KEYS.filter((k) => !visible.includes(k));
  // Render visible (draggable) first, then hidden (greyed, at the bottom).
  const rows = [...visible, ...hidden];

  function toggle(key: PageSectionKey) {
    onChange(visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key]);
  }

  function onDrop(target: PageSectionKey) {
    if (!dragKey || dragKey === target || !visible.includes(target)) {
      setDragKey(null);
      setOverKey(null);
      return;
    }
    const next = [...visible];
    const from = next.indexOf(dragKey);
    const to = next.indexOf(target);
    if (from !== -1 && to !== -1) {
      next.splice(from, 1);
      next.splice(to, 0, dragKey);
      onChange(next);
    }
    setDragKey(null);
    setOverKey(null);
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((key) => {
        const isVisible = visible.includes(key);
        const section = PAGE_SECTIONS[key];
        return (
          <div
            key={key}
            draggable={isVisible}
            onDragStart={() => isVisible && setDragKey(key)}
            onDragOver={(e: DragEvent) => {
              if (dragKey && isVisible) {
                e.preventDefault();
                setOverKey(key);
              }
            }}
            onDrop={() => onDrop(key)}
            onDragEnd={() => {
              setDragKey(null);
              setOverKey(null);
            }}
            className={cn(
              "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 transition-[border-color,background-color,box-shadow,opacity] duration-150 ease-out",
              isVisible ? "cursor-grab border-subtle bg-charcoal-700 active:cursor-grabbing" : "border-subtle/60 opacity-55",
              overKey === key && dragKey ? "border-gold/70 ring-2 ring-gold/40" : "",
            )}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className={cn("text-muted", !isVisible && "opacity-0")} aria-hidden>
                ⋮⋮
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm text-offwhite">{section.label}</p>
                <p className="truncate text-[11px] text-muted">{section.hint}</p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isVisible}
              onClick={() => toggle(key)}
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 ease-out",
                isVisible ? "bg-emerald-soft/70" : "bg-charcoal-600",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform duration-150 ease-out",
                  isVisible ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}
