"use client";

import { useTransition } from "react";
import { cn } from "@/lib/cn";
import { setRequestStatusAction } from "./actions";

type Status = "NEW" | "CONTACTED" | "CLOSED";

const OPTIONS: Status[] = ["NEW", "CONTACTED", "CLOSED"];

/** Inline status switcher for a lead row. Optimistic via revalidate on save. */
export function StatusControl({
  id,
  status,
}: {
  id: string;
  status: Status;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1">
      {OPTIONS.map((opt) => {
        const active = opt === status;
        return (
          <button
            key={opt}
            type="button"
            disabled={pending || active}
            onClick={() =>
              startTransition(() => {
                void setRequestStatusAction(id, opt);
              })
            }
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wide transition-colors duration-150 ease-out disabled:cursor-default",
              active
                ? opt === "NEW"
                  ? "bg-gold/15 text-gold"
                  : opt === "CONTACTED"
                    ? "bg-emerald-soft/15 text-emerald-soft"
                    : "bg-charcoal-700 text-muted"
                : "text-muted/60 hover:bg-charcoal-700 hover:text-offwhite",
            )}
          >
            {opt.toLowerCase()}
          </button>
        );
      })}
    </div>
  );
}
