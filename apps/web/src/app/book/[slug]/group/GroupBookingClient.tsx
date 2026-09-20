"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BookShopData } from "../page";
import {
  groupCreateAction,
  groupPlanAction,
  groupSlotsAction,
  type GroupAttendeeInput,
  type GroupCreateOutcome,
  type GroupPlanResult,
} from "./actions";
import { GroupSequence, groupDateLabel } from "./GroupSequence";

/**
 * Booking a party of 2-3, back to back with one barber.
 *
 * 🔴 ITS OWN ROUTE, AND THE SINGLE BOOKING FLOW IS NOT TOUCHED. BookingClient
 * is 3,600 lines with forty-odd pieces of state; threading a second mode
 * through it would put every ordinary booking at risk to serve the rare one.
 * A party is also a genuinely different shape - who, then how many, then names
 * - so sharing that machine would have meant bending both.
 *
 * 🔴 QUANTITY 1 NEVER COMES HERE. One person is an ordinary booking and goes
 * through the page that has always handled it; this screen offers 2 or 3 only.
 *
 * Everything shown is the SERVER's arithmetic. The browser sends service IDs
 * and renders what comes back - see actions.ts.
 */

type Step = "who" | "people" | "when" | "review" | "done";

/** What survives a reload while the calendar is still confirming. */
const PENDING_KEY = "cb_group_pending";

interface PendingGroup {
  slug: string;
  groupId: string;
  manageToken: string;
  kind: "booked" | "confirming";
}

function readPending(slug: string): PendingGroup | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingGroup;
    return p && p.slug === slug && p.manageToken ? p : null;
  } catch {
    return null;
  }
}

function writePending(p: PendingGroup | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    /* private mode: the screen still works, it just will not survive a reload */
  }
}

