"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Dialog } from "@/components/ui/Dialog";
import { chip, Field, FormFooter, Group, INPUT } from "./formkit";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { addOnOffersService } from "@chairback/config/addOns";
import type { AddOnRow, ServiceRow, StaffRow } from "./page";
import {
  createAppointmentAction,
  getDashSlotsAction,
  getDaySpecialsAction,
  searchClientsAction,
  type ClientOption,
  type DashSlot,
  type DaySpecial,
} from "./actions";
import { ExternalBlockBanner, type BlockConflict } from "./ExternalBlockBanner";
import { shopLocalInputValue } from "./shopLocalInput";
import { formatPrice, parsePrice } from "@/lib/serviceFields";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "New appointment" (native booking), in the SAME chrome as the appointment
 * sheet: ui/Dialog for the shell (focus trap, keyboard-aware viewport, sticky
 * footer), formkit's cards for the body. Service → add-ons → provider → time →
 * client → note → repeat, then one solid-brass Schedule in the footer that can never
 * scroll below the fold. Times come from the real slot engine; "Custom time"
 * forces a time outside computed availability. If a time - custom, or a slot
 * someone took while he looked - overlaps another booking, a synced visit or
 * one of his own specials, the API names them IN THIS DIALOG and he can "Book
 * anyway": one more tap answers "This overlaps Marcus R. at 10:00 AM. Book it
 * anyway?", and only that yes books it (see OverlapError). A customer's live
 * hold is named but never offered. Prefills the date + hour tapped in the
 * calendar, and the Custom time picker opens on that same day.
 *
 * 🔴 SPECIALS are listed above the regular times. The grid subtracts every open
 * special on purpose (each is sold at its own price), and Custom time only
 * lands on one after "Book anyway" (which takes it off sale) - so before this
 * list the only way to fill a special AT ITS PRICE was
 * a customer on the website. Picking one sends its id, and the server claims it
 * exactly as the website does, at the special's own length and price.
 *
 * ADD-ONS: once a service is picked, the add-ons offered with it are listed,
 * unticked (the rule is `addOnOffersService`, the one the API charges by).
 * Ticking one shows the new total and length, and re-asks for open times with
 * it - so a time long enough for a haircut but not haircut + beard is not
 * offered, exactly as the booking itself would refuse it. A special has its
 * own length and price, and a repeating series takes none, so neither carries
 * add-ons.
 *
 * ANY TIME, AT HIS PRICE. A barber whose client wanted 10 PM - after his hours
 * - tapped the 10 PM row and got a list that did not have 10 PM on it, with
 * Custom time as small print ("I can't book it after hours"). So an hour he
 * TAPPED that is not an open time is offered as itself ("Book this time"), and
 * Custom time takes a price: his after-hours rate instead of the menu's.
 */
