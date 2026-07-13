"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { BackToDashboard } from "@/components/BackToDashboard";
import { useSignalNativeReady } from "@/lib/nativeReady";
import type { BookShopData } from "./page";
import { bookAction, getSlotsAction, type SlotsResult } from "./actions";
import { PaymentStep } from "./PaymentStep";
import { WaitlistForm } from "./WaitlistForm";

/**
 * Public native booking picker: pick service -> barber -> day -> open slot ->
 * enter contact + SMS consent -> confirm. Slots come from the server action
 * (CSP blocks a direct browser fetch); the create action returns a manage token
 * so we can link the customer to cancel/reschedule. Accent-themed to the shop.
 */
export function BookingClient({ data }: { data: BookShopData }) {
  // Clear the native app's WebView spinner (reachable from the shop page's Book
  // CTA inside the app; the shell may be waiting on this ready signal).
  useSignalNativeReady();

  const accent = data.shop.accentColor || "#D4AF37";
  const tz = data.shop.timezone;

  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null); // YYYY-MM-DD (local)
  const [slot, setSlot] = useState<string | null>(null); // ISO startsAt
  // Set when the chosen slot is a barber-published TARGETED slot (fixed price,
  // no add-ons); its id goes on the booking POST so the server claims it.
  const [slotTargeted, setSlotTargeted] = useState<{
    id: string;
    price: number;
    label: string | null;
  } | null>(null);
  const [slotsByDay, setSlotsByDay] = useState<
    Map<string, { startsAt: string; targeted?: { id: string; price: number; label: string | null } }[]>
  >(new Map());
  const [loadingSlots, setLoadingSlots] = useState(false);

  // Chosen add-ons (ids) for the picked service. Add-ons extend the appointment
  // and the total; validated at create (if they overflow the slot, the create
  // returns invalid_slot and the customer picks another time).
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // MUST default to false: a pre-checked consent box is not valid consent under
  // TCPA and is explicitly rejected by 10DLC campaign vetting (the box must be
  // actively selected by the user). See the booking consent label below.
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmedToken, setConfirmedToken] = useState<string | null>(null);
  // true when the shop requires approval: the customer submitted a REQUEST, not a
  // confirmed booking, so the success screen reads "Request sent".
  const [wasRequest, setWasRequest] = useState(false);
  // Set when the shop charges at booking: the booking is created (BOOKED) and we
  // collect payment before showing the confirmation screen.
  const [paymentSecret, setPaymentSecret] = useState<string | null>(null);
  // The manage token of a booking awaiting payment (shown after the card clears).
  const [manageTokenPending, setManageTokenPending] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Waitlist: null = hidden; "standing" = generic join; "slot" = join for the
  // currently-chosen service/provider (a fully-booked day).
  const [waitlistMode, setWaitlistMode] = useState<null | "standing" | "slot">(null);

  // Which staff offer the chosen service, and which services a chosen staff offers.
  const staffForService = useMemo(() => {
    if (!serviceId) return data.staff;
    const ids = new Set(
      data.offerings.filter((o) => o.serviceId === serviceId).map((o) => o.staffId),
    );
    return data.staff.filter((s) => ids.has(s.id));
  }, [serviceId, data]);

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [tz],
  );
  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }),
    [tz],
  );

  /** Local (shop-tz) YYYY-MM-DD bucket key for an instant. */
  function dayKey(iso: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
    return parts; // en-CA yields YYYY-MM-DD
  }

  /** Clear the chosen time (and any targeted-slot selection riding on it). */
  function clearSlotPick() {
    setSlot(null);
    setSlotTargeted(null);
  }

  function loadSlots(svc: string, stf: string) {
    setLoadingSlots(true);
    setError(null);
    const from = new Date().toISOString();
    const to = new Date(
      Date.now() + data.shop.bookingMaxDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    startTransition(async () => {
      const res = await getSlotsAction(data.shop.slug, stf, svc, from, to);
      if (!res.ok || !res.data) {
        setError("Couldn't load times. Please try again.");
        setLoadingSlots(false);
        return;
      }
      bucketSlots(res.data, svc, stf);
      setLoadingSlots(false);
    });
  }

  function bucketSlots(result: SlotsResult, svc: string, stf: string) {
    const map = new Map<
      string,
      { startsAt: string; targeted?: { id: string; price: number; label: string | null } }[]
    >();
    for (const s of result.slots) {
      const key = dayKey(s.startsAt);
      const list = map.get(key) ?? [];
      list.push({ startsAt: s.startsAt });
      map.set(key, list);
    }
    // Merge the barber's targeted slots for this service+barber into the grid,
    // badged with their own price (the normal engine never offers these times -
    // it blocks around them - so there are no duplicates to reconcile).
    for (const t of data.targetedSlots) {
      if (t.serviceId !== svc || t.staffId !== stf) continue;
      if (new Date(t.startsAt).getTime() <= Date.now()) continue;
      const key = dayKey(t.startsAt);
      const list = map.get(key) ?? [];
      list.push({
        startsAt: t.startsAt,
        targeted: { id: t.id, price: t.price, label: t.label },
      });
      list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      map.set(key, list);
    }
    setSlotsByDay(map);
    // Auto-select the first day with availability.
    const firstDay = [...map.keys()].sort()[0] ?? null;
    setDay(firstDay);
    clearSlotPick();
  }

  function pickService(id: string) {
    setServiceId(id);
    setStaffId(null);
    setSlotsByDay(new Map());
    setDay(null);
    clearSlotPick();
    setAddOnIds([]); // add-ons are per-service; clear on change
  }

  // Add-ons valid for the chosen service (shop-wide null, or scoped to it).
  const addOnsForService = useMemo(() => {
    if (!serviceId) return [];
    return data.addOns.filter((a) => a.serviceId === null || a.serviceId === serviceId);
  }, [serviceId, data.addOns]);

  function toggleAddOn(id: string) {
    setAddOnIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function pickStaff(id: string) {
    setStaffId(id);
    clearSlotPick();
    if (serviceId) loadSlots(serviceId, id);
  }

  // ---- Step-back navigation (customer stepping back a stage). Each clears the
  // state that gates the current step, collapsing the wizard to the prior one.
  function backToService() {
    setServiceId(null);
    setStaffId(null);
    setSlotsByDay(new Map());
    setDay(null);
    clearSlotPick();
  }
  function backToProvider() {
    setStaffId(null);
    clearSlotPick();
  }
  function backToTime() {
    clearSlotPick();
  }

  function submit() {
    setError(null);
    if (!firstName.trim()) {
      setError("Please add your name.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Add a phone or email so we can confirm.");
      return;
    }
    if (!serviceId || !staffId || !slot) return;
    startTransition(async () => {
      const res = await bookAction(data.shop.slug, {
        staffId,
        serviceId,
        startsAt: slot,
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        smsConsent: consent && Boolean(phone.trim()),
        // A targeted slot has a fixed length/price - no add-ons.
        addOnIds:
          !slotTargeted && addOnIds.length > 0 ? addOnIds : undefined,
        targetedSlotId: slotTargeted?.id,
      });
      if (!res.ok) {
        if (res.error === "slot_taken") {
          setError("That time was just taken. Pick another slot.");
          // Refresh availability so the taken slot disappears.
          if (serviceId && staffId) loadSlots(serviceId, staffId);
          clearSlotPick();
        } else if (res.error === "no_active_access") {
          setError(
            `Online booking is paused for ${data.shop.name} right now. Please contact the shop directly to book.`,
          );
        } else if (res.error === "invalid_slot" && addOnIds.length > 0) {
          setError(
            "With those add-ons this appointment runs longer than that slot. Try fewer add-ons or a different time.",
          );
        } else {
          setError("Something went wrong. Please try again.");
        }
        return;
      }
      // Pay-ahead: the booking is created; collect payment before confirming.
      if (res.paymentClientSecret) {
        setManageTokenPending(res.manageToken ?? null);
        setPaymentSecret(res.paymentClientSecret);
        return;
      }
      setWasRequest(Boolean(res.pending));
      setConfirmedToken(res.manageToken ?? null);
    });
  }

  const days = [...slotsByDay.keys()].sort();
  const daySlots = day ? (slotsByDay.get(day) ?? []) : [];

  const selectedService = data.services.find((s) => s.id === serviceId) ?? null;

  /** Shop-tz weekday (0=Sun..6=Sat) for an ISO instant, matching the API. */
  function weekdayInTz(iso: string): number {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
      new Date(iso),
    );
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0;
  }

  /** The effective price for a service on a given ISO date (override else base). */
  function priceForDay(
    svc: { price: number | null; priceOverrides: Record<string, number> },
    iso: string,
  ): number | null {
    const wd = String(weekdayInTz(iso));
    if (Object.prototype.hasOwnProperty.call(svc.priceOverrides, wd)) return svc.priceOverrides[wd]!;
    return svc.price;
  }

  /** Menu label: "$45", "from $45", or "$45-$55" depending on the range. */
  function priceLabel(svc: { priceRange: { min: number; max: number } | null }): string | null {
    if (!svc.priceRange) return null;
    const { min, max } = svc.priceRange;
    if (min === max) return `$${min.toFixed(0)}`;
    return `$${min.toFixed(0)}-$${max.toFixed(0)}`;
  }

  // The exact price for the slot the customer has chosen (so no surprise). A
  // targeted slot carries its own price - that's its whole point.
  const selectedPrice = slotTargeted
    ? slotTargeted.price
    : selectedService && slot
      ? priceForDay(selectedService, slot)
      : null;
  // Chosen add-ons' extra price + the combined total shown before booking.
  const addOnsTotal = addOnsForService
    .filter((a) => addOnIds.includes(a.id))
    .reduce((sum, a) => sum + (a.price ?? 0), 0);
  const grandTotal = selectedPrice === null ? null : selectedPrice + addOnsTotal;
  const primaryBtn =
    "w-full rounded-xl py-3 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01] disabled:opacity-50";
  const input =
    "w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-offwhite placeholder:text-muted focus:border-white/40 focus:outline-none";

  // ---- Payment screen (pay-ahead: booking created, collect card/Apple Pay) ----
  if (paymentSecret !== null && confirmedToken === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <h1 className="font-display text-2xl">Pay to confirm</h1>
          <p className="mt-1 mb-4 text-sm text-muted">
            Your time is held. Enter payment to lock in your appointment with{" "}
            {data.shop.name}.
          </p>
          <PaymentStep
            clientSecret={paymentSecret}
            amountLabel={selectedPrice !== null ? `$${selectedPrice.toFixed(0)}` : null}
            accent={accent}
            onPaid={() => setConfirmedToken(manageTokenPending)}
          />
          <p className="mt-3 text-center text-[11px] text-muted">
            Powered by Stripe. Your card details never touch {data.shop.name}.
          </p>
        </div>
      </main>
    );
  }

  // ---- Confirmation screen ----
  if (confirmedToken !== null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-2xl"
            style={{ backgroundColor: `${accent}22`, color: accent }}
          >
            ✓
          </div>
          <h1 className="font-display text-2xl">
            {wasRequest ? "Request sent" : "You're booked!"}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {wasRequest ? (
              <>
                {data.shop.name} will review your request and confirm your time.
                {consent && phone.trim()
                  ? " We'll text you as soon as it's approved."
                  : " Save this page to check the status."}
              </>
            ) : (
              <>
                {data.shop.name} has your appointment.
                {consent && phone.trim()
                  ? " We'll text you a confirmation and a reminder."
                  : " Save this page to manage your appointment."}
              </>
            )}
          </p>
          <Link
            href={`/book/manage/${confirmedToken}`}
            className="mt-5 inline-block rounded-xl px-5 py-2.5 text-sm font-semibold"
            style={{ backgroundColor: accent, color: "#101012" }}
          >
            View / change my appointment
          </Link>

          {data.shop.payDirect && (
            <PayDirectInfo
              payDirect={data.shop.payDirect}
              shopName={data.shop.name}
              accent={accent}
            />
          )}
        </div>
      </main>
    );
  }

  // ---- Booking paused (lapsed shop) - honest notice instead of a flow that
  // would dead-end with a 403 at the final submit. ----
  if (data.shop.bookingPaused) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
          {data.shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.shop.logoUrl}
              alt={data.shop.name}
              className="mx-auto mb-3 h-14 w-14 rounded-full object-cover"
            />
          ) : null}
          <h1 className="font-display text-2xl">Online booking is paused</h1>
          <p className="mt-2 text-sm text-muted">
            {data.shop.name} isn&apos;t taking online bookings right now. Please
            contact the shop directly to book your next appointment.
          </p>
          {data.shop.waitlistEnabled && (
            <div className="mt-5 text-left">
              <WaitlistForm
                slug={data.shop.slug}
                shopName={data.shop.name}
                accent={accent}
              />
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-5 py-8 text-offwhite">
      {/* Barber-only "back to dashboard" (only when opened from the dashboard). */}
      <BackToDashboard
        fallbackHref="/dashboard/booking"
        className="mb-4 inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-muted transition-colors hover:text-offwhite"
      />

      <header className="mb-6 text-center">
        {data.shop.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.shop.logoUrl}
            alt={data.shop.name}
            className="mx-auto mb-3 h-16 w-16 rounded-full border border-white/10 bg-white/5 object-cover"
          />
        ) : null}
        <h1 className="font-display text-2xl tracking-tight">Book at {data.shop.name}</h1>
      </header>

      {/* Standing waitlist entry: available regardless of slot availability. */}
      {data.shop.waitlistEnabled && (
        <div className="mb-6">
          {waitlistMode === "standing" ? (
            <WaitlistForm
              slug={data.shop.slug}
              shopName={data.shop.name}
              accent={accent}
              onDone={() => setWaitlistMode(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setWaitlistMode("standing")}
              className="w-full rounded-xl border border-white/15 py-2.5 text-center text-xs font-medium text-muted transition-colors hover:text-offwhite"
            >
              Can’t find a time? Join the waitlist →
            </button>
          )}
        </div>
      )}

      {/* Step 1: service */}
      <Section
        title="1 · Choose a service"
        back={
          <Link
            href={`/s/${data.shop.slug}`}
            className="text-xs text-muted transition-colors hover:text-offwhite"
          >
            ← Back to {data.shop.name}
          </Link>
        }
      >
        <div className="flex flex-col gap-2">
          {data.services.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pickService(s.id)}
              className="flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors"
              style={{
                borderColor: serviceId === s.id ? accent : "rgba(255,255,255,0.12)",
                backgroundColor: serviceId === s.id ? `${accent}14` : "transparent",
              }}
            >
              <span>
                <span className="block text-sm font-medium">{s.name}</span>
                <span className="block text-xs text-muted">
                  {s.durationRange.min === s.durationRange.max
                    ? `${s.durationMin} min`
                    : `${s.durationRange.min}-${s.durationRange.max} min`}
                </span>
              </span>
              {priceLabel(s) && (
                <span className="text-sm text-muted">{priceLabel(s)}</span>
              )}
            </button>
          ))}
          {data.services.length === 0 && (
            <p className="text-sm text-muted">No services available yet.</p>
          )}
        </div>
      </Section>

      {/* Step 2: provider */}
      {serviceId && (
        <Section
          title="2 · Choose your provider"
          back={<BackStep onClick={backToService} />}
        >
          <div className="flex flex-col gap-2">
            {staffForService.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pickStaff(s.id)}
                className="flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors"
                style={{
                  borderColor: staffId === s.id ? accent : "rgba(255,255,255,0.12)",
                  backgroundColor: staffId === s.id ? `${accent}14` : "transparent",
                }}
              >
                {s.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.imageUrl} alt={s.name} className="h-9 w-9 rounded-full object-cover" />
                ) : (
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold"
                    style={{ backgroundColor: `${accent}22`, color: accent }}
                  >
                    {s.name.charAt(0)}
                  </span>
                )}
                <span className="text-sm font-medium">{s.name}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Step 3: day + slot */}
      {serviceId && staffId && (
        <Section
          title="3 · Pick a time"
          back={<BackStep onClick={backToProvider} />}
        >
          {loadingSlots ? (
            <p className="text-sm text-muted">Loading available times…</p>
          ) : days.length === 0 ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">
                No open times in the next {data.shop.bookingMaxDays} days. Try
                another provider{data.shop.waitlistEnabled ? " — or join the waitlist" : ""}.
              </p>
              {data.shop.waitlistEnabled &&
                (waitlistMode === "slot" ? (
                  <WaitlistForm
                    slug={data.shop.slug}
                    shopName={data.shop.name}
                    accent={accent}
                    serviceId={serviceId ?? undefined}
                    staffId={staffId ?? undefined}
                    serviceLabel={selectedService?.name}
                    onDone={() => setWaitlistMode(null)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setWaitlistMode("slot")}
                    className="w-full rounded-xl border py-3 text-center text-sm font-semibold transition-colors"
                    style={{ borderColor: accent, color: accent }}
                  >
                    Join the waitlist
                  </button>
                ))}
            </div>
          ) : (
            <>
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                {days.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => {
                      setDay(d);
                      clearSlotPick();
                    }}
                    className="shrink-0 rounded-lg border px-3 py-2 text-xs transition-colors"
                    style={{
                      borderColor: day === d ? accent : "rgba(255,255,255,0.12)",
                      backgroundColor: day === d ? `${accent}14` : "transparent",
                    }}
                  >
                    {/* Label from the first slot's real instant (correct in the
                        shop tz) - never synthesize a date from the key string,
                        which would be parsed in the viewer's local zone. */}
                    {dateFmt.format(new Date((slotsByDay.get(d) ?? [])[0]?.startsAt ?? d))}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {daySlots.map((s) => {
                  const picked =
                    slot === s.startsAt &&
                    (slotTargeted?.id ?? null) === (s.targeted?.id ?? null);
                  return (
                    <button
                      key={s.targeted?.id ?? s.startsAt}
                      type="button"
                      onClick={() => {
                        setSlot(s.startsAt);
                        setSlotTargeted(s.targeted ?? null);
                        if (s.targeted) setAddOnIds([]); // fixed length/price
                      }}
                      className="rounded-lg border py-2 text-center text-sm transition-colors"
                      style={{
                        borderColor: picked
                          ? accent
                          : s.targeted
                            ? `${accent}99`
                            : "rgba(255,255,255,0.12)",
                        backgroundColor: picked
                          ? accent
                          : s.targeted
                            ? `${accent}14`
                            : "transparent",
                        color: picked ? "#101012" : undefined,
                      }}
                    >
                      {timeFmt.format(new Date(s.startsAt))}
                      {s.targeted && (
                        <span className="block text-[10px] font-semibold">
                          {s.targeted.label || "Special"} · $
                          {s.targeted.price.toFixed(0)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </Section>
      )}

      {/* Step 4: contact + consent */}
      {slot && (
        <Section
          title="4 · Your details"
          back={<BackStep onClick={backToTime} />}
        >
          {/* Optional add-ons for the chosen service (a targeted slot's
              length/price are fixed, so add-ons don't apply there). */}
          {!slotTargeted && addOnsForService.length > 0 && (
            <div className="mb-3 rounded-xl border border-white/10 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide opacity-60">
                Add-ons
              </p>
              <div className="flex flex-col gap-1.5">
                {addOnsForService.map((a) => {
                  const on = addOnIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAddOn(a.id)}
                      className="flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors"
                      style={{
                        borderColor: on ? accent : "rgba(255,255,255,0.1)",
                        backgroundColor: on ? `${accent}14` : "transparent",
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="flex h-4 w-4 items-center justify-center rounded border text-[10px]"
                          style={{ borderColor: on ? accent : "rgba(255,255,255,0.3)", color: accent }}
                        >
                          {on ? "✓" : ""}
                        </span>
                        <span>
                          {a.name}
                          {a.durationMin > 0 && (
                            <span className="opacity-50"> · +{a.durationMin} min</span>
                          )}
                        </span>
                      </span>
                      {a.price != null && a.price > 0 && (
                        <span className="opacity-80">+${a.price.toFixed(0)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {grandTotal !== null && (
            <div
              className="mb-3 flex items-center justify-between rounded-xl px-4 py-3 text-sm"
              style={{ backgroundColor: `${accent}14`, color: accent }}
            >
              <span>
                {selectedService?.name}
                {addOnIds.length > 0 && ` + ${addOnIds.length} add-on${addOnIds.length > 1 ? "s" : ""}`}
              </span>
              <span className="font-semibold">${grandTotal.toFixed(0)}</span>
            </div>
          )}
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              <input
                className={input}
                placeholder="First name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                aria-label="First name"
              />
              <input
                className={input}
                placeholder="Last name (optional)"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                aria-label="Last name"
              />
            </div>
            <input
              className={input}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="Mobile number"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-label="Mobile number"
            />
            <input
              className={input}
              type="email"
              autoComplete="email"
              placeholder="Email (optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Email"
            />
            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
              />
              {/* A2P 10DLC CTA: this label must stay IDENTICAL to the facsimile
                  on /sms-consent and to the text registered in the campaign
                  (brand + shop named, frequency, rates, HELP/STOP, not-a-
                  condition, linked SMS Terms + Privacy). Carriers verify all
                  three match - see the 30909 rejection that taught us this. */}
              <span>
                Text me appointment confirmations, reminders, and rewards
                updates from {data.shop.name} via ChairBack (a few messages per
                visit). Msg &amp; data rates may apply. Reply HELP for help,
                STOP to opt out. Consent is not a condition of purchase. See
                our{" "}
                <Link
                  href="/sms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  SMS Terms
                </Link>{" "}
                and{" "}
                <Link
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Privacy Policy
                </Link>
                .
              </span>
            </label>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className={primaryBtn}
              style={{ backgroundColor: accent, color: "#101012" }}
            >
              {pending ? "Booking…" : "Confirm booking"}
            </button>
          </div>
        </Section>
      )}

      {error && !slot && <p className="mt-3 text-center text-xs text-red-400">{error}</p>}
    </main>
  );
}

function Section({
  title,
  children,
  back,
}: {
  title: string;
  children: React.ReactNode;
  /** Optional back affordance rendered on the title row (a button or link). */
  back?: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {back}
      </div>
      {children}
    </section>
  );
}

/** A small "← Back" affordance for stepping back a stage in the booking wizard. */
function BackStep({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-muted transition-colors hover:text-offwhite"
    >
      ← Back
    </button>
  );
}

/**
 * Fee-free "pay the barber directly" block on the confirmation screen. Lists the
 * shop's Zelle/Venmo/Cash App handles (tap to copy). Display-only — the shop
 * confirms payment themselves; we never claim ChairBack processed it.
 */
function PayDirectInfo({
  payDirect,
  shopName,
  accent,
}: {
  payDirect: NonNullable<BookShopData["shop"]["payDirect"]>;
  shopName: string;
  accent: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const rows = [
    payDirect.zelle ? { label: "Zelle", value: payDirect.zelle } : null,
    payDirect.venmo ? { label: "Venmo", value: `@${payDirect.venmo}` } : null,
    payDirect.cashApp ? { label: "Cash App", value: `$${payDirect.cashApp}` } : null,
  ].filter((r): r is { label: string; value: string } => r !== null);

  if (rows.length === 0 && !payDirect.note) return null;

  function copy(value: string) {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(value);
        setTimeout(() => setCopied(null), 1500);
      },
      () => {},
    );
  }

  return (
    <div className="mt-5 rounded-xl border border-white/10 bg-white/5 p-4 text-left">
      <p className="text-sm font-semibold">Pay {shopName} directly — no fees</p>
      {rows.map((r) => (
        <button
          key={r.label}
          type="button"
          onClick={() => copy(r.value)}
          className="mt-2 flex w-full items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-sm transition-colors hover:bg-white/5"
        >
          <span className="text-muted">{r.label}</span>
          <span className="flex items-center gap-2 font-medium" style={{ color: accent }}>
            {r.value}
            <span className="text-[11px] text-muted">
              {copied === r.value ? "copied!" : "tap to copy"}
            </span>
          </span>
        </button>
      ))}
      {payDirect.note && (
        <p className="mt-2 text-xs text-muted">{payDirect.note}</p>
      )}
    </div>
  );
}
