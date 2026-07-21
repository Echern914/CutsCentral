"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { DEMO } from "@chairback/config/demo";
import { BackToDashboard } from "@/components/BackToDashboard";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { DemoTour } from "@/components/tour/DemoTour";
import { useDemoTour } from "@/components/tour/state";
import type { BookShopData } from "./page";
import { readableOn } from "@/lib/contrast";
import {
  bookAction,
  getMergedSlotsAction,
  type MergedSlotsResult,
} from "./actions";
import { PaymentStep } from "./PaymentStep";
import { WaitlistForm } from "./WaitlistForm";

/**
 * Public native booking picker: pick service -> barber -> day -> open slot ->
 * enter contact + SMS consent -> confirm. Slots come from the server action
 * (CSP blocks a direct browser fetch); the create action returns a manage token
 * so we can link the customer to cancel/reschedule. Accent-themed to the shop.
 */
/** One selectable time in the calendar grid, with who can serve it. */
interface DaySlot {
  startsAt: string;
  // Staff free at this instant (from the merged fetch); one for single-barber.
  staffIds: string[];
  // Present when this is a barber-published targeted "special" slot.
  targeted?: { id: string; price: number; label: string | null };
}

// ---- Calendar date math. All operate on shop-local "YYYY-MM-DD" / "YYYY-MM"
// strings so there is NO Date parsing in the viewer's zone (which would drift a
// day near midnight). We only construct a UTC Date to walk the grid, then read
// it back with getUTCFullYear/Month/Date — never a local getter.

/** "YYYY-MM" month key for a "YYYY-MM-DD" day (or ISO — first 7 chars). */
function monthKey(dayOrIso: string): string {
  return dayOrIso.slice(0, 7);
}

/** First day ("YYYY-MM-01") of a "YYYY-MM" month. */
function monthFirstDay(month: string): string {
  return `${month}-01`;
}

/** Shift a "YYYY-MM" month by ±n months, returning a new "YYYY-MM". */
function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  return `${ny}-${String(nm + 1).padStart(2, "0")}`;
}

/** Human month label, e.g. "July 2026", from a "YYYY-MM". */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * The 6-week grid (42 cells, Sun-first) covering a "YYYY-MM" month. Each cell is
 * a "YYYY-MM-DD" day; leading/trailing cells spill into the adjacent months so
 * the weekday columns line up. Built with UTC so it never depends on the
 * viewer's timezone.
 */