export function AppointmentForm({
  staff,
  services,
  addOns = [],
  timezone,
  prefillISO,
  tapped = false,
  waitlist,
  onClose,
  onCreated,
  toast,
}: {
  staff: StaffRow[];
  services: ServiceRow[];
  /** The shop's add-ons, as the booking page loads them (inactive ones too). */
  addOns?: AddOnRow[];
  timezone: string;
  /** ISO instant of the tapped hour, prefills date + time. */
  prefillISO: string;
  /**
   * The barber tapped that hour's row on the calendar, so it is the time he
   * means - not the "+ New appointment" button's default start. When it is not
   * an open time, the form offers it as one tap.
   */
  tapped?: boolean;
  /**
   * Booking someone straight off the waitlist (phase E). Prefills who/what/
   * which chair, shows what they actually asked for, and carries `entryId`
   * into the create call so the entry flips to BOOKED and links to the new
   * appointment inside the SAME transaction.
   */
  waitlist?: {
    entryId: string;
    name: string;
    phone: string | null;
    email: string | null;
    serviceId: string | null;
    staffId: string | null;
    windowHint: string | null;
  };
  onClose: () => void;
  onCreated: () => void;
  toast: Toast;
}) {
  const activeServices = services.filter((s) => s.active);
  const activeStaff = staff.filter((s) => s.active);

  const [serviceId, setServiceId] = useState<string | null>(
    // A waitlist prefill wins over the single-option shortcut: it is what the
    // customer actually asked for.
    waitlist?.serviceId ??
      (activeServices.length === 1 ? activeServices[0]!.id : null),
  );
  const [staffId, setStaffId] = useState<string | null>(
    waitlist?.staffId ?? (activeStaff.length === 1 ? activeStaff[0]!.id : null),
  );
  const [startsAt, setStartsAt] = useState<string>(prefillISO);
  const [customTime, setCustomTime] = useState(false);
  // Custom time's price, as typed. Empty = the service's own price.
  const [priceText, setPriceText] = useState("");
  const [slots, setSlots] = useState<DashSlot[]>([]);
  // The DAY's specials, across every service - listed before a service is
  // picked, because the special comes first and picks its own service.
  const [specials, setSpecials] = useState<DaySpecial[]>([]);
  // Set only by tapping a special. A regular time, Custom time, or switching
  // to a service or provider the special is not offered under clears it - so
  // nothing is ever booked as a special, at a special's price, without the
  // barber having picked that special.
  const [targetedSlotId, setTargetedSlotId] = useState<string | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  // Ticked add-ons, in the order ticked. Cleared whenever the service changes
  // (add-ons belong to a service) and when a special is picked.
  const [addOnIds, setAddOnIds] = useState<string[]>([]);

  const [clientId, setClientId] = useState<string | null>(null);
  const [clientLabel, setClientLabel] = useState<string>("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientOption[]>([]);
  const [newName, setNewName] = useState(waitlist?.name ?? "");
  const [newPhone, setNewPhone] = useState(waitlist?.phone ?? "");
  const [note, setNote] = useState("");
  // Recurrence: off by default ("Does not repeat"). When on, every N weeks for
  // `count` times OR until a date. Weekly only to start (the picked day+time is
  // the pattern). See engines/recurringSeries.ts.
  const [repeat, setRepeat] = useState(false);
  const [everyWeeks, setEveryWeeks] = useState(1);
  // What each repeat box says is wrong with what is typed in it right now.
  const [repeatProblems, setRepeatProblems] = useState<{ weeks?: string | null; count?: string | null }>({});
  const [endMode, setEndMode] = useState<"count" | "until">("count");
  const [count, setCount] = useState(4);
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  /**
   * The API refused because the time is blocked in the barber's EXTERNAL
   * calendar (Acuity). Held separately from `error` because it is not a dead
   * end: the sentence names the block, and the barber may confirm booking over
   * it - which the API then records. Nothing is written until he does.
   */
  const [blockConflict, setBlockConflict] = useState<BlockConflict | null>(null);
  /**
   * The API refused because the time overlaps another booking, a synced visit
   * or one of the barber's own specials, and named them. Same banner as a
   * block - he sees the list, "Book anyway" asks the server's question, and
   * only "Yes" replays the confirmation bound to exactly those rows. Also
   * holds a customer's LIVE HOLD refusal, with no confirmation (nothing to
   * answer - only another time).
   */
  const [overlapConflict, setOverlapConflict] = useState<BlockConflict | null>(null);
  // The overlap he already said yes to, carried on the retry that follows - so
  // confirming an overlap and THEN an Acuity block sends both answers. Forgotten
  // the moment the time, service or provider changes (a different question).
  const acceptedOverlap = useRef<string | null>(null);
  const [pending, start] = useTransition();

  const selectedService = activeServices.find((s) => s.id === serviceId) ?? null;
  // The ticked add-ons as one value, so an effect can depend on the CHOICE
  // rather than on an array's identity.
  const addOnKey = addOnIds.join(",");

  // A "Book anyway" answered ONE question: this time, this service, this chair,
  // this length.
  useEffect(() => {
    acceptedOverlap.current = null;
    setOverlapConflict(null);
  }, [startsAt, serviceId, staffId, customTime, addOnKey]);

  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
    [timezone],
  );
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }),
    [timezone],
  );
  // The shop-tz calendar day of the prefill, for the slots window.
  const dayKey = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(prefillISO)),
    [prefillISO, timezone],
  );

  // Only times on the tapped calendar day (shop tz).
  const onDay = useMemo(() => {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return (iso: string) => fmt.format(new Date(iso)) === dayKey;
  }, [timezone, dayKey]);
  // The window both lists fetch: the WHOLE shop-local day, whatever hour was
  // tapped, with an hour's slack each side (a 25-hour DST day); `onDay` trims
  // it. It used to be the tapped hour -12h/+36h - so opened from the 10 PM
  // row, the window began at 10 AM and that morning's 9 AM special vanished.
  const [dayY, dayM, dayD] = dayKey.split("-").map(Number);
  const dayStartMs = zonedWallTimeToUtc(dayY!, dayM! - 1, dayD!, 0, timezone).getTime();
  const windowFrom = new Date(dayStartMs - 3600_000).toISOString();
  const windowTo = new Date(dayStartMs + 26 * 3600_000).toISOString();

  // Load open slots for the chosen (staff, service, add-ons) on the prefill day.
  // The add-ons go as ids: the API resolves their minutes itself, and only
  // lists a time the service PLUS them fits in.
  useEffect(() => {
    if (!serviceId || !staffId || customTime) return;
    let live = true;
    setLoadingSlots(true);
    getDashSlotsAction(
      staffId,
      serviceId,
      windowFrom,
      windowTo,
      addOnKey ? addOnKey.split(",") : [],
    ).then((res) => {
      // A newer pick (service, provider, add-ons) raced this answer - ticking
      // two add-ons quickly must never leave the one-add-on list on screen.
      if (!live) return;
      setLoadingSlots(false);
      setSlots(res.ok && res.slots ? res.slots.filter((s) => onDay(s.startsAt)) : []);
    });
    return () => {
      live = false;
    };
  }, [serviceId, staffId, customTime, windowFrom, windowTo, onDay, addOnKey]);

  // Load the DAY's specials: this provider's, or every provider's while none is
  // picked. Independent of the service - that is the whole point.
  useEffect(() => {
    if (customTime) return;
    let live = true;
    getDaySpecialsAction(staffId, windowFrom, windowTo).then((res) => {
      if (!live) return; // a provider change raced this answer
      setSpecials(res.ok && res.specials ? res.specials.filter((t) => onDay(t.startsAt)) : []);
    });
    return () => {
      live = false;
    };
  }, [staffId, customTime, windowFrom, windowTo, onDay]);

  /**
   * The special actually being booked: picked, not in Custom time, and offered
   * under the provider and service now selected. Derived, so no path can send
   * a special the form is no longer showing as chosen.
   */
  const special =
    !customTime && targetedSlotId
      ? (specials.find(
          (t) =>
            t.id === targetedSlotId &&
            t.staffId === staffId &&
            serviceId !== null &&
            t.serviceIds.includes(serviceId),
        ) ?? null)
      : null;

  /**
   * The add-ons offered with the picked service - active, and listed by the
   * API's own rule - and the ones ticked. A special books at its own length
   * and price, so while one is picked nothing is ticked or sent.
   */
  const serviceAddOns = selectedService
    ? addOns.filter((a) => a.active && addOnOffersService(a, selectedService.id))
    : [];
  const chosenAddOns = special ? [] : serviceAddOns.filter((a) => addOnIds.includes(a.id));
  // The same sums the API books: minutes onto the service's length, and a price
  // only when there is one to add (a priceless service with free add-ons stays
  // priceless). The service's base figures, as its row above shows them.
  const addOnPrice = chosenAddOns.reduce((sum, a) => sum + (a.price ?? 0), 0);
  const totalMin =
    (selectedService?.durationMin ?? 0) + chosenAddOns.reduce((sum, a) => sum + a.durationMin, 0);
  // Custom time's typed price, read by the same parser the Services tab uses.
  // Outside Custom time nothing typed counts: an open time books at the menu
  // price, a special at its own.
  const typedPrice = customTime ? parsePrice(priceText) : null;
  const customPrice = typedPrice?.ok ? typedPrice.value : null;
  const basePrice = customPrice ?? selectedService?.price ?? null;
  const totalPrice = basePrice == null && addOnPrice === 0 ? null : (basePrice ?? 0) + addOnPrice;

  /**
   * The hour he tapped, offered as itself when it is not one of the times
   * listed. Only once the list has loaded (so "not listed" is known), and only
   * for a TAPPED hour - the "+ New appointment" button's default start is not
   * a time he chose.
   */
  const offerTapped =
    tapped &&
    !customTime &&
    serviceId !== null &&
    staffId !== null &&
    !loadingSlots &&
    onDay(prefillISO) &&
    !slots.some((s) => s.startsAt === prefillISO) &&
    !specials.some((t) => t.startsAt === prefillISO);

  function bookTappedTime() {
    setCustomTime(true);
    setStartsAt(prefillISO);
    setTargetedSlotId(null);
  }

  function toggleAddOn(id: string) {
    const on = addOnIds.includes(id);
    setAddOnIds(on ? addOnIds.filter((x) => x !== id) : [...addOnIds, id]);
    // A repeating series takes no add-ons (the API refuses the pair), so
    // ticking one makes this a single visit - the Repeat card says so.
    if (!on) setRepeat(false);
  }

  /** Tap a special: it picks its own provider and service. */
  function pickSpecial(t: DaySpecial) {
    setStaffId(t.staffId);
    // Keep the chosen service if the special is offered under it; otherwise the
    // first it is offered under (the server lists them in menu order).
    if (!serviceId || !t.serviceIds.includes(serviceId)) setServiceId(t.serviceIds[0]!);
    setStartsAt(t.startsAt);
    setTargetedSlotId(t.id);
    setRepeat(false);
    // Its own length and price: nothing to add to.
    setAddOnIds([]);
  }

  /** Switching service or provider forgets a special not offered under the new one. */
  function chooseService(id: string) {
    // Add-ons belong to a service: a new service starts with none ticked.
    if (id !== serviceId) setAddOnIds([]);
    setServiceId(id);
    const t = specials.find((x) => x.id === targetedSlotId);
    if (t && !t.serviceIds.includes(id)) setTargetedSlotId(null);
  }
  function chooseStaff(id: string) {
    setStaffId(id);
    const t = specials.find((x) => x.id === targetedSlotId);
    if (t && t.staffId !== id) setTargetedSlotId(null);
  }

  const serviceNames = (ids: string[]) =>
    ids
      .map((id) => activeServices.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join(" / ");

  // Debounced client search.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchClientsAction(query.trim()).then((res) => {
        if (res.ok && res.clients) setResults(res.clients.slice(0, 8));
      });
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function submit(opts?: { confirmation?: string; overlap?: string }) {
    // Read defensively: a footer button may hand us its click event, so only a
    // real string counts - never a truthiness test on whatever was passed.
    const externalBlockConfirmation =
      typeof opts?.confirmation === "string" && opts.confirmation.length > 0
        ? opts.confirmation
        : undefined;
    if (typeof opts?.overlap === "string" && opts.overlap.length > 0) {
      acceptedOverlap.current = opts.overlap;
    }
    const overlapConfirmation = acceptedOverlap.current ?? undefined;
    setBlockConflict(null);
    setOverlapConflict(null);
    setError(null);
    if (!serviceId) return setError("Pick a service.");
    if (!staffId) return setError("Pick a provider.");
    if (!startsAt) return setError("Pick a time.");
    // Opened without a tapped hour (the waitlist's Book, the New button), the
    // form starts on a placeholder instant - "now", to the second. Schedule
    // before choosing anything sent it, and read "That time isn't available.
    // Use Custom time" when nothing had been chosen at all.
    if (
      !tapped &&
      !customTime &&
      !special &&
      startsAt === prefillISO &&
      !slots.some((s) => s.startsAt === startsAt)
    ) {
      return setError("Pick a time.");
    }
    if (!clientId && !newName.trim()) return setError("Pick a client or enter a name.");
    if (repeat && endMode === "until" && !until) return setError("Pick an end date.");
    // A repeat box holding a number it cannot use: refuse, never guess.
    const badRepeat = repeat
      ? (repeatProblems.weeks ?? (endMode === "count" ? repeatProblems.count : null))
      : null;
    if (badRepeat) return setError(badRepeat);
    if (typedPrice && !typedPrice.ok) return setError(typedPrice.error);
    if (customPrice !== null && customPrice > 10_000) return setError("Enter a price under $10,000.");
    if (customPrice !== null && repeat) {
      return setError("A typed price is for one visit. Turn off Repeat, or clear the price.");
    }

    // `until` is inclusive of the chosen day (the server stops once an
    // occurrence starts AFTER untilDate), so send END of that day in the
    // SHOP's tz. The old browser-local-noon anchor cut afternoon occurrences
    // on the until-day even with everyone in the same zone.
    const untilISO = () => {
      const [y, m, d] = until.split("-").map(Number);
      return zonedWallTimeToUtc(y!, m! - 1, d!, 23 * 60 + 59, timezone).toISOString();
    };
    // A special is one physical time: it never repeats (the server refuses the
    // combination too). Nor does a visit with add-ons.
    const recurrence = repeat && !special && chosenAddOns.length === 0
      ? {
          interval: everyWeeks,
          ...(endMode === "count" ? { count } : { until: untilISO() }),
        }
      : undefined;

    start(async () => {
      const res = await createAppointmentAction({
        staffId,
        serviceId,
        startsAt,
        clientId: clientId ?? undefined,
        firstName: clientId ? undefined : newName.trim(),
        phone: clientId ? undefined : newPhone.trim() || undefined,
        note: note.trim() || undefined,
        customTime,
        // Custom time only (typedPrice is null otherwise); empty = menu price.
        price: customPrice ?? undefined,
        externalBlockConfirmation,
        overlapConfirmation,
        recurrence,
        // Atomic waitlist link - see CreateApptInput.
        waitlistEntryId: waitlist?.entryId,
        // Claimed server-side in the same transaction, at its own price.
        targetedSlotId: special?.id,
        // What is ticked ON SCREEN - derived, so an add-on the form is no
        // longer showing can never ride along.
        addOnIds: chosenAddOns.length > 0 ? chosenAddOns.map((a) => a.id) : undefined,
      });
      if (!res.ok) {
        if (res.error === "external_block") {
          // Show the block, ask - the booking happens only on confirm, and
          // only with the confirmation that names THIS block. A refusal that
          // arrives without one is still shown; it just cannot be confirmed.
          setBlockConflict({
            reason: res.reason ?? "That time is blocked in your external calendar.",
            confirmation: res.confirmation ?? "",
          });
          return;
        }
        // Over something already there: say WHAT, and let him book anyway
        // (Drick: "it should bypass if I am force booking") - after one more
        // tap on the server's own question.
        if (res.error === "slot_taken" && res.code === "OVERLAP" && res.confirmation) {
          setOverlapConflict({
            reason: res.reason ?? "That time overlaps what's already on your calendar:",
            confirmation: res.confirmation,
            details: res.conflicts,
            ask: res.message ?? "This overlaps another booking. Book it anyway?",
          });
          return;
        }
        // A customer is paying for or confirming that exact time: shown here,
        // with when it ends, and nothing to confirm.
        if (res.error === "slot_taken" && res.code === "HELD") {
          setOverlapConflict({
            reason: res.reason ?? "A customer is booking this time right now. Pick another time.",
            confirmation: "",
          });
          return;
        }
        setError(
          res.error === "same_start"
            ? "Another appointment starts at exactly that minute. Start this one a few minutes later (e.g. :05)."
            : res.error === "acuity_refused"
              ? (res.reason ??
                "Acuity wouldn't block this time, so it wasn't booked. Check your Acuity calendar, then try again.")
              : res.error === "slot_taken"
                ? special
                  ? "That special was just booked or taken off. Pick another time."
                  : customTime
                    ? "That time is already booked."
                    : "That time was just taken. Pick another, or use Custom time to force it."
                : res.error === "invalid_slot"
                  ? chosenAddOns.length > 0
                    ? "That time is too short with the add-ons. Pick another, or use Custom time to force it."
                    : "That time isn't available. Use Custom time to force it."
                  : res.error === "invalid_add_on"
                    ? "An add-on you ticked isn't offered with this service any more. Close this and open it again to see the current list."
                    : "Couldn't schedule. Please try again.",
        );
        return;
      }
      // Recurring: surface partial success (some dates may have been unavailable).
      if (res.series) {
        const { booked, skipped } = res.series;
        if (booked === 0) {
          setError("None of those dates were available. Try a different time.");
          return;
        }
        toast(
          skipped.length > 0
            ? `Booked ${booked} — ${skipped.length} date${skipped.length > 1 ? "s were" : " was"} unavailable`
            : `Booked ${booked} appointments`,
          "success",
        );
      } else if (res.forced && res.mirror === "failed") {
        // Booked, and Acuity turned the block down and the undo could not run:
        // the one outcome that needs him to act, so it says what to do.
        toast("Booked - but Acuity didn't block that time. Block it in Acuity so it can't be sold.", "error");
      } else if (res.forced && res.mirror === "unknown") {
        toast("Booked over the other appointment - still confirming the time on Acuity.", "success");
      } else {
        toast(res.forced ? "Booked over the other appointment" : "Appointment scheduled", "success");
      }
      onCreated();
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New appointment"
      titleAlign="center"
      className="sm:max-w-lg"
      footer={
        <FormFooter
          error={error}
          label="Schedule appointment"
          pendingLabel="Scheduling…"
          pending={pending}
          onSubmit={submit}
        />
      }
    >
      <div data-qa="new-appt-form" className="flex min-w-0 flex-col gap-5">
        {blockConflict && (
          <ExternalBlockBanner
            conflict={blockConflict}
            pending={pending}
            confirmLabel="Book over it"
            pendingLabel="Booking…"
            consequence="Booking here puts an appointment on time you blocked off there. It will be recorded as an override."
            onConfirm={() => submit({ confirmation: blockConflict.confirmation })}
            onDismiss={() => setBlockConflict(null)}
          />
        )}
        {overlapConflict && (
          <ExternalBlockBanner
            conflict={overlapConflict}
            pending={pending}
            confirmLabel="Book anyway"
            pendingLabel="Booking…"
            consequence={
              overlapConflict.confirmation
                ? "Both stay on your calendar, and this one is marked Double-booked. A special listed here comes off sale so nobody can book on top of this."
                : "Nothing was booked."
            }
            onConfirm={() => submit({ overlap: overlapConflict.confirmation })}
            onDismiss={() => setOverlapConflict(null)}
          />
        )}
        <Group title="Service">
          <div className="flex min-w-0 flex-col gap-1.5">
            {activeServices.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => chooseService(s.id)}
                className={cn(
                  "flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors duration-150 ease-out",
                  serviceId === s.id
                    ? "border-gold/50 bg-gold/10"
                    : "border-subtle hover:bg-charcoal-700/40",
                )}
              >
                <span className="min-w-0">
                  <span className="block [overflow-wrap:anywhere] font-medium text-offwhite">
                    {s.name}
                  </span>
                  <span className="block text-xs text-muted">
                    {s.durationMin} min{s.price != null ? ` · ${formatPrice(s.price)}` : ""}
                  </span>
                </span>
                {serviceId === s.id && (
                  <span aria-hidden className="shrink-0 text-gold">
                    ✓
                  </span>
                )}
              </button>
            ))}
            {activeServices.length === 0 && (
              <p className="text-sm text-muted">Add a service first (Services tab).</p>
            )}
          </div>
        </Group>

        {/* The picked service's add-ons, unticked until he ticks them. Only
            when it has any - a service without add-ons shows no card at all. */}
        {selectedService && serviceAddOns.length > 0 && (
          <Group title="Add-ons">
            {special ? (
              <p className="text-xs text-muted">
                A special has its own length and price, so add-ons don&apos;t apply.
              </p>
            ) : (
              <>
                <div role="group" aria-label="Add-ons" className="flex min-w-0 flex-col gap-1.5">
                  {serviceAddOns.map((a) => {
                    const on = addOnIds.includes(a.id);
                    const extra = [
                      a.price != null && a.price > 0 ? `+${formatSpecialPrice(a.price)}` : null,
                      a.durationMin > 0 ? `+${a.durationMin} min` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <button
                        key={a.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleAddOn(a.id)}
                        className={cn(
                          "flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-left text-sm transition-colors duration-150 ease-out",
                          on ? "border-gold/50 bg-gold/10" : "border-subtle hover:bg-charcoal-700/40",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <span
                            aria-hidden
                            className={cn(
                              "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
                              on ? "border-gold text-gold" : "border-subtle-strong",
                            )}
                          >
                            {on ? "✓" : ""}
                          </span>
                          <span className="min-w-0 [overflow-wrap:anywhere] font-medium text-offwhite">
                            {a.name}
                          </span>
                        </span>
                        {extra && (
                          <span className="shrink-0 text-xs tabular-nums text-muted">{extra}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {chosenAddOns.length > 0 && (
                  <div
                    data-qa="add-on-total"
                    className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-gold/30 bg-gold/5 px-4 py-2.5 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted">
                        Total
                      </span>
                      <span className="block [overflow-wrap:anywhere] text-offwhite">
                        {[selectedService.name, ...chosenAddOns.map((a) => a.name)].join(" + ")}
                      </span>
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums text-gold">
                      {totalMin} min{totalPrice !== null ? ` · ${formatSpecialPrice(totalPrice)}` : ""}
                    </span>
                  </div>
                )}
              </>
            )}
          </Group>
        )}

        {activeStaff.length > 1 && (
          <Group title="Provider">
            <div className="flex flex-wrap gap-1.5">
              {activeStaff.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => chooseStaff(s.id)}
                  className={chip(staffId === s.id, "px-4")}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </Group>
        )}

        <Group
          // Custom time can move the date, so the header follows the time that
          // will actually be booked - never the day that was tapped. The two
          // disagreeing ("FRI, SEP 25" over a value on Sep 24) is how a barber
          // booked the wrong night without anything on screen telling him.
          title={`Time · ${dayFmt.format(new Date(customTime && startsAt ? startsAt : prefillISO))}`}
          action={
            <button
              type="button"
              onClick={() => {
                if (customTime) {
                  // 🔴 Leaving Custom time forgets the typed time. It may be on
                  // another day the grid does not show, and it used to ride
                  // along: Schedule booked a night the screen never displayed.
                  setStartsAt(prefillISO);
                  setTargetedSlotId(null);
                }
                setCustomTime((v) => !v);
              }}
              // A real 44px hit area; the negative margin keeps the header line
              // visually as tight as the sheet's.
              className="-my-3 flex h-11 items-center px-2 text-[11px] text-muted underline-offset-2 transition-colors duration-150 ease-out hover:text-offwhite hover:underline"
            >
              {customTime ? "Pick from open slots" : "Custom time"}
            </button>
          }
        >
          {customTime ? (
            <div className="flex min-w-0 flex-col gap-1.5">
              <input
                type="datetime-local"
                aria-label="Custom date and time"
                className={INPUT}
                // CONTROLLED, and seeded from the day he tapped. Uncontrolled and
                // empty, iOS opens the picker on TODAY: tap Fri Sep 25, choose
                // 8:00 PM, and the value was Thu Sep 24 8:00 PM - the wrong night,
                // refused as "already booked" (Drick, 2026-09-24).
                value={startsAt ? shopLocalInputValue(startsAt, timezone) : ""}
                onChange={(e) => {
                  // datetime-local is naive wall clock; interpret in the SHOP's
                  // zone (the schedule shown) - new Date(v) would use the device's
                  // zone and shift the instant when the barber isn't in the shop tz.
                  const v = e.target.value;
                  if (!v) return;
                  const [day, time] = v.split("T");
                  const [y, m, d] = day!.split("-").map(Number);
                  const [hh, mm] = time!.split(":").map(Number);
                  setStartsAt(
                    zonedWallTimeToUtc(y!, m! - 1, d!, hh! * 60 + mm!, timezone).toISOString(),
                  );
                }}
              />
              {/* Where "force it" lives, said once: any time, even over another
                  booking - he is shown what is there and asked first. */}
              <p className="text-[11px] leading-snug text-muted">
                Any time works, even over another booking - you&apos;ll see who&apos;s there
                and be asked before it&apos;s booked.
              </p>
              {/* His price for a time he forced - an after-hours rate, say.
                  Blank books at the service's own price, as before. */}
              <Field
                label="Price"
                hint={
                  selectedService?.price != null
                    ? `Leave blank for the regular ${formatSpecialPrice(selectedService.price)}. Type your after-hours price to charge that instead.`
                    : "Leave blank for no price, or type what to charge for this visit."
                }
              >
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label="Price"
                  className={INPUT}
                  placeholder={
                    selectedService?.price != null ? selectedService.price.toFixed(2) : "0.00"
                  }
                  value={priceText}
                  onChange={(e) => {
                    setPriceText(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {/* 🔴 THE DAY'S SPECIALS COME FIRST, whatever service is picked -
                  before one is picked at all. A barber should not have to know
                  which service a special is filed under to see it; tapping one
                  picks its provider and service. */}
              {specials.length > 0 && (
                <div role="group" aria-label="Specials" className="flex min-w-0 flex-col gap-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gold">
                    Specials
                  </p>
                  {specials.map((t) => {
                    const picked = special?.id === t.id;
                    const who =
                      activeStaff.length > 1
                        ? activeStaff.find((s) => s.id === t.staffId)?.name
                        : undefined;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={picked}
                        onClick={() => pickSpecial(t)}
                        className={cn(
                          "flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-left text-sm transition-colors duration-150 ease-out",
                          picked ? "border-gold/60 bg-gold/15" : "border-gold/30 hover:bg-gold/5",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block font-medium text-offwhite">
                            {timeFmt.format(new Date(t.startsAt))}
                            {who ? <span className="font-normal text-muted"> · {who}</span> : null}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {t.label ?? "Special"} · {serviceNames(t.serviceIds)} · {t.durationMin} min
                          </span>
                        </span>
                        <span className="shrink-0 font-semibold text-gold">
                          {formatSpecialPrice(t.price)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {!serviceId ? (
                // What the screen used to say here was "No open times this day"
                // - true only because nothing had been asked for yet.
                <p className="text-xs text-muted">
                  {specials.length > 0
                    ? "Pick a service to see its regular times."
                    : "Pick a service to see open times."}
                </p>
              ) : !staffId ? (
                <p className="text-xs text-muted">Pick a provider to see open times.</p>
              ) : loadingSlots ? (
                <p className="text-sm text-muted">Loading times…</p>
              ) : slots.length > 0 ? (
                <div className="grid min-w-0 grid-cols-3 gap-1.5">
                  {slots.map((s) => (
                    <button
                      key={s.startsAt}
                      type="button"
                      onClick={() => {
                        setStartsAt(s.startsAt);
                        setTargetedSlotId(null);
                      }}
                      className={chip(
                        !special && startsAt === s.startsAt,
                        "min-w-0 px-1 text-center",
                      )}
                    >
                      {timeFmt.format(new Date(s.startsAt))}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted">
                  {specials.length > 0 ? "No other open times this day" : "No open times this day"}
                  {chosenAddOns.length > 0 ? " long enough with the add-ons." : "."}{" "}
                  Use Custom time to force one.
                </p>
              )}
              {offerTapped && (
                <button
                  type="button"
                  data-qa="book-tapped-time"
                  onClick={bookTappedTime}
                  className="flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-subtle px-4 py-2.5 text-left text-sm transition-colors duration-150 ease-out hover:bg-charcoal-700/40"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-offwhite">
                      {timeFmt.format(new Date(prefillISO))}
                    </span>
                    <span className="block text-xs text-muted">
                      The time you tapped · not one of your open times
                    </span>
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-gold">Book this time</span>
                </button>
              )}
            </div>
          )}
        </Group>

        <Group title="Client">
          {waitlist?.windowHint && (
            <p className="text-xs leading-snug text-muted">
              From the waitlist — they asked for{" "}
              <span className="text-offwhite">{waitlist.windowHint}</span>.
            </p>
          )}
          {clientId ? (
            <div className="flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-gold/40 px-4 py-3 text-left text-sm">
              <span className="min-w-0 [overflow-wrap:anywhere] font-medium text-offwhite">
                {clientLabel}
              </span>
              <button
                type="button"
                onClick={() => {
                  setClientId(null);
                  setClientLabel("");
                }}
                className="flex h-11 shrink-0 items-center rounded-lg border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <Field label="Find an existing client">
                <input
                  className={INPUT}
                  placeholder="Search name or number…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </Field>
              {results.length > 0 && (
                <ul className="flex flex-col gap-1 rounded-xl border border-subtle p-1">
                  {results.map((c) => {
                    const nm = c.name?.trim() || c.phone || "Client";
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setClientId(c.id);
                            setClientLabel(nm);
                            setResults([]);
                            setQuery("");
                          }}
                          className="flex min-h-[2.75rem] w-full flex-wrap items-center gap-x-2 rounded-lg px-3 py-2 text-left text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
                        >
                          <span className="[overflow-wrap:anywhere]">{nm}</span>
                          {c.phone && <span className="text-xs text-muted">{c.phone}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-[11px] text-muted">or add a new client:</p>
              <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2">
                <Field label="Name">
                  <input
                    className={INPUT}
                    placeholder="Name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </Field>
                <Field label="Phone" hint="Optional.">
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    className={INPUT}
                    placeholder="(201) 555-0134"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                  />
                </Field>
              </div>
            </>
          )}
        </Group>

        <Group title="Note">
          <Field label="Only you see this">
            <textarea
              className={cn(INPUT, "h-auto min-h-[4rem] resize-y py-2.5")}
              rows={2}
              placeholder="Optional note for this appointment"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </Group>

        <Group title="Repeat">
          {special ? (
            <p className="text-xs text-muted">
              A special is a one-off time, so it doesn&apos;t repeat.
            </p>
          ) : chosenAddOns.length > 0 ? (
            <p className="text-xs text-muted">
              Add-ons are for a single visit, so this one doesn&apos;t repeat.
            </p>
          ) : (
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setRepeat(false)}
                className={chip(!repeat, "flex-1")}
              >
                Does not repeat
              </button>
              {/* Not "Weekly": it repeats every 1 to 8 weeks, and a shop
                  booking a client every 3 weeks read "Weekly" as the wrong
                  option and asked how to do it. */}
              <button
                type="button"
                onClick={() => setRepeat(true)}
                className={chip(repeat, "flex-1")}
              >
                Repeat appointment
              </button>
            </div>
          )}

          {repeat && (
            <div className="flex flex-col gap-3 rounded-xl border border-subtle bg-charcoal-900/50 p-3">
              <RepeatNumber
                label="Repeat every how many weeks"
                value={everyWeeks}
                min={1}
                max={8}
                onChange={setEveryWeeks}
                onProblem={(p) => setRepeatProblems((s) => ({ ...s, weeks: p }))}
                before="Every"
                after={everyWeeks === 1 ? "week" : "weeks"}
                rangeHint="A repeat can be every 1 to 8 weeks."
              />

              <div className="flex flex-col gap-2">
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEndMode("count")}
                    className={chip(endMode === "count", "flex-1")}
                  >
                    For a count
                  </button>
                  <button
                    type="button"
                    onClick={() => setEndMode("until")}
                    className={chip(endMode === "until", "flex-1")}
                  >
                    Until a date
                  </button>
                </div>
                {endMode === "count" ? (
                  <RepeatNumber
                    label="How many appointments in total"
                    value={count}
                    min={2}
                    max={52}
                    onChange={setCount}
                    onProblem={(p) => setRepeatProblems((s) => ({ ...s, count: p }))}
                    after="appointments total"
                    rangeHint="A repeat can be 2 to 52 appointments."
                  />
                ) : (
                  <input
                    type="date"
                    aria-label="Repeat until"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                    className={INPUT}
                  />
                )}
              </div>
            </div>
          )}
        </Group>
      </div>
    </Dialog>
  );
}

/**
 * A whole number the barber TYPES, kept as typed while they type.
 *
 * 🔴 The repeat boxes used to clamp on every keystroke, which made them
 * impossible to change on a phone: clearing "8" snapped straight to 1, and
 * typing 3 after it read "13" and snapped back to 8 - so "every 8 weeks" was
 * the only number a barber could get (reported from a phone, 2026-10-06). Now
 * the box shows exactly what is typed, and the form takes the number the
 * moment it is a valid one. A box left blank goes back to the last good
 * number. One over the limit is NEVER changed into another number behind the
 * barber's back: it stays, says the range, and reports itself (onProblem) so
 * Schedule refuses rather than booking a number nobody typed.
 */
export function RepeatNumber(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  onProblem: (problem: string | null) => void;
  before?: string;
  after: string;
  rangeHint: string;
}) {
  const { value, min, max, onChange, onProblem } = props;
  const [draft, setDraft] = useState(String(value));
  // A box that leaves the screen takes its complaint with it. It comes back
  // showing the last good number, so a remembered range error refused a value
  // the barber could see was fine.
  const onProblemRef = useRef(onProblem);
  onProblemRef.current = onProblem;
  useEffect(() => () => onProblemRef.current(null), []);
  // Follow the form's number when it changes from outside (not mid-typing).
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    if (Number(draft) !== value) setDraft(String(value));
  }
  const n = draft === "" ? NaN : Number(draft);
  const outOfRange = draft !== "" && (!Number.isInteger(n) || n < min || n > max);
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm text-offwhite">
        {props.before}
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          aria-label={props.label}
          aria-invalid={outOfRange || undefined}
          value={draft}
          onChange={(e) => {
            const typed = e.target.value.replace(/[^0-9]/g, "").slice(0, 3);
            setDraft(typed);
            const v = Number(typed);
            const ok = typed !== "" && v >= min && v <= max;
            if (ok) onChange(v);
            // Blank is not a problem yet - they are mid-edit, and leaving the
            // box restores the last good number.
            onProblem(typed === "" || ok ? null : props.rangeHint);
          }}
          onBlur={() => {
            if (draft === "") setDraft(String(value));
          }}
          className={cn(INPUT, "w-20 px-2 text-center", outOfRange && "border-danger")}
        />
        {props.after}
      </label>
      {outOfRange && <p className="text-xs text-danger-soft">{props.rangeHint}</p>}
    </div>
  );
}

/** "$60", or "$62.50" - a special's price is exact, so it is never rounded. */
export function formatSpecialPrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

/**
 * ⚠️ LEGACY SHELL — the booking forms have moved to ui/Dialog. Still consumed
 * by BookingManager's "Edit service" and weekly-hours sheets; migrate those
 * and this component goes. Do not add new consumers: Dialog has the focus
 * trap, the keyboard-aware viewport and the sticky footer; this has none.
 */
/**
 * The overlay every booking form rides in: a bottom sheet on phones, a centred
 * dialog from `sm` up.
 *
 * PORTALLED TO document.body, and that is load-bearing rather than tidiness.
 * ChairBack cards use `.glass`, which sets `backdrop-filter` - and any
 * non-`none` filter/backdrop-filter makes that element a CONTAINING BLOCK for
 * `position: fixed` descendants. Rendered in place, `fixed inset-0` would size
 * itself to the CARD instead of the viewport and its z-index would be trapped
 * in the card's stacking context: a sheet the width of an appointment row,
 * painted underneath the row below it. Portalling escapes both.
 *
 * Also handles the dialog basics the old inline version skipped: Escape to
 * close, focus moved in on open and restored on close, background scroll
 * locked, and proper dialog semantics for screen readers.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Background must not scroll under an open sheet on iOS.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the panel so a keyboard/screen-reader user lands inside the dialog
    // rather than continuing from wherever the trigger was.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative z-10 max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-subtle bg-charcoal-900 p-5 outline-none sm:rounded-2xl"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="min-w-0 [overflow-wrap:anywhere] font-display text-lg text-offwhite">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 shrink-0 items-center rounded-full border border-subtle px-3 text-xs text-muted hover:text-offwhite sm:h-9"
          >
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
