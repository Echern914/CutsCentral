"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { repairAcuitySyncAction } from "../actions";

/**
 * Shown only when Acuity is connected but live sync is broken (no webhook
 * subscriptions) - the state the dotted-event bug produced. One click re-runs
 * subscription + backfill via the repair endpoint. For a hands-off fleet, a
 * barber must be able to see and self-heal a broken sync without support.
 *
 * Also shown, instead, when Acuity has stopped accepting ChairBack's sign-in.
 * Repair cannot help then (it uses the same refused sign-in), so the one
 * button is Reconnect Acuity, which signs in again and keeps everything.
 */
export function SyncHealthBanner({
  needsRepair,
  needsReconnect = false,
  reconnectHref,
}: {
  needsRepair: boolean;
  needsReconnect?: boolean;
  /** The Acuity sign-in start URL on the API. */
  reconnectHref?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  if (needsReconnect && reconnectHref) {
    return (
      <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-gold/40 bg-gold/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-gold">Reconnect Acuity</p>
          <p className="mt-0.5 text-xs text-muted">
            Acuity stopped accepting ChairBack&apos;s sign-in, so new Acuity bookings
            and changes aren&apos;t reaching ChairBack. Reconnecting keeps your
            appointments and settings.
          </p>
        </div>
        <a
          href={reconnectHref}
          className="shrink-0 rounded-full bg-gold px-5 py-2 text-center text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
        >
          Reconnect Acuity
        </a>
      </div>
    );
  }

  if (!needsRepair || done) return null;

  function repair() {
    startTransition(async () => {
      const r = await repairAcuitySyncAction();
      if (r.ok) {
        toast(
          `Sync repaired. ${r.subscribed ?? 0} live updates reconnected. Importing history…`,
          "success",
        );
        setDone(true);
        router.refresh();
      } else {
        toast(r.message ?? "Repair failed. Try reconnecting Acuity.", "error");
      }
    });
  }

  return (
    <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-gold/40 bg-gold/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-gold">Live booking sync needs attention</p>
        <p className="mt-0.5 text-xs text-muted">
          Acuity is connected, but new bookings aren&apos;t streaming in yet. Click
          repair to reconnect live updates and re-import your appointments.
        </p>
      </div>
      <button
        onClick={repair}
        disabled={pending}
        className="shrink-0 rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted disabled:opacity-50"
      >
        {pending ? "Repairing…" : "Repair sync"}
      </button>
    </div>
  );
}
