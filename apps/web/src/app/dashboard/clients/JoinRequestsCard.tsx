"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { LocalDate } from "@/components/ui/LocalDate";
import { InstagramHandle } from "@/components/InstagramHandle";
import { answerJoinRequestAction } from "./joinRequestActions";

export interface JoinRequest {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  /** Bare handle the app asked for, so two first-name-only askers differ. */
  instagram?: string | null;
  requestedAt: string;
}

/**
 * People asking to join from the ChairBack app, at a shop that approves new
 * clients first. Accept makes them a client (their verified phone and email,
 * which pressing Join shop agreed to share); Decline takes the request away.
 * A row leaves only once the server has said yes - never on the click alone.
 */
export function JoinRequestsCard({ requests }: { requests: JoinRequest[] }) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const open = requests.filter((r) => !done.has(r.id));
  if (open.length === 0) return null;

  async function answer(id: string, verdict: "accept" | "decline") {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const r = await answerJoinRequestAction(id, verdict);
      if (r.ok || r.error === "That request was already answered.") {
        setDone((prev) => new Set(prev).add(id));
      }
      if (!r.ok) setError({ id, message: r.error });
    } catch {
      setError({ id, message: "Couldn't save that. Try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      <CardHeader
        title={open.length === 1 ? "1 person wants to join" : `${open.length} people want to join`}
        subtitle="They asked from the ChairBack app. Accept adds them to your clients, ready to book."
      />
      <ul className="mt-3 divide-y divide-subtle">
        {open.map((r) => (
          <li key={r.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate text-sm text-offwhite">
                {r.name}
                {r.instagram && (
                  <>
                    {" "}
                    <InstagramHandle handle={r.instagram} className="text-xs text-gold" />
                  </>
                )}
              </p>
              <p className="truncate text-xs text-muted">
                {[r.phone, r.email].filter(Boolean).join(" · ")}
                {" · asked "}
                <LocalDate iso={r.requestedAt} options={{ month: "short", day: "numeric" }} />
              </p>
              <FormError className="mt-1">{error?.id === r.id ? error.message : null}</FormError>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => void answer(r.id, "accept")}
                disabled={busy !== null}
                className="min-h-[40px] rounded-full bg-gold px-4 text-sm font-semibold text-charcoal transition-opacity duration-150 ease-out disabled:opacity-50"
              >
                {busy === r.id ? "Saving…" : "Accept"}
              </button>
              <button
                type="button"
                onClick={() => void answer(r.id, "decline")}
                disabled={busy !== null}
                className="min-h-[40px] rounded-full border border-subtle px-4 text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700 disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        Want everyone to join straight away? Turn off “Approve new clients” in{" "}
        <Link href="/dashboard/booking" className="text-gold hover:underline">
          Booking settings
        </Link>
        .
      </p>
    </Card>
  );
}