function monthGrid(month: string): { day: string; inMonth: boolean }[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const startWeekday = first.getUTCDay(); // 0=Sun
  const cells: { day: string; inMonth: boolean }[] = [];
  const gridStart = new Date(first);
  gridStart.setUTCDate(1 - startWeekday); // back up to the Sunday of week 1
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate(),
    ).padStart(2, "0")}`;
    cells.push({ day: key, inMonth: d.getUTCMonth() === m - 1 });
  }
  return cells;
}

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

export function BookingClient({ data }: { data: BookShopData }) {
  // Clear the native app's WebView spinner (reachable from the shop page's Book
  // CTA inside the app; the shell may be waiting on this ready signal).
  useSignalNativeReady();

  const accent = data.shop.accentColor || "#D4AF37";
  // Text painted ON the accent must actually read against it — shops pick
  // arbitrary accents, so a hardcoded near-black fails WCAG on dark ones.
  const onAccent = readableOn(accent);
  const tz = data.shop.timezone;

  const [serviceId, setServiceId] = useState<string | null>(null);
  // The provider the slots were loaded for. For a MULTI-barber shop this is the
  // barber the customer explicitly chose. For a SINGLE-barber shop the provider
  // step is skipped and this is set implicitly to that lone barber.
  const [staffId, setStaffId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null); // YYYY-MM-DD (local)
  const [slot, setSlot] = useState<string | null>(null); // ISO startsAt
  // The concrete barber to WRITE the booking against. When the provider step is
  // skipped, several barbers may be free at the chosen instant; this is the one
  // we picked for the create POST (chosen when the slot is selected).
  const [pickedStaffId, setPickedStaffId] = useState<string | null>(null);
  // Set when the chosen slot is a barber-published TARGETED slot (fixed price,
  // no add-ons); its id goes on the booking POST so the server claims it.
  const [slotTargeted, setSlotTargeted] = useState<{
    id: string;
    price: number;
    label: string | null;
  } | null>(null);
  const [slotsByDay, setSlotsByDay] = useState<Map<string, DaySlot[]>>(new Map());
  const [loadingSlots, setLoadingSlots] = useState(false);
  // Which calendar month is on screen (first-of-month YYYY-MM-DD, shop tz).
  const [viewMonth, setViewMonth] = useState<string | null>(null);

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

  // Move screen-reader/keyboard focus onto the heading when the wizard swaps to
  // the payment or confirmation screen (a full-content replacement is otherwise
  // silent to assistive tech).
  const paymentHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmHeadingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (confirmedToken !== null) confirmHeadingRef.current?.focus();
    else if (paymentSecret !== null) paymentHeadingRef.current?.focus();
  }, [confirmedToken, paymentSecret]);

  // ---- Guided demo-tour mode (demo tenant only). While the tour runs, this
  // wizard never writes: submit() short-circuits to the seeded showcase
  // appointment's confirmation, and reaching the confirmation STEP forces that
  // same state. The wizard is also auto-driven (service/provider/slot picked,
  // contact prefilled) so every tour anchor exists without the viewer having
  // to fill a form — while staying fully interactive to play with.
  const { stepId: tourStepId } = useDemoTour();
  const demoTour = tourStepId !== null && data.shop.slug === DEMO.SHOP_SLUG;
  const autoDrove = useRef(false);
  useEffect(() => {
    if (!demoTour || autoDrove.current) return;
    autoDrove.current = true;
    setFirstName((cur) => cur || "Jordan");
    setLastName((cur) => cur || "D.");
    setEmail((cur) => cur || "jordan@example.com");
    if (!serviceId && data.services.length > 0) {
      const svc = data.services[0]!;
      const svcStaff = data.offerings
        .filter((o) => o.serviceId === svc.id)
        .map((o) => o.staffId);
      const stf = data.staff.find((s) => svcStaff.includes(s.id));
      pickService(svc.id);
      // pickService already auto-loads a single-barber service's calendar; only
      // force the staff + fetch when it did NOT (a multi-barber demo service),
      // so the tour still lands on a loaded calendar without a double fetch.
      if (stf && svcStaff.length > 1) {
        setStaffId(stf.id);
        loadSlots(svc.id, [stf.id]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoTour]);
  // Once slots load, land on a day that shows a targeted "special" slot (so the
  // tour's badge step has one in view) and pre-pick a normal time.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!demoTour || autoPicked.current || slot !== null || slotsByDay.size === 0) return;
    autoPicked.current = true;
    const sorted = [...slotsByDay.keys()].sort();
    const specialDay = sorted.find((d) => (slotsByDay.get(d) ?? []).some((s) => s.targeted));
    const d = specialDay ?? sorted[0]!;
    setDay(d);
    const options = slotsByDay.get(d) ?? [];
    const first = options.find((s) => !s.targeted) ?? options[0];
    if (first) {
      setSlot(first.startsAt);
      setSlotTargeted(first.targeted ?? null);
      setPickedStaffId(first.staffIds[0] ?? null);
      setViewMonth(monthKey(d));
    }
  }, [demoTour, slot, slotsByDay]);
  // The tour's confirmation step forces the confirmation screen (and stepping
  // Back from it restores the wizard). Only ever toggles the DEMO token, so a
  // real booking's confirmation can never be undone by tour navigation.
  useEffect(() => {
    if (!demoTour) return;
    if (tourStepId === "book-confirmation" && confirmedToken === null) {
      setWasRequest(false);
      setConfirmedToken(DEMO.MANAGE_TOKEN);
    } else if (tourStepId !== "book-confirmation" && confirmedToken === DEMO.MANAGE_TOKEN) {
      setConfirmedToken(null);
    }
  }, [demoTour, tourStepId, confirmedToken]);

  // Which staff offer the chosen service, and which services a chosen staff offers.
  const staffForService = useMemo(() => {
    if (!serviceId) return data.staff;
    const ids = new Set(
      data.offerings.filter((o) => o.serviceId === serviceId).map((o) => o.staffId),
    );
    return data.staff.filter((s) => ids.has(s.id));
  }, [serviceId, data]);

  // Does the CHOSEN service have more than one barber? If so we keep the
  // "Choose your provider" step; a single-barber service skips it and jumps
  // straight to the calendar (loaded for that lone barber in pickService).
  const isMultiBarber = serviceId !== null && staffForService.length > 1;
  // The time step is step 2 when provider is skipped, step 3 otherwise.
  const timeStepNo = isMultiBarber ? 3 : 2;
  const detailsStepNo = isMultiBarber ? 4 : 3;

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

  /** Clear the chosen time (and any targeted-slot / picked-barber riding on it). */
  function clearSlotPick() {
    setSlot(null);
    setSlotTargeted(null);
    setPickedStaffId(null);
  }

  /**
   * Load availability for a service across the given barbers, merged into one
   * calendar. `staffPool` is the lone barber for a single-barber shop, or the
   * one the customer chose for a multi-barber shop.
   */
  function loadSlots(svc: string, staffPool: string[]) {
    setLoadingSlots(true);
    setError(null);
    const from = new Date().toISOString();
    const to = new Date(
      Date.now() + data.shop.bookingMaxDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    startTransition(async () => {
      const res = await getMergedSlotsAction(data.shop.slug, staffPool, svc, from, to);
      if (!res.ok || !res.data) {
        setError("Couldn't load times. Please try again.");
        setLoadingSlots(false);
        return;
      }
      bucketSlots(res.data, svc, staffPool);
      setLoadingSlots(false);
    });
  }

  function bucketSlots(result: MergedSlotsResult, svc: string, staffPool: string[]) {
    const map = new Map<string, DaySlot[]>();
    for (const s of result.slots) {
      const key = dayKey(s.startsAt);
      const list = map.get(key) ?? [];
      list.push({ startsAt: s.startsAt, staffIds: s.staffIds });
      map.set(key, list);
    }
    // Merge in the barbers' targeted slots for this service (only those from a
    // barber in the loaded pool), badged with their own price. The normal engine
    // never offers these times - it blocks around them - so no duplicates.
    const pool = new Set(staffPool);
    for (const t of data.targetedSlots) {
      if (t.serviceId !== svc || !pool.has(t.staffId)) continue;
      if (new Date(t.startsAt).getTime() <= Date.now()) continue;
      const key = dayKey(t.startsAt);
      const list = map.get(key) ?? [];
      list.push({
        startsAt: t.startsAt,
        staffIds: [t.staffId],
        targeted: { id: t.id, price: t.price, label: t.label },
      });
      list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      map.set(key, list);
    }
    setSlotsByDay(map);
    // Land on the first day with availability, and open its month in the calendar.
    const firstDay = [...map.keys()].sort()[0] ?? null;
    setDay(firstDay);
    setViewMonth(firstDay ? monthKey(firstDay) : monthKey(dayKey(new Date().toISOString())));
    clearSlotPick();
  }

  /** Barbers who offer a given service (used to decide skip-provider + pool). */
  function staffPoolFor(svc: string): string[] {
    const ids = new Set(
      data.offerings.filter((o) => o.serviceId === svc).map((o) => o.staffId),
    );
    return data.staff.filter((s) => ids.has(s.id)).map((s) => s.id);
  }

  function pickService(id: string) {
    setServiceId(id);
    setStaffId(null);
    setSlotsByDay(new Map());
    setDay(null);
    setViewMonth(null);
    clearSlotPick();
    setAddOnIds([]); // add-ons are per-service; clear on change
    // Single-barber shop: skip the provider step and go straight to the
    // calendar (loaded for that lone barber). Multi-barber shops still choose.
    const pool = staffPoolFor(id);
    if (pool.length === 1) {
      setStaffId(pool[0]!);
      loadSlots(id, pool);
    }
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
    // Multi-barber shop: load just the chosen barber's calendar.
    if (serviceId) loadSlots(serviceId, [id]);
  }

  // ---- Step-back navigation (customer stepping back a stage). Each clears the
  // state that gates the current step, collapsing the wizard to the prior one.
  function backToService() {
    setServiceId(null);
    setStaffId(null);
    setSlotsByDay(new Map());
    setDay(null);
    setViewMonth(null);
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
    // The barber to write against: the one bound to the chosen slot (may differ
    // from `staffId` when the provider step was skipped and several were free).
    const writeStaffId = pickedStaffId ?? staffId;
    if (!serviceId || !writeStaffId || !slot) return;
    // Demo tour: show the REAL confirmation screen with zero writes — the
    // manage link points at the seeded showcase appointment.
    if (demoTour) {
      setWasRequest(false);
      setConfirmedToken(DEMO.MANAGE_TOKEN);
      return;
    }
    startTransition(async () => {
      const res = await bookAction(data.shop.slug, {
        staffId: writeStaffId,
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
          // Refresh availability so the taken slot disappears (reload the same
          // pool the calendar was loaded with — the lone barber, or the chosen).
          if (serviceId && staffId) loadSlots(serviceId, [staffId]);
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

  // Set of days (YYYY-MM-DD) that actually have open times — the calendar makes
  // exactly these tappable and dims the rest.
  const availableDays = useMemo(() => new Set(slotsByDay.keys()), [slotsByDay]);

  // The earliest open time across all loaded days (for the "soonest" button).
  // Slots within a day are already time-sorted; the first day is the earliest.
  const soonest = useMemo(() => {
    const firstDay = [...slotsByDay.keys()].sort()[0];
    if (!firstDay) return null;
    const first = (slotsByDay.get(firstDay) ?? [])[0];
    return first ? { day: firstDay, slot: first } : null;
  }, [slotsByDay]);

  /** Jump straight to the earliest open time (day + slot in one tap). */
  function pickSoonest() {
    if (!soonest) return;
    setDay(soonest.day);
    setViewMonth(monthKey(soonest.day));
    setSlot(soonest.slot.startsAt);
    setSlotTargeted(soonest.slot.targeted ?? null);
    setPickedStaffId(soonest.slot.staffIds[0] ?? null);
    if (soonest.slot.targeted) setAddOnIds([]);
  }

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
  // No focus:outline-none — the global :focus-visible ring must stay visible
  // for keyboard users (WCAG 2.4.7); the border tint alone is too weak.
  const input =
    "w-full rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-offwhite placeholder:text-muted focus:border-white/40";

  // ---- Payment screen (pay-ahead: booking created, collect card/Apple Pay) ----
  if (paymentSecret !== null && confirmedToken === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <h1 ref={paymentHeadingRef} tabIndex={-1} className="font-display text-2xl outline-none">
            Pay to confirm
          </h1>
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
        {data.shop.slug === DEMO.SHOP_SLUG && <DemoTour route="book" />}
        {/* data-tour: keep in sync with packages/config/src/demoTour.ts */}
        <div
          className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center"
          data-tour="confirmation"
        >
          <div
            aria-hidden="true"
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-2xl"
            style={{ backgroundColor: `${accent}22`, color: accent }}
          >
            ✓
          </div>
          <h1 ref={confirmHeadingRef} tabIndex={-1} className="font-display text-2xl outline-none">
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
            style={{ backgroundColor: accent, color: onAccent }}
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
      {/* Guided client-experience tour — demo tenant only. Step anchors are the
          data-tour attributes below (keep in sync with
          packages/config/src/demoTour.ts). */}
      {data.shop.slug === DEMO.SHOP_SLUG && <DemoTour route="book" />}
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
        <div className="mb-6" data-tour="waitlist">
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
        tour="services"
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
              aria-pressed={serviceId === s.id}
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

      {/* Step 2: provider — only for services offered by more than one barber.
          A single-barber service skips this and lands on the calendar. */}
      {serviceId && isMultiBarber && (
        <Section
          title="2 · Choose your provider"
          back={<BackStep onClick={backToService} />}
          focusOnMount={!demoTour}
        >
          <div className="flex flex-col gap-2">
            {staffForService.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => pickStaff(s.id)}
                aria-pressed={staffId === s.id}
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

      {/* Time step: calendar + slot. Numbered 3 for multi-barber shops (after
          provider) or 2 when the provider step was skipped. Back goes to the
          provider step if there was one, else back to the service list. */}
      {serviceId && staffId && (
        <Section
          title={`${timeStepNo} · Pick a time`}
          tour="slots"
          back={
            <BackStep onClick={isMultiBarber ? backToProvider : backToService} />
          }
          focusOnMount={!demoTour}
        >
          {loadingSlots ? (
            <p role="status" className="text-sm text-muted">
              Loading available times…
            </p>
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
              {/* Soonest-available shortcut: one tap to the earliest open time. */}
              {soonest && (
                <button
                  type="button"
                  onClick={pickSoonest}
                  className="mb-3 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors"
                  style={{
                    borderColor:
                      slot === soonest.slot.startsAt ? accent : `${accent}66`,
                    backgroundColor: `${accent}14`,
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" style={{ color: accent }}>
                      ⚡
                    </span>
                    <span>
                      <span className="block text-xs uppercase tracking-wide text-muted">
                        Soonest available
                      </span>
                      <span className="block text-sm font-semibold">
                        {dateFmt.format(new Date(soonest.slot.startsAt))} ·{" "}
                        {timeFmt.format(new Date(soonest.slot.startsAt))}
                      </span>
                    </span>
                  </span>
                  <span
                    className="text-xs font-semibold"
                    style={{ color: accent }}
                  >
                    Book it →
                  </span>
                </button>
              )}

              {/* Monthly calendar: only days with open times are tappable. */}
              <MonthCalendar
                viewMonth={viewMonth ?? monthKey(days[0]!)}
                availableDays={availableDays}
                selectedDay={day}
                accent={accent}
                onAccent={onAccent}
                onPrevMonth={() => setViewMonth((m) => addMonths(m ?? monthKey(days[0]!), -1))}
                onNextMonth={() => setViewMonth((m) => addMonths(m ?? monthKey(days[0]!), 1))}
                onPickDay={(d) => {
                  setDay(d);
                  clearSlotPick();
                }}
              />

              {/* Times for the selected day. */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                {daySlots.length === 0 && (
                  <p className="col-span-3 text-sm text-muted">
                    Pick a highlighted day to see open times.
                  </p>
                )}
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
                        // Bind the barber who will actually take this booking
                        // (several may be free at this instant on a merged fetch).
                        setPickedStaffId(s.staffIds[0] ?? null);
                        if (s.targeted) setAddOnIds([]); // fixed length/price
                      }}
                      aria-pressed={picked}
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
                        color: picked ? onAccent : undefined,
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

      {/* Details step: contact + consent. Numbered after the time step. */}
      {slot && (
        <Section
          title={`${detailsStepNo} · Your details`}
          back={<BackStep onClick={backToTime} />}
          focusOnMount={!demoTour}
        >
          {/* Optional add-ons for the chosen service (a targeted slot's
              length/price are fixed, so add-ons don't apply there). */}
          {!slotTargeted && addOnsForService.length > 0 && (
            <div className="mb-3 rounded-xl border border-white/10 p-3" data-tour="addons">
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
                      aria-pressed={on}
                      className="flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors"
                      style={{
                        borderColor: on ? accent : "rgba(255,255,255,0.1)",
                        backgroundColor: on ? `${accent}14` : "transparent",
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
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
          <div className="flex flex-col gap-3" data-tour="checkout">
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
            {error && (
              <p role="alert" className="text-xs text-red-400">
                {error}
              </p>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              aria-busy={pending}
              className={primaryBtn}
              style={{ backgroundColor: accent, color: onAccent }}
            >
              {pending ? "Booking…" : "Confirm booking"}
            </button>
          </div>
        </Section>
      )}

      {error && !slot && (
        <p role="alert" className="mt-3 text-center text-xs text-red-400">
          {error}
        </p>
      )}
    </main>
  );
}

function Section({
  title,
  children,
  back,
  tour,
  focusOnMount,
}: {
  title: string;
  children: React.ReactNode;
  /** Optional back affordance rendered on the title row (a button or link). */
  back?: React.ReactNode;
  /** Optional demo-tour anchor (a data-tour attribute on the section). */
  tour?: string;
  /**
   * Steps 2-4 mount mid-flow as the customer progresses; without a focus move
   * the new step is invisible to keyboard/screen-reader users (WCAG 2.4.3).
   */
  focusOnMount?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
    // Mount-only: refocusing on re-render would steal focus from the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="mb-5" data-tour={tour}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2
          ref={headingRef}
          tabIndex={focusOnMount ? -1 : undefined}
          className="text-xs font-semibold uppercase tracking-wide text-muted outline-none"
        >
          {title}
        </h2>
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
 * Monthly availability calendar. Renders a Sun-first month grid; only days in
 * `availableDays` are tappable (they have open times), every other cell is
 * dimmed and inert. The customer pages between months with the arrows. Prev is
 * disabled once we reach the current month (nothing bookable in the past).
 *
 * All dates are shop-local "YYYY-MM-DD" strings and the grid is built in UTC
 * (see monthGrid) so the highlighted day never drifts by the viewer's timezone.
 * "Today" is computed from the shop-tz day key the parent passes via
 * availableDays' domain; here we only need month-vs-month comparison, done on
 * the "YYYY-MM" strings.
 */
function MonthCalendar({
  viewMonth,
  availableDays,
  selectedDay,
  accent,
  onAccent,
  onPrevMonth,
  onNextMonth,
  onPickDay,
}: {
  viewMonth: string; // "YYYY-MM"
  availableDays: Set<string>; // "YYYY-MM-DD" keys with open times
  selectedDay: string | null;
  accent: string;
  onAccent: string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onPickDay: (day: string) => void;
}) {
  const cells = monthGrid(viewMonth);
  // The earliest available day fixes the floor: never let the customer page to
  // a month before the first month that has any availability.
  const firstAvailableMonth =
    [...availableDays].sort()[0]?.slice(0, 7) ?? viewMonth;
  const atFloor = viewMonth <= firstAvailableMonth;

  return (
    <div className="rounded-xl border border-white/10 p-3">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={onPrevMonth}
          disabled={atFloor}
          aria-label="Previous month"
          className="rounded-lg px-2 py-1 text-sm text-muted transition-colors hover:text-offwhite disabled:opacity-30"
        >
          ←
        </button>
        <span className="text-sm font-semibold">{monthLabel(viewMonth)}</span>
        <button
          type="button"
          onClick={onNextMonth}
          aria-label="Next month"
          className="rounded-lg px-2 py-1 text-sm text-muted transition-colors hover:text-offwhite"
        >
          →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAY_LABELS.map((w, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="py-1 text-[10px] font-semibold uppercase text-muted"
          >
            {w}
          </span>
        ))}
        {cells.map(({ day, inMonth }) => {
          const dayNum = Number(day.slice(8, 10));
          const open = availableDays.has(day);
          const selected = selectedDay === day;
          if (!inMonth) {
            // Spill-over cell from an adjacent month: keep the grid aligned but
            // render nothing tappable.
            return <span key={day} aria-hidden="true" />;
          }
          return (
            <button
              key={day}
              type="button"
              disabled={!open}
              onClick={() => onPickDay(day)}
              aria-pressed={selected}
              aria-label={`${day}${open ? "" : " (no openings)"}`}
              className="flex aspect-square items-center justify-center rounded-lg border text-sm transition-colors disabled:cursor-default"
              style={{
                borderColor: selected
                  ? accent
                  : open
                    ? `${accent}55`
                    : "transparent",
                backgroundColor: selected
                  ? accent
                  : open
                    ? `${accent}14`
                    : "transparent",
                color: selected
                  ? onAccent
                  : open
                    ? undefined
                    : "rgba(255,255,255,0.25)",
              }}
            >
              {dayNum}
            </button>
          );
        })}
      </div>
    </div>
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
            <span role="status" className="text-[11px] text-muted">
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
