"use client";

import { useState } from "react";
import { groupSlotsAction } from "../../[slug]/group/actions";
import { groupDateLabel, money } from "../../[slug]/group/GroupSequence";
import {
  cancelGroupAction,
  cancelMemberAction,
  groupRescheduleAction,
  type GroupPriceChange,
  type GroupView,
} from "./actions";

/**
 * Managing a booked party: see it, move it, or cancel - one person or everyone.
 *
 * 🔴 CANCEL-ONE AND CANCEL-ALL ARE DIFFERENT ACTIONS AND ARE NEVER INFERRED
 * FROM EACH OTHER. One attendee dropping out leaves the rest booked, because
 * they are still coming. Each is behind its own confirmation that says, in
 * words, exactly who it affects - the failure mode this screen exists to
 * prevent is somebody cancelling their nephew and losing their own chair.
 */

const time = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

type Confirming =
  | { kind: "none" }
  | { kind: "member"; token: string; name: string }
  | { kind: "all" };

export function GroupManageClient({
  token,
  initial,
}: {
  token: string;
  initial: GroupView;
}) {
  const [group, setGroup] = useState(initial);
  const [confirming, setConfirming] = useState<Confirming>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [slots, setSlots] = useState<{ startsAt: string }[]>([]);
  // 🔴 A NEW TIME THAT CHANGES WHAT THE PARTY PAYS IS SHOWN BEFORE ANYONE
  // MOVES. The API answers `price_changes` with the new total and each changed
  // seat and moves nobody; a yes sends that exact list back.
  const [priceAsk, setPriceAsk] = useState<({ iso: string } & GroupPriceChange) | null>(null);

  const tz = group.shop.timezone;
  const live = group.members.filter((m) => m.status === "BOOKED");
  const canceledAll = group.status === "CANCELED" || live.length === 0;

  async function refresh() {
    const { groupViewAction } = await import("./actions");
    const res = await groupViewAction(token);
    if (res.ok) setGroup(res.group);
  }

  async function loadTimes() {
    setBusy(true);
    setNotice(null);
    const from = new Date();
    const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
    const res = await groupSlotsAction(group.shop.slug, {
      staffId: group.staff.id,
      // 🔴 Rebuilt from the members still BOOKED, in order. A party that lost
      // someone re-asks for the SHORTER run, not the one it was booked as.
      serviceIds: live.map((m) => m.serviceId),
      from: from.toISOString(),
      to: to.toISOString(),
    });
    setBusy(false);
    if (!res.ok) {
      setNotice("We could not load times just now.");
      return;
    }
    setSlots(res.data.slots);
    setMoving(true);
    if (res.data.slots.length === 0) {
      setNotice("No time in the next month fits the whole group back to back.");
    }
  }

  async function move(iso: string, accept?: GroupPriceChange) {
    setBusy(true);
    setNotice(null);
    if (accept === undefined) setPriceAsk(null);
    const res = await groupRescheduleAction(token, iso, accept?.seats);
    setBusy(false);
    if (!res.ok && res.code === "price_changes") {
      setPriceAsk({ iso, ...res.priceChange });
      return;
    }
    if (!res.ok) {
      setPriceAsk(null);
      setNotice(
        res.code === "slot_taken"
          ? "That time was just taken. Nobody was moved - please pick another."
          : res.code === "canceled"
            ? "This group has been cancelled."
            : res.code === "contact_shop"
              ? "This booking can't be moved online. Please contact the shop to change it."
              : res.code === "price_changed"
                ? "That time has a different price and part of this booking is already paid. Nobody was moved - please contact the shop to move it."
                : "That time did not work. Please pick another.",
      );
      return;
    }
    setPriceAsk(null);
    setMoving(false);
    setNotice("Everyone has been moved.");
    await refresh();
  }

  async function doCancel() {
    if (confirming.kind === "none" || busy) return;
    setBusy(true);
    const res =
      confirming.kind === "all"
        ? await cancelGroupAction(token)
        : await cancelMemberAction(confirming.token);
    setBusy(false);
    setConfirming({ kind: "none" });
    if (!res.ok) {
      setNotice("That could not be cancelled. Please try again.");
      return;
    }
    setNotice(
      confirming.kind === "all"
        ? "The whole group has been cancelled."
        : `${confirming.name}'s appointment has been cancelled. Everyone else is still booked.`,
    );
    await refresh();
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-offwhite">
        {canceledAll ? "Group cancelled" : "Your group"}
      </h1>
      <p className="mt-1 text-muted">
        {group.shop.name} · with {group.staff.name}
      </p>

      {notice && (
        <p
          role="status"
          className="mt-4 rounded-xl border border-gold/40 bg-gold/10 p-3 text-sm text-offwhite"
        >
          {notice}
        </p>
      )}

      {!canceledAll && group.startsAt && (
        <p className="mt-5 font-semibold text-offwhite">
          {groupDateLabel(group.startsAt, tz)}
        </p>
      )}

      <ul className="mt-2 divide-y divide-white/5 rounded-2xl border border-subtle bg-charcoal-800/60">
        {group.members.map((m) => {
          const gone = m.status !== "BOOKED";
          return (
            <li key={m.appointmentId} className="flex items-baseline gap-3 p-4">
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate font-semibold ${
                    gone ? "text-muted line-through" : "text-offwhite"
                  }`}
                >
                  {m.firstName}
                </span>
                <span className="block truncate text-sm text-muted">
                  {m.serviceName ?? "Appointment"}
                  {gone ? " · cancelled" : ""}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block whitespace-nowrap text-sm text-offwhite">
                  {time(m.startsAt, tz)}
                  <span className="text-muted"> – {time(m.endsAt, tz)}</span>
                </span>
                <span className="block text-sm text-muted">
                  {m.priceCents === null ? "Priced in shop" : money(m.priceCents)}
                </span>
              </span>
              {!gone && !canceledAll && (
                <button
                  type="button"
                  onClick={() =>
                    setConfirming({ kind: "member", token: m.manageToken, name: m.firstName })
                  }
                  className="ml-2 shrink-0 text-sm text-muted underline hover:text-offwhite"
                >
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {!canceledAll && (
        <>
          <p className="mt-3 text-sm text-muted">Pay at the shop.</p>

          {moving ? (
            <section className="mt-6">
              <h2 className="mb-2 font-semibold text-offwhite">Move everyone to…</h2>
              {priceAsk && (
                <div
                  role="alertdialog"
                  aria-label="This time has a different price"
                  data-qa="group-price-changes"
                  className="mb-3 rounded-xl border border-gold/50 bg-gold/10 p-3 text-sm text-offwhite"
                >
                  <p className="font-semibold">
                    {groupDateLabel(priceAsk.iso, tz)}, {time(priceAsk.iso, tz)} is priced differently.
                  </p>
                  <p className="mt-1">
                    The group&apos;s total would change from{" "}
                    <span className="font-semibold">{money(priceAsk.fromCents)}</span> to{" "}
                    <span className="font-semibold">{money(priceAsk.toCents)}</span>. Nobody has moved yet.
                  </p>
                  <ul className="mt-2 space-y-0.5 text-muted">
                    {priceAsk.seats.map((s) => (
                      <li key={s.appointmentId}>
                        {s.firstName ?? "Guest"}: {s.fromCents === null ? "no price" : money(s.fromCents)} to{" "}
                        {money(s.toCents)}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void move(priceAsk.iso, priceAsk)}
                      className="rounded-lg bg-gold px-3 py-1.5 text-xs font-semibold text-charcoal-900 disabled:opacity-40"
                    >
                      {busy ? "Moving…" : `Move everyone at ${money(priceAsk.toCents)}`}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPriceAsk(null)}
                      className="rounded-lg border border-subtle px-3 py-1.5 text-xs font-medium text-offwhite"
                    >
                      Keep our time
                    </button>
                  </div>
                </div>
              )}
              {busy ? (
                <p className="text-muted">Finding times…</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {slots.map((s) => (
                    <button
                      key={s.startsAt}
                      type="button"
                      onClick={() => void move(s.startsAt)}
                      className="rounded-xl border border-subtle px-4 py-2.5 text-sm text-offwhite"
                    >
                      {groupDateLabel(s.startsAt, tz)}, {time(s.startsAt, tz)}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setPriceAsk(null);
                  setMoving(false);
                }}
                className="mt-3 text-sm text-muted underline"
              >
                Never mind
              </button>
            </section>
          ) : (
            <div className="mt-6 flex flex-col gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void loadTimes()}
                className="w-full rounded-xl border border-subtle px-5 py-3 font-semibold text-offwhite disabled:opacity-50"
              >
                Move the whole group
              </button>
              <button
                type="button"
                onClick={() => setConfirming({ kind: "all" })}
                className="w-full rounded-xl border border-subtle px-5 py-3 font-semibold text-offwhite"
              >
                Cancel the whole group
              </button>
            </div>
          )}
        </>
      )}

      {/* 🔴 THE CONSEQUENCE IS SPELLED OUT IN WORDS, and the two cancels never
          share one. Somebody cancelling their nephew must not lose their own
          chair, and somebody cancelling the visit must know it takes everyone. */}
      {confirming.kind !== "none" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm cancellation"
          className="mt-6 rounded-2xl border border-gold/40 bg-charcoal-800 p-4"
        >
          <p className="font-semibold text-offwhite">
            {confirming.kind === "all"
              ? `Cancel all ${live.length} appointments?`
              : `Cancel only ${confirming.name}'s appointment?`}
          </p>
          <p className="mt-1 text-sm text-muted">
            {confirming.kind === "all"
              ? "Everyone in this group loses their appointment. This cannot be undone here."
              : `Everyone else in the group keeps their appointment. Only ${confirming.name} is cancelled.`}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void doCancel()}
              className="flex-1 rounded-xl bg-gold px-5 py-3 font-semibold text-charcoal-900 disabled:opacity-50"
            >
              {busy
                ? "Cancelling…"
                : confirming.kind === "all"
                  ? "Yes, cancel everyone"
                  : `Yes, cancel ${confirming.name}`}
            </button>
            <button
              type="button"
              onClick={() => setConfirming({ kind: "none" })}
              className="flex-1 rounded-xl border border-subtle px-5 py-3 font-semibold text-offwhite"
            >
              Keep it
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
