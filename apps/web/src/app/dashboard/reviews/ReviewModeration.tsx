"use client";

import { useTransition } from "react";
import { cn } from "@/lib/cn";
import { setReviewStatusAction } from "./actions";

type Status = "PENDING" | "APPROVED" | "HIDDEN";

// Approve = publish to the public page; Hide = keep off the page; Pending =
// back to the awaiting-decision state. Labels are barber-facing verbs.
const OPTIONS: { value: Status; label: string }[] = [
  { value: "APPROVED", label: "approve" },
  { value: "HIDDEN", label: "hide" },
  { value: "PENDING", label: "pending" },
];

/** Inline moderation switcher for a review row. Revalidate-on-save. */
export function ReviewModeration({ id, status }: { id: string; status: Status }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1">
      {OPTIONS.map((opt) => {
        const active = opt.value === status;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={pending || active}
            onClick={() =>
              startTransition(() => {
                void setReviewStatusAction(id, opt.value);
              })
            }
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wide transition-colors duration-150 ease-out disabled:cursor-default",
              active
                ? opt.value === "APPROVED"
                  ? "bg-emerald-soft/15 text-emerald-soft"
                  : opt.value === "HIDDEN"
                    ? "bg-charcoal-700 text-muted"
                    : "bg-gold/15 text-gold"
                : "text-muted/60 hover:bg-charcoal-700 hover:text-offwhite",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