/** A key that identifies THIS attempt, stable across retries of it. */
function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `grp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function GroupBookingClient({ data }: { data: BookShopData }) {
  const slug = data.shop.slug;
  const tz = data.shop.timezone;
  // 🔴 NEVER the literal "barber". This page renders for nail studios and
  // tattoo shops too, and the neutral fallback is what the rest of the product
  // already uses when a shop has not chosen a vertical.
  const providerNoun =
    data.shop.vocabulary?.providerNoun ?? NEUTRAL_VOCABULARY.providerNoun;

  const [step, setStep] = useState<Step>("who");
  const [staffId, setStaffId] = useState<string | null>(null);
  const [count, setCount] = useState<2 | 3 | null>(null);
  const [attendees, setAttendees] = useState<GroupAttendeeInput[]>([]);

  const [slots, setSlots] = useState<{ startsAt: string }[]>([]);
  const [slotsBusy, setSlotsBusy] = useState(false);
  const [startsAt, setStartsAt] = useState<string | null>(null);

  const [plan, setPlan] = useState<GroupPlanResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set when the shop cannot take group bookings at all. */
  const [blocked, setBlocked] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GroupCreateOutcome | null>(null);

  // Booker details.
  const [firstName, setFirstName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  /**
   * 🔴 A PARTY THAT WAS ALREADY SUBMITTED SURVIVES A RELOAD. Without this, a
   * customer who refreshes while the calendar is still confirming sees an empty
   * form and books the whole party a second time.
   */
  useEffect(() => {
    const pending = readPending(slug);
    if (!pending) return;
    setOutcome(
      pending.kind === "confirming"
        ? { kind: "confirming", groupId: pending.groupId, manageToken: pending.manageToken }
        : { kind: "booked", groupId: pending.groupId, manageToken: pending.manageToken },
    );
    setStep("done");
  }, [slug]);

  /** Services this chosen barber actually offers. */
  const offered = useMemo(() => {
    if (!staffId) return [];
    const ids = new Set(
      data.offerings.filter((o) => o.staffId === staffId).map((o) => o.serviceId),
    );
    return data.services.filter((s) => ids.has(s.id));
  }, [data.offerings, data.services, staffId]);

  const ready =
    attendees.length >= 2 &&
    attendees.every((a) => a.firstName.trim().length > 0 && a.serviceId);

  /**
   * 🔴 DOES NOT CLEAR THE NOTICE. It used to, and that silently ate the one
   * message that matters most: a slot conflict sets "that time was just taken,
   * nothing was booked" and then reloads the times - so the explanation was
   * wiped a moment after being written, and the customer was thrown back to a
   * picker with no idea why. Callers clear the notice when they START something
   * new; reloading times is not that.
   */
  const loadSlots = useCallback(async () => {
    if (!staffId || !ready) return;
    setSlotsBusy(true);
    const from = new Date();
    const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
    const res = await groupSlotsAction(slug, {
      staffId,
      // 🔴 In attendee order, repeats kept - two siblings can want the same cut.
      serviceIds: attendees.map((a) => a.serviceId),
      from: from.toISOString(),
      to: to.toISOString(),
    });
    setSlotsBusy(false);
    if (!res.ok) {
      if (res.code === "payments") setBlocked(true);
      else setNotice("We could not load times just now. Please try again.");
      return;
    }
    setSlots(res.data.slots);
    if (res.data.slots.length === 0) {
      setNotice(
        `No time in the next month fits all ${attendees.length} of you back to back with this ${providerNoun}.`,
      );
    }
  }, [attendees, providerNoun, ready, slug, staffId]);

  async function chooseTime(iso: string) {
    if (!staffId) return;
    setStartsAt(iso);
    setNotice(null);
    const res = await groupPlanAction(slug, { staffId, startsAt: iso, attendees });
    if (!res.ok) {
      if (res.code === "payments") return setBlocked(true);
      setNotice(
        res.code === "service_hours"
          ? "One of those services is not offered at that time. Pick another slot."
          : "That time is no longer available. Pick another.",
      );
      await loadSlots();
      return;
    }
    setPlan(res.plan);
    setIdempotencyKey(newIdempotencyKey());
    setStep("review");
  }

  async function confirm() {
    if (!staffId || !startsAt || submitting) return; // 🔴 one submission only
    const key = idempotencyKey ?? newIdempotencyKey();
    setIdempotencyKey(key);
    setSubmitting(true);
    setNotice(null);

    const res = await groupCreateAction(slug, {
      staffId,
      startsAt,
      attendees,
      firstName: firstName.trim(),
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      idempotencyKey: key,
    });
    setSubmitting(false);

    if (res.kind === "booked" || res.kind === "confirming") {
      writePending({ slug, groupId: res.groupId, manageToken: res.manageToken, kind: res.kind });
      setOutcome(res);
      setStep("done");
      return;
    }
    if (res.kind === "payments") return setBlocked(true);
    if (res.kind === "slot_taken") {
      setNotice("That time was just taken. Nothing was booked - please pick another.");
      setStep("when");
      await loadSlots();
      return;
    }
    if (res.kind === "network") {
      // 🔴 The SAME key is kept in state, so pressing Confirm again returns the
      // party that may already exist instead of booking a second one.
      setNotice("We could not reach the shop. Tap Confirm again - this will not double-book.");
      return;
    }
    setNotice(
      res.kind === "invalid"
        ? "Please check the names and your details."
        : "Something went wrong. Nothing was booked.",
    );
  }

  if (blocked) {
    return (
      <Shell title="Group booking">
        <p className="text-muted">
          Group booking isn&apos;t available online for this shop. You can still book
          each person separately, or call the shop to arrange it together.
        </p>
        <Link href={`/book/${slug}`} className="mt-5 inline-block text-gold underline">
          Book one person
        </Link>
      </Shell>
    );
  }

  if (step === "done" && outcome && (outcome.kind === "booked" || outcome.kind === "confirming")) {
    return (
      <Shell title={outcome.kind === "booked" ? "You're booked" : "Almost there"}>
        {outcome.kind === "confirming" ? (
          <p className="text-muted">
            Your appointments are held and we&apos;re confirming with the shop&apos;s calendar.
            You don&apos;t need to do anything - this page is safe to close.
          </p>
        ) : (
          <p className="text-muted">
            {data.shop.name} has the whole group booked. We&apos;ve sent one
            confirmation covering everyone.
          </p>
        )}

        {plan && (
          <div className="mt-5">
            <p className="mb-2 font-semibold text-offwhite">
              {groupDateLabel(plan.startsAt, tz)}
            </p>
            <GroupSequence plan={plan} timezone={tz} />
          </div>
        )}

        <div className="mt-6 rounded-2xl border border-subtle p-4">
          <p className="font-semibold text-offwhite">What happens next</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Arrive a few minutes before the first appointment.</li>
            <li>Everyone is seen one after the other, in the order above.</li>
            <li>Pay at the shop.</li>
          </ul>
        </div>

        <Link
          href={`/book/group/${outcome.manageToken}`}
          className="mt-5 inline-block rounded-xl bg-gold px-5 py-2.5 font-semibold text-charcoal-900"
        >
          View or change this group
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title="Book for 2 or 3 people">
      {notice && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-gold/40 bg-gold/10 p-3 text-sm text-offwhite"
        >
          {notice}
        </p>
      )}

      {step === "who" && (
        <>
          <Field label={`Which ${providerNoun}?`}>
            <div className="flex flex-col gap-2">
              {data.staff.map((s) => (
                <Choice
                  key={s.id}
                  selected={staffId === s.id}
                  onClick={() => setStaffId(s.id)}
                  label={s.name}
                />
              ))}
            </div>
          </Field>

          <Field label="How many people?">
            <div className="flex gap-2">
              {([2, 3] as const).map((n) => (
                <Choice
                  key={n}
                  selected={count === n}
                  onClick={() => {
                    setCount(n);
                    setAttendees(
                      Array.from({ length: n }, (_, i) => attendees[i] ?? { firstName: "", serviceId: "" }),
                    );
                  }}
                  label={`${n} people`}
                />
              ))}
            </div>
            <p className="mt-2 text-sm text-muted">
              Booking for one person?{" "}
              <Link href={`/book/${slug}`} className="text-gold underline">
                Use the normal booking page
              </Link>
              .
            </p>
          </Field>

          <Primary
            disabled={!staffId || !count}
            onClick={() => setStep("people")}
            label="Next"
          />
        </>
      )}

      {step === "people" && (
        <>
          {attendees.map((a, i) => (
            <Field key={i} label={`Person ${i + 1}`}>
              <input
                className="w-full rounded-xl border border-subtle bg-charcoal-900 px-4 py-3 text-offwhite"
                placeholder="First name"
                value={a.firstName}
                maxLength={60}
                onChange={(e) => {
                  const next = [...attendees];
                  next[i] = { ...next[i]!, firstName: e.target.value };
                  setAttendees(next);
                }}
              />
              <div className="mt-2 flex flex-col gap-2">
                {offered.map((s) => (
                  <Choice
                    key={s.id}
                    selected={a.serviceId === s.id}
                    onClick={() => {
                      const next = [...attendees];
                      next[i] = { ...next[i]!, serviceId: s.id };
                      setAttendees(next);
                    }}
                    label={s.name}
                    hint={`${s.durationMin} min`}
                  />
                ))}
              </div>
            </Field>
          ))}
          <Secondary onClick={() => setStep("who")} label="Back" />
          <Primary
            disabled={!ready}
            onClick={async () => {
              setNotice(null);
              setStep("when");
              await loadSlots();
            }}
            label="See times"
          />
        </>
      )}

      {step === "when" && (
        <>
          <Field label="When?">
            {slotsBusy ? (
              <p className="text-muted">Finding times that fit everyone…</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {slots.map((s) => (
                  <button
                    key={s.startsAt}
                    type="button"
                    onClick={() => void chooseTime(s.startsAt)}
                    className="rounded-xl border border-subtle px-4 py-2.5 text-sm text-offwhite"
                  >
                    {groupDateLabel(s.startsAt, tz)},{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      timeZone: tz,
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(s.startsAt))}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-3 text-sm text-muted">
              Only times where this {providerNoun} can see everyone back to back.
            </p>
          </Field>
          <Secondary onClick={() => setStep("people")} label="Back" />
        </>
      )}

      {step === "review" && plan && (
        <>
          <p className="mb-2 font-semibold text-offwhite">
            {groupDateLabel(plan.startsAt, tz)}
          </p>
          <GroupSequence plan={plan} timezone={tz} />

          <Field label="Your details">
            <input
              className="w-full rounded-xl border border-subtle bg-charcoal-900 px-4 py-3 text-offwhite"
              placeholder="Your first name"
              value={firstName}
              maxLength={60}
              onChange={(e) => setFirstName(e.target.value)}
            />
            <input
              className="mt-2 w-full rounded-xl border border-subtle bg-charcoal-900 px-4 py-3 text-offwhite"
              placeholder="Mobile number"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <input
              className="mt-2 w-full rounded-xl border border-subtle bg-charcoal-900 px-4 py-3 text-offwhite"
              placeholder="Email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="mt-2 text-sm text-muted">
              One confirmation covers the whole group.
            </p>
          </Field>

          <Secondary onClick={() => setStep("when")} label="Pick another time" />
          {/* 🔴 THE ONE EXPLICIT CONFIRMATION, and the only place a party is
              written. Disabled while submitting so a double tap cannot fire
              twice; the idempotency key makes a retry safe even if it did. */}
          <Primary
            disabled={submitting || firstName.trim().length === 0}
            onClick={() => void confirm()}
            label={
              submitting
                ? "Booking…"
                : `Confirm ${plan.members.length} appointments`
            }
          />
        </>
      )}
    </Shell>
  );
}

/* ---------------------------------------------------------------- bits --- */

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="mb-5 text-2xl font-semibold text-offwhite">{title}</h1>
      {children}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 font-semibold text-offwhite">{label}</h2>
      {children}
    </section>
  );
}

function Choice({
  selected,
  onClick,
  label,
  hint,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex min-h-11 items-center justify-between rounded-xl border px-4 py-2.5 text-left ${
        selected ? "border-gold bg-gold/10 text-offwhite" : "border-subtle text-offwhite"
      }`}
    >
      <span className="min-w-0 truncate">{label}</span>
      {hint && <span className="ml-3 shrink-0 text-sm text-muted">{hint}</span>}
    </button>
  );
}

function Primary({
  disabled,
  onClick,
  label,
}: {
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="mt-2 w-full rounded-xl bg-gold px-5 py-3 font-semibold text-charcoal-900 disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function Secondary({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-2 w-full rounded-xl border border-subtle px-5 py-3 font-semibold text-offwhite"
    >
      {label}
    </button>
  );
}
