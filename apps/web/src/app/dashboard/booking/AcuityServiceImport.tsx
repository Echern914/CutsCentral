"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { formatMinutes, formatPrice } from "@/lib/serviceFields";
import {
  importAcuityServicesAction,
  previewAcuityServiceImportAction,
  type AcuityImportPreview,
  type AcuityImportRow,
} from "./actions";

/**
 * IMPORT SERVICES FROM ACUITY.
 *
 * Shown on the Services tab while an Acuity account is connected, so a shop
 * moving over does not retype its whole menu. Always a preview first: every
 * Acuity service, marked as new, already here, or left out and why. Only the
 * services marked new are added, and only when the owner says so. Nothing
 * already in ChairBack is ever changed (see engines/acuityServiceImport.ts).
 */

const LEFT_OUT: Record<Exclude<AcuityImportRow["status"], "new">, string> = {
  exists: "Already in ChairBack",
  duplicate: "Same name as one above",
  inactive: "Turned off in Acuity",
  private: "Private in Acuity - add it by hand, then tap its eye to hide it from clients",
  class: "A class - not imported",
  bad_length: "Length can't be booked here",
};

/** New first, then what is already here, then what is left out. */
const RANK: Record<AcuityImportRow["status"], number> = {
  new: 0,
  exists: 1,
  duplicate: 2,
  inactive: 3,
  private: 3,
  class: 3,
  bad_length: 3,
};

export function AcuityServiceImport({
  toast,
}: {
  toast: (msg: string, kind?: "success" | "error") => void;
}) {
  const [preview, setPreview] = useState<AcuityImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function check() {
    setError(null);
    start(async () => {
      const res = await previewAcuityServiceImportAction();
      if (res.ok && res.data) setPreview(res.data);
      else setError(res.error ?? "failed");
    });
  }

  function confirm(ids: string[]) {
    start(async () => {
      const res = await importAcuityServicesAction(ids);
      if (!res.ok) {
        toast("Couldn't add them. Nothing was changed - try again.", "error");
        return;
      }
      const n = res.created ?? 0;
      toast(
        n === 0
          ? "Nothing new to add - they're all here already."
          : `Added ${n} ${n === 1 ? "service" : "services"} from Acuity`,
        "success",
      );
      setPreview(null);
    });
  }

  // Disconnected between page load and this tap: nothing to import from.
  if (error === "acuity_not_connected") return null;

  const rows = preview ? [...preview.rows].sort((a, b) => RANK[a.status] - RANK[b.status]) : [];
  const newIds = rows.filter((r) => r.status === "new").map((r) => r.acuityId);
  const newGroups = preview?.newGroups ?? [];

  return (
    <Card className="p-5">
      <CardHeader
        title="Import services from Acuity"
        subtitle="Copy your Acuity services here instead of typing them again. You'll see the list before anything is added."
      />

      {!preview && (
        <>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger-soft">
              Couldn&apos;t reach Acuity just now. Try again, or reconnect Acuity in
              Settings if this keeps happening.
            </p>
          )}
          <button
            onClick={check}
            disabled={pending}
            className="mt-4 h-11 rounded-lg border border-subtle px-4 text-sm font-medium text-offwhite hover:bg-charcoal-700 disabled:opacity-50 sm:h-9"
          >
            {pending ? "Reading your Acuity services…" : "Check my Acuity services"}
          </button>
        </>
      )}

      {preview && (
        <>
          <p role="status" className="mt-4 text-sm text-offwhite">
            {newIds.length === 0
              ? "Everything from Acuity is already here. Nothing to add."
              : `${newIds.length} new ${newIds.length === 1 ? "service" : "services"} to add` +
                (newGroups.length > 0
                  ? `, in ${newGroups.length} new ${newGroups.length === 1 ? "group" : "groups"} (${newGroups.join(", ")})`
                  : "") +
                ". Services already here stay exactly as they are."}
          </p>

          <ul className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto">
            {rows.map((r) => (
              <li
                key={r.acuityId}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between",
                  r.status === "new" ? "border-gold/40" : "border-subtle opacity-70",
                )}
              >
                <div className="min-w-0">
                  <p className="[overflow-wrap:anywhere] text-sm font-semibold text-offwhite">
                    {r.name}
                  </p>
                  <p className="text-xs text-muted">
                    {[
                      r.durationMin !== null ? formatMinutes(r.durationMin) : null,
                      r.price !== null ? formatPrice(r.price) : "No price",
                      r.category,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span
                  className={cn(
                    "shrink-0 text-xs",
                    r.status === "new" ? "font-medium text-gold" : "text-muted",
                  )}
                >
                  {r.status === "new" ? "New" : LEFT_OUT[r.status]}
                </span>
              </li>
            ))}
            {rows.length === 0 && (
              <li className="text-sm text-muted">Your Acuity account has no services.</li>
            )}
          </ul>

          <p className="mt-3 text-xs text-muted">
            New services are offered by everyone on your team and use your regular
            hours. Add-ons aren&apos;t imported - add those below.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {newIds.length > 0 && (
              <button
                onClick={() => confirm(newIds)}
                disabled={pending}
                className="h-11 rounded-lg bg-gold px-4 text-sm font-semibold text-charcoal-900 disabled:opacity-50 sm:h-9"
              >
                {pending
                  ? "Adding…"
                  : `Add ${newIds.length} ${newIds.length === 1 ? "service" : "services"}`}
              </button>
            )}
            <button
              onClick={() => setPreview(null)}
              disabled={pending}
              className="h-11 rounded-lg border border-subtle px-4 text-sm font-medium text-offwhite hover:bg-charcoal-700 disabled:opacity-50 sm:h-9"
            >
              {newIds.length > 0 ? "Cancel" : "Close"}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
