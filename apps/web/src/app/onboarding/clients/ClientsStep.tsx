"use client";

import { useRouter } from "next/navigation";
import { ImportClients } from "@/app/dashboard/clients/ImportClients";

const primary =
  "inline-flex h-11 w-full items-center justify-center rounded-full bg-gold px-5 text-sm font-semibold text-charcoal transition-colors hover:bg-gold-muted disabled:opacity-50";

/**
 * Setup: bring the client list, the same import as Clients - a Booksy CSV or
 * the phone's contacts (TheCut has no export), every person checked before
 * anything is added. Optional: a new shop with no list yet goes straight on.
 */
export function ClientsStep({ next, imported }: { next: string; imported: number }) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-4">
      {imported > 0 && (
        <p role="status" className="text-center text-sm text-emerald-soft">
          {imported} {imported === 1 ? "client" : "clients"} in your book.
        </p>
      )}
      <div className="rounded-2xl border border-subtle p-4">
        <ImportClients onDone={() => router.push(next)} />
      </div>
      <p className="text-center text-xs text-muted">
        On Booksy: Customers → Export to CSV. On TheCut: export your phone&apos;s contacts.{" "}
        <a href="/dashboard/clients/switch" className="text-gold underline-offset-4 hover:underline">
          Step by step
        </a>
      </p>
      <a href={next} className={imported > 0 ? primary : "text-center text-xs text-muted underline-offset-4 hover:text-offwhite hover:underline"}>
        {imported > 0 ? "Continue" : "I don't have a list to bring"}
      </a>
    </div>
  );
}
