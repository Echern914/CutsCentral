"use client";

import { useState, useTransition } from "react";
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
  // The pill only moves once the server has it. A refused or dropped change
  // used to leave it where it was with no word, so it looked done.
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {OPTIONS.map((opt) => {
        const active = opt === status;
        return (
          <button
            key={opt}
            type="button"
            disabled={pending || active}
            onClick={() =>
              startTransition(async () => {
                setFailed(false);
                const r = await setRequestStatusAction(id, opt).catch(() => ({ ok: false }));
                if (!r.ok) setFailed(true);
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
      {failed && (
        <span role="alert" className="text-[11px] text-danger-soft">
          Didn&apos;t save. Try again.
        </span>
      )}
    </div>
  );
}
