"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";

// The Calendar's own hours sheet, fetched when a "Set hours" is tapped: it
// lives in the Calendar's (large) module, and a new shop's phone shouldn't
// download the whole Calendar to show this list.
const StaffHoursSheet = dynamic(
  () => import("@/app/dashboard/booking/BookingManager").then((m) => m.StaffHoursSheet),
  { ssr: false },
);

const primary =
  "inline-flex h-11 w-full items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";

/**
 * Setup: each person's week, in the same hours editor the Calendar uses -
 * including "Paste hours from another app". A person is done once their week
 * is saved; Continue appears when everyone is.
 */
export function HoursStep({
  staff,
  next,
}: {
  staff: { id: string; name: string; hasHours: boolean }[];
  next: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);
  const allSet = staff.length > 0 && staff.every((s) => s.hasHours);

  if (staff.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-subtle p-6 text-center">
        <p className="text-sm text-muted">Hours belong to the people clients book. Add them first.</p>
        <a href="/onboarding/team" className={primary}>
          Add who takes appointments
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" aria-label="Hours">
        {staff.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-subtle px-4 py-3"
            data-testid="hours-row"
          >
            <span className="min-w-0 truncate text-sm text-offwhite">
              {s.hasHours && (
                <span aria-hidden="true" className="mr-2 text-emerald-soft">
                  ✓
                </span>
              )}
              {s.name}
            </span>
            <button
              type="button"
              onClick={() => setOpen({ id: s.id, name: s.name })}
              className={
                s.hasHours
                  ? "shrink-0 text-sm text-gold underline-offset-4 hover:underline"
                  : "shrink-0 rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal hover:bg-gold-muted"
              }
            >
              {s.hasHours ? "Edit" : "Set hours"}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        Coming from another app? Copy your hours from your old profile, then in the hours sheet tap &ldquo;Paste hours
        from another app&rdquo;.
      </p>
      {allSet ? (
        <a href={next} className={primary}>
          Continue
        </a>
      ) : (
        <a href={next} className="text-center text-xs text-muted underline-offset-4 hover:text-offwhite hover:underline">
          I&apos;ll set hours later
        </a>
      )}
      {open && (
        <StaffHoursSheet
          staffId={open.id}
          staffName={open.name}
          toast={toast}
          onClose={() => {
            setOpen(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
