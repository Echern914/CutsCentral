"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { cn } from "@/lib/cn";

/**
 * WHOSE CALENDAR: one chip per person, and "Everyone".
 *
 * A shop with several people working it shared one calendar that could not be
 * narrowed to one of them. Tapping a name shows that person's bookings, their
 * blocked time and their open time, in the day, the week and the month alike
 * (BookingCalendar applies it once, above all three). Tapping it again, or
 * "Everyone", goes back.
 *
 * 🔴 Renders NOTHING for a shop with one active person: `people` arrives empty
 * (tellableChairs), and a solo calendar must look exactly as it did.
 */
export function ChairFilter({
  people,
  value,
  onChange,
}: {
  people: { id: string; name: string }[];
  /** The picked person's id, or null for everyone. */
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const vocab = useVocab();
  if (people.length < 2) return null;
  return (
    <div
      // It scrolls sideways itself, so a drag here is not a day swipe.
      data-noswipe
      data-qa="chair-filter"
      role="group"
      aria-label={`Show one ${vocab.providerNoun}`}
      className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1"
    >
      <Chip label="Everyone" active={value === null} onClick={() => onChange(null)} />
      {people.map((c) => (
        <Chip
          key={c.id}
          label={c.name || cap(vocab.providerNoun)}
          active={value === c.id}
          onClick={() => onChange(value === c.id ? null : c.id)}
        />
      ))}
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // 36px tall with the row's own padding around it: a thumb target on a
        // phone without making the strip taller than the pager above it.
        "max-w-[11rem] shrink-0 truncate rounded-full border px-3.5 py-2 text-xs font-medium transition-colors duration-150 ease-out",
        active
          ? "border-gold/50 bg-gold/15 text-gold"
          : "border-subtle text-muted hover:border-gold/40 hover:text-offwhite",
      )}
    >
      {label}
    </button>
  );
}
