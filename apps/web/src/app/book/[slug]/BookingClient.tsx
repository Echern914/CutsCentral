"use client";

import {
  type MutableRefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { DEMO } from "@chairback/config/demo";
import { serviceColorHex } from "@chairback/config/constants";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import { zonedMinutesOfDay } from "@chairback/config/time";
import { BackToDashboard } from "@/components/BackToDashboard";
import { CustomerBack } from "@/components/CustomerBack";
import { PullToRefresh } from "@/components/PullToRefresh";
import { useSignalNativeReady } from "@/lib/nativeReady";
import { DemoTour } from "@/components/tour/DemoTour";
import { useDemoTour } from "@/components/tour/state";
import type { BookShopData } from "./page";
import { readableOn } from "@/lib/contrast";
import {
  bookAction,
  bookingStatusAction,
  getDayBundlesAction,
  getMergedSlotsAction,
  getOpenDaysAction,
  getUpgradesAction,
  type DayBundlesResult,
  type DayService,
  type MergedSlotsResult,
  type OpenDaysResult,
  type UpgradeOffer,
} from "./actions";
import { PaymentStep } from "./PaymentStep";
import { WaitlistForm } from "./WaitlistForm";
import { groupsToAutoExpand } from "./autoExpand";
import { revealElement } from "./reveal";

/** One selectable time in the calendar grid, with who can serve it. */
interface DaySlot {
  startsAt: string;
  // Staff free at this instant (from the merged fetch); one for single-barber.
  staffIds: string[];
  // Present when this is a barber-published targeted "special" slot.
  targeted?: { id: string; price: number; label: string | null };
  // Spare minutes after the service here, for staffIds[0] (the barber the
  // booking is written against). Absent on a targeted slot — fixed inventory.
  maxExtraMin?: number;
}

// ---- Calendar date math. All operate on shop-local "YYYY-MM-DD" / "YYYY-MM"
// strings so there is NO Date parsing in the viewer's zone (which would drift a
// day near midnight). We only construct a UTC Date to walk the grid, then read
// it back with getUTCFullYear/Month/Date — never a local getter.

/** "YYYY-MM" month key for a "YYYY-MM-DD" day (or ISO — first 7 chars). */
function monthKey(dayOrIso: string): string {
  return dayOrIso.slice(0, 7);
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

/**
 * Public native booking picker: pick service -> (provider, only when the service
 * has more than one barber) -> a day on the monthly calendar -> open slot ->
 * enter contact + SMS consent -> confirm. A single-barber service skips the
 * provider step and lands straight on the calendar. Slots come from a server
 * action (CSP blocks a direct browser fetch); the create action returns a manage
 * token so we can link the customer to cancel/reschedule. Accent-themed to the shop.
 */
/** Fixed gold for special slots — see the note in BookingClient. */
const SPECIAL_GOLD = "#D4AF37";

/**
 * A rebook prefill from a link: "the usual, just pick a time".
 *
 * Ids only, and only ones already public on this page - this preselects what
 * the client could have tapped themselves, and grants nothing.
 */
export interface BookingPrefill {
  serviceId: string | null;
  staffId: string | null;
}

export function BookingClient({
  data,
  prefill = null,
}: {
  data: BookShopData;
  prefill?: BookingPrefill | null;
}) {
  // Clear the native app's WebView spinner (reachable from the shop page's Book
  // CTA inside the app; the shell may be waiting on this ready signal).
  useSignalNativeReady();

  // What this business calls its people. NEUTRAL when the API is older than this
  // deploy or the shop has never chosen a type — "provider" is right for
  // everyone and wrong for nobody, which is what a fallback has to be.
  const vocab = data.shop.vocabulary ?? NEUTRAL_VOCABULARY;
  const accent = data.shop.accentColor || "#D4AF37";
  // Text painted ON the accent must actually read against it — shops pick
  // arbitrary accents, so a hardcoded near-black fails WCAG on dark ones.
  const onAccent = readableOn(accent);
  const tz = data.shop.timezone;

  /**
   * Specials (barber-published targeted slots — the late-night cut, the model
   * rate) are painted GOLD and starred, deliberately NOT in the shop's accent.
   *
   * They used to render in the accent at low opacity, which meant that for any
   * shop whose accent IS gold-ish the "extra" slot looked exactly like every
   * ordinary time. A special is a different KIND of thing — its own price, its
   * own hours — so it gets its own fixed colour and a ★ that survives whatever
   * accent the shop picks.
   */

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
  // "You have time for more." Spare minutes after the chosen slot comes off the
  // slot itself, so add-ons can be filtered the instant a chip is tapped with no
  // round trip; the UPGRADE offers need the server (a longer service steps its
  // own grid and has its own hours/caps — see getUpgradesAction) and arrive a
  // moment later.
  const [slotRoomMin, setSlotRoomMin] = useState<number | null>(null);
  const [upgrades, setUpgrades] = useState<UpgradeOffer[]>([]);
  // Guards the upsell fetch against out-of-order replies: tapping 4:00 then
  // 4:30 must never render 4:00's offers under 4:30. Bumped on every pick.
  const upsellToken = useRef(0);
  const [slotsByDay, setSlotsByDay] = useState<Map<string, DaySlot[]>>(new Map());
  const [loadingSlots, setLoadingSlots] = useState(false);
  // The barber pool the current calendar was loaded for, so a slot_taken refresh
  // can reload the SAME union (not just one barber). One element for single-
  // barber / a chosen provider; ready for multi-barber merges.
  const [loadedPool, setLoadedPool] = useState<string[]>([]);
  // Which calendar month is on screen ("YYYY-MM" month key, shop tz).
  const [viewMonth, setViewMonth] = useState<string | null>(null);

  // Chosen add-ons (ids) for the picked service. Add-ons extend the appointment
  // and the total; validated at create (if they overflow the slot, the create
  // returns invalid_slot and the customer picks another time).
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  /**
   * A standing appointment: null = just once. Offered only when the API says
   * the shop allows it (recurringAvailable) and no add-ons or special are in
   * play - both refused server-side, so the control hides rather than letting
   * a choice be silently dropped at submit.
   */
  const [repeat, setRepeat] = useState<{ interval: number; count: number } | null>(null);
  /** What the series booking actually produced, for the confirmation screen. */
  const [seriesResult, setSeriesResult] = useState<{
    booked: number;
    total: number;
    skipped: string[];
  } | null>(null);
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
  // Set when the shop charges at booking. The appointment exists at this point
  // but as a HOLD, not a booking: it becomes real only when this payment
  // succeeds, and the chair is released if the customer abandons this screen.
  // So the confirmation screen genuinely must wait for the card to clear.
  const [paymentSecret, setPaymentSecret] = useState<string | null>(null);
  // What is actually being charged, straight from the API. Never derive this
  // from the service price: in DEPOSIT mode the two differ, and labelling the
  // button "Pay $45" while taking $20 is the one thing a payment screen must
  // never do.
  const [payCharge, setPayCharge] = useState<{
    amountCents: number;
    isDeposit: boolean;
    balanceDueCents: number;
    /** Minutes the chair is held while they pay; null if the API didn't say. */
    holdMinutes: number | null;
    /** The instant the chair goes back on sale, so the screen can count DOWN. */
    expiresAt: string | null;
  } | null>(null);
  // The manage token of a booking awaiting payment (shown after the card clears).
  const [manageTokenPending, setManageTokenPending] = useState<string | null>(null);
  /**
   * What happened after the card cleared.
   *
   * 🔴 "The money left" and "you have a booking" are DIFFERENT FACTS. The
   * appointment is a hold until `payment_intent.succeeded` reaches the webhook
   * and promotes it, so this screen used to promise a confirmation it had no
   * way to know about: a slow webhook, or a payment that went to `processing`
   * and later failed, left the customer reading "You're booked!" while the
   * sweep quietly cancelled the chair out from under them.
   *
   * "checking" = paid, asking the server. "slow" = the money is away but the
   * booking has not appeared yet, which is worth saying honestly rather than
   * guessing in either direction. "gone" = the server says it did not survive.
   */
  const [payConfirm, setPayConfirm] = useState<"no" | "checking" | "slow" | "gone">("no");
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
    if (!serviceId && bookableServices.length > 0) {
      const svc = bookableServices[0]!;
      const svcPool = staffPoolFor(svc.id);
      const stf = data.staff.find((s) => svcPool.includes(s.id));
      pickService(svc.id);
      // pickService already auto-loads a single-barber service's calendar; only
      // force the staff + fetch for a MULTI-barber demo service (where it didn't),
      // so the tour lands on a loaded calendar with exactly one fetch regardless
      // of how the demo shop is seeded.
      if (stf && svcPool.length > 1) {
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

  // Services that at least one barber actually offers. A service with zero
  // active-staff offerings (e.g. its only barber was deactivated) can't be
  // booked, and picking it would dead-end the wizard (no provider step, no
  // calendar) — so it never appears in the menu.
  const bookableServices = useMemo(() => {
    const offered = new Set(data.offerings.map((o) => o.serviceId));
    return data.services.filter((s) => offered.has(s.id));
  }, [data.services, data.offerings]);

  // Grouped sections for the service-first menu (Drick: the list should mirror
  // his group taxonomy instead of interleaving everything). Groups in display
  // order with members in their saved in-group order; services without a live
  // group trail under "More services". A shop with no groups renders the same
  // flat list as before (one headerless section).
  const menuSections = useMemo(() => {
    const sections = (data.groups ?? [])
      .map((g) => ({
        id: g.id,
        name: g.name,
        services: bookableServices
          .filter((s) => s.serviceGroupId === g.id)
          .slice()
          .sort((a, b) => a.groupSortOrder - b.groupSortOrder),
      }))
      .filter((g) => g.services.length > 0);
    const grouped = new Set(sections.flatMap((g) => g.services.map((s) => s.id)));
    return {
      sections,
      ungrouped: bookableServices.filter((s) => !grouped.has(s.id)),
    };
  }, [data.groups, bookableServices]);

  // Day-first "bundles" menu (the groups-first shop setting): the customer
  // picks a DATE first, then sees only the bundles (service groups) with real
  // openings that day and the concrete times inside each — bundles with
  // nothing open that day never appear.
  //
  // Layout (every shop): EVERYTHING is on screen from the moment the page
  // opens — the grouped service menu at the top (each group a COLLAPSED
  // dropdown card; one tap opens its services and their times), and the month
  // calendar with the day's time rail right below it. The soonest open day is
  // auto-selected on load, so the menu is ready the moment a card is opened;
  // picking another date just swaps the times inside whatever's open.
  const dayFirst = true;
  const [dayDate, setDayDate] = useState<string | null>(null); // YYYY-MM-DD (shop tz)
  const [dayData, setDayData] = useState<DayBundlesResult | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  // A failed /day fetch used to leave "Checking the day's openings…" up
  // FOREVER (the transition silently dropped the failure) — one network blip
  // on landing and the whole page looked dead. Real state + a retry button.
  const [dayError, setDayError] = useState(false);
  const [dayMonth, setDayMonth] = useState<string | null>(null); // "YYYY-MM"
  // Which group cards are expanded in the day view. Groups start COLLAPSED
  // (Drick: a wall of every service at once overwhelms — headers first, tap to
  // open) and a customer's opened cards STAY open across day switches so they
  // can compare a service's times between days without re-opening it.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** The "Choose a service" step, so picking a day can scroll down to it. */
  const servicesSectionRef = useRef<HTMLElement | null>(null);
  const toggleDayGroup = (id: string, el?: HTMLElement | null) => {
    const opening = !expandedGroups.has(id);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Opening a card pushes its times below the fold on a phone, especially for
    // the last card in a long menu. Reveal the CARD (not the times) so its own
    // header stays visible as the label for what just appeared. After paint:
    // the rows don't exist yet at the moment of the tap.
    if (opening && el) requestAnimationFrame(() => revealElement(el));
  };

  // Days the calendar offers, first pass: within the booking window, on a
  // weekday anyone works at all (cheap heuristic, available instantly from the
  // shell payload — the REAL availability arrives just behind it, below).
  const dayFirstDays = useMemo(() => {
    if (!dayFirst) return new Set<string>();
    const out = new Set<string>();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const start = new Date(`${today}T12:00:00Z`);
    for (let i = 0; i <= data.shop.bookingMaxDays; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      if (!data.openWeekdays?.includes(d.getUTCDay())) continue;
      out.add(d.toISOString().slice(0, 10));
    }
    return out;
  }, [dayFirst, tz, data.shop.bookingMaxDays, data.openWeekdays]);

  // REAL availability (engine-computed, 60s-cached server side): which days
  // actually have an opening, and the single soonest bookable slot. The
  // weekday heuristic alone auto-selected TODAY even when today's slots were
  // gone (every evening visitor landed on an empty day) and never greyed a
  // fully-booked date — "grey out days not open" / "doesn't open in the next
  // day available" (Drick).
  const [openInfo, setOpenInfo] = useState<OpenDaysResult | "unavailable" | null>(null);
  useEffect(() => {
    if (!dayFirst) return;
    let alive = true;
    (async () => {
      // Real availability is the ONLY thing that keeps the page off a dead day
      // (the weekday heuristic below happily offers a today whose times are all
      // gone), and losing it also hides the "Next available" way out. One failed
      // request must therefore not strand the visitor in heuristic mode for the
      // whole session: retry before accepting the degraded answer. The public
      // read limiter is per-minute and per-IP, so a burst - every visitor
      // sharing one proxy egress IP, say - is exactly the transient this
      // recovers from.
      for (let attempt = 0; ; attempt++) {
        // try/catch, not just an ok check: a server action that THROWS (a
        // function-duration cap, a transport failure) would otherwise skip
        // every setOpenInfo below and leave openInfo null forever, which is
        // the same dead end by a different route.
        let res: Awaited<ReturnType<typeof getOpenDaysAction>> | null = null;
        try {
          res = await getOpenDaysAction(data.shop.slug);
        } catch {
          res = null;
        }
        if (!alive) return;
        if (res?.ok && res.data) {
          setOpenInfo(res.data);
          return;
        }
        if (attempt >= 2) break;
        // Back off past a slow cold sweep rather than stacking another one on
        // top of it. The server dedupes concurrent sweeps per shop, so a retry
        // that lands mid-sweep attaches to the run already going instead of
        // starting a second.
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        if (!alive) return;
      }
      // Still nothing: keep the heuristic calendar rather than a dead page. The
      // empty-day self-heal in pickDay is what covers the customer from here.
      setOpenInfo("unavailable");
    })();
    return () => {
      alive = false;
    };
  }, [dayFirst, data.shop.slug]);
  const openDaySet = useMemo(
    () =>
      openInfo && openInfo !== "unavailable" ? new Set(openInfo.openDays) : null,
    [openInfo],
  );

  // What the calendar actually offers: inside the scanned range the engine's
  // answer replaces the heuristic (fully-booked and closed days grey out);
  // beyond it the heuristic stands (the API didn't look that far). Open days
  // the heuristic missed — a targeted special on an off weekday — are added.
  const calendarDays = useMemo(() => {
    if (!openDaySet || !openInfo || openInfo === "unavailable") return dayFirstDays;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const edge = new Date(`${today}T12:00:00Z`);
    edge.setUTCDate(edge.getUTCDate() + openInfo.scanDays);
    const lastScanned = edge.toISOString().slice(0, 10);
    const out = new Set<string>();
    for (const d of dayFirstDays) {
      if (d < lastScanned) {
        if (openDaySet.has(d)) out.add(d);
      } else {
        out.add(d);
      }
    }
    for (const d of openDaySet) out.add(d);
    return out;
  }, [dayFirstDays, openDaySet, openInfo, tz]);

  // Working days the engine found NOTHING on (fully booked, or today with all
  // times passed): the weekday heuristic offers them, real availability says
  // no. These stay tappable-but-dimmed so tapping one shows an honest "no
  // available times this day" + the waitlist, instead of a dead cell — the
  // only things that can open them back up are a cancellation or a published
  // squeeze-in (which flips the day into openDays automatically).
  const bookedOutDays = useMemo(() => {
    if (!openDaySet || !openInfo || openInfo === "unavailable")
      return new Set<string>();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const edge = new Date(`${today}T12:00:00Z`);
    edge.setUTCDate(edge.getUTCDate() + openInfo.scanDays);
    const lastScanned = edge.toISOString().slice(0, 10);
    const out = new Set<string>();
    for (const d of dayFirstDays) {
      if (d < lastScanned && !openDaySet.has(d)) out.add(d);
    }
    return out;
  }, [dayFirstDays, openDaySet, openInfo, tz]);

  // Which day the AUTO-select landed on (null after any manual pick) — only an
  // auto-picked day may be silently re-aimed when real availability arrives.
  const autoPickedDay = useRef<string | null>(null);

  // Days the API has told us are EMPTY this session. The open-days scan can be
  // missing (request failed), stale (60s cache), or simply not back yet, so the
  // day we auto-land on is a guess until its own bundles arrive. Recording the
  // duds lets the auto-hop below skip them and keeps the "Next available"
  // button from pointing at one. A ref so the async hop reads the live set;
  // the version counter is only there to re-render the button.
  const emptyDaysRef = useRef<Set<string>>(new Set());
  const [, bumpEmptyDays] = useState(0);
  function markDayEmpty(day: string) {
    if (emptyDaysRef.current.has(day)) return;
    emptyDaysRef.current.add(day);
    bumpEmptyDays((v) => v + 1);
  }

  // The days worth trying, freshest-first-known: real availability when we have
  // it, else the weekday heuristic. Held in a ref because the auto-hop runs
  // inside an async transition and must not read a stale render's closure.
  const candidateDaysRef = useRef<string[]>([]);
  /** Next day after `day` that we have no evidence against. */
  function nextCandidateDay(day: string): string | null {
    return (
      candidateDaysRef.current.find(
        (d) => d > day && !emptyDaysRef.current.has(d),
      ) ?? null
    );
  }
  // How many empty days the page may skip on its own before it stops and shows
  // the honest empty state. Bounded so a shop with nothing open anywhere can
  // never turn this into a walk through all 45 scanned days.
  const MAX_AUTO_HOPS = 10;
  const autoHops = useRef(0);
  useEffect(() => {
    candidateDaysRef.current = openDaySet
      ? [...openDaySet].sort()
      : [...calendarDays].sort();
  }, [openDaySet, calendarDays]);
  // Set when the "Soonest available" chip is tapped: once that day's bundles
  // load, bind this exact service + slot so one tap really books the soonest.
  const pendingSoonest = useRef<{ serviceId: string; startsAt: string } | null>(
    null,
  );

  // Calendar month shown before the customer picks one: the first offered day,
  // else the CURRENT shop-tz month. Never a hardcoded past month - a shop with
  // no availability yet must still show today's calendar (with the empty-state
  // note below it), not a dead page.
  const dayFirstFallbackMonth = useMemo(() => {
    const first = [...calendarDays].sort()[0];
    if (first) return monthKey(first);
    return monthKey(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    );
  }, [calendarDays, tz]);

  // Auto-select the soonest bookable day on open, so the page arrives with a
  // date already highlighted and every service showing that day's times — the
  // customer sees real availability without tapping anything. Runs once
  // (dayDate is only null before the first pick). Uses whatever the calendar
  // currently offers — the heuristic at first paint, so the page is instant.
  useEffect(() => {
    if (dayDate !== null) return;
    const first = [...calendarDays].sort()[0];
    if (first) {
      autoPickedDay.current = first;
      pickDay(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendarDays]);

  // When the engine's answer lands: if the auto-pick landed on a day with
  // nothing actually open (the classic: it's 9 PM, today's weekday qualifies
  // but today's slots are gone), quietly re-aim at the first truly open day —
  // "it should open on the next day available". Never touches a manual pick
  // or a chosen time.
  useEffect(() => {
    if (!openDaySet) return;
    if (dayDate === null || autoPickedDay.current !== dayDate) return;
    if (openDaySet.has(dayDate) || slot !== null) return;
    const first = [...openDaySet].sort()[0];
    if (first && first !== dayDate) {
      autoPickedDay.current = first;
      pickDay(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDaySet, dayDate]);

  // Monotonic fetch id: taps can outrun responses, and a SLOW response landing
  // after a newer pick used to overwrite the newer day's times while the
  // calendar highlight stayed put — chips show time-of-day only, so the
  // customer would book day A believing it was day B, and the server would
  // happily accept the (genuinely valid) day-A slot.
  const daySeq = useRef(0);

  function pickDay(day: string) {
    setDayDate(day);
    setDayMonth(monthKey(day));
    setServiceId(null);
    // Deliberately NOT resetting expandedGroups: switching days keeps the
    // customer's opened cards open (compare times across days in place).
    setAddOnIds([]);
    clearSlotPick();
    setDayLoading(true);
    setDayData(null);
    setDayError(false);
    const seq = ++daySeq.current;
    startTransition(async () => {
      const res = await getDayBundlesAction(data.shop.slug, day);
      if (seq !== daySeq.current) return; // superseded by a newer pick — drop it

      // AUTO-HOP. The day's own bundles are the authoritative answer, and this
      // is the first point where a landing day can be PROVEN dead. If the page
      // chose this day itself and it came back with nothing, move on to the
      // next candidate instead of parking the customer on an empty day —
      // "should start on the next date available" (Drick). This is deliberately
      // driven by the day payload rather than the open-days scan, so it still
      // works when that scan failed, went stale, or hasn't landed: those are
      // exactly the cases that produced the dead end. A MANUAL pick is never
      // hopped — if someone taps a specific date they get an honest answer for
      // that date.
      if (res.ok && res.data) {
        const empty =
          res.data.bundles.length === 0 && res.data.ungrouped.length === 0;
        if (empty && autoPickedDay.current === day) {
          markDayEmpty(day);
          const next =
            autoHops.current < MAX_AUTO_HOPS ? nextCandidateDay(day) : null;
          if (next) {
            autoHops.current += 1;
            autoPickedDay.current = next;
            pickDay(next); // owns the loading/day state from here
            return;
          }
        }
      }

      if (res.ok && res.data) setDayData(res.data);
      else setDayError(true);
      setDayLoading(false);
      // Soonest-chip tap: the day is loaded — now bind the exact service+slot
      // it promised, so the tap goes straight to the details step.
      const target = pendingSoonest.current;
      if (target && res.ok && res.data) {
        pendingSoonest.current = null;
        const all = [
          ...res.data.bundles.flatMap((b) => b.services),
          ...res.data.ungrouped,
        ];
        const svc = all.find((s) => s.id === target.serviceId);
        const hit = svc?.slots.find((x) => x.startsAt === target.startsAt);
        if (svc && hit) {
          // Open the service's group card too (groups start collapsed), so
          // backing out of the details step lands on the relevant card open.
          const bundle = res.data.bundles.find((b) =>
            b.services.some((s) => s.id === svc.id),
          );
          if (bundle) {
            setExpandedGroups((prev) => new Set(prev).add(bundle.id));
          }
          pickDaySlot(svc, hit);
        }
        // Sold out in the seconds since? The day's real times are showing —
        // honest fallback, nothing to fake.
      }
    });
  }

  /** "Soonest available" chip: jump to the earliest bookable slot anywhere. */
  function pickSoonestOpen() {
    const s = openInfo && openInfo !== "unavailable" ? openInfo.soonest : null;
    if (!s) return;
    pendingSoonest.current = { serviceId: s.serviceId, startsAt: s.startsAt };
    autoPickedDay.current = null; // deliberate pick — never re-aimed
    pickDay(s.date);
  }

  /** Tap a time in the day view: bind service + slot (+ barber) and go to details. */
  function pickDaySlot(svc: DayService, s: DayService["slots"][number]) {
    setServiceId(svc.id);
    setAddOnIds([]);
    commitSlotPick({
      svcId: svc.id,
      startsAt: s.startsAt,
      staffIds: s.staffIds,
      targeted: s.targeted ?? null,
      room: s.maxExtraMin,
    });
  }

  // The selected day's menu: every bundle/service the API returned as having an
  // opening that day (it already omits the rest). Each service carries its own
  // bookable time chips, which is where the customer picks a time — there is no
  // separate time rail to reconcile with.
  const visibleDay = useMemo(() => {
    if (!dayData) return null;
    return { bundles: dayData.bundles, ungrouped: dayData.ungrouped };
  }, [dayData]);

  // AUTO-EXPAND on a quiet day. Groups collapse by default so a long menu stays
  // scannable, but on a day whose only availability is one or two specials the
  // customer lands on closed cards and sees NO times - which is what a barber
  // reported as "my after-hours slots aren't appearing". See ./autoExpand.
  //
  // Keyed on dayData, so it runs once per loaded day and never fights a manual
  // collapse on the day you are already looking at. Additive (never closes a
  // card the customer opened).
  useEffect(() => {
    if (!dayData) return;
    const open = groupsToAutoExpand(dayData.bundles, dayData.ungrouped);
    if (open.length === 0) return;
    setExpandedGroups((cur) => {
      if (open.every((id) => cur.has(id))) return cur; // no-op: don't re-render
      const next = new Set(cur);
      for (const id of open) next.add(id);
      return next;
    });
  }, [dayData]);
  /** The selected day loaded and has nothing bookable on it. */
  const dayEmpty =
    visibleDay !== null &&
    visibleDay.bundles.length === 0 &&
    visibleDay.ungrouped.length === 0;

  /** One service's row in the day view: name + that-day price + time chips. */
  function dayServiceRow(svc: DayService) {
    const stripe = serviceColorHex(svc.color);
    const chips = svc.slots;
    return (
      <div
        key={svc.id}
        className="overflow-hidden rounded-xl border"
        style={{
          borderColor: "rgba(255,255,255,0.12)",
          borderLeft: stripe ? `3px solid ${stripe}` : undefined,
        }}
      >
        <div className="px-4 py-3">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{svc.name}</span>
            {svc.price !== null && (
              <span className="shrink-0 text-sm text-muted">${svc.price}</span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-muted">{svc.durationMin} min</span>
          {/* The photo and blurb the barber wrote in the service editor. Both
              have shipped in this payload since the day-first layout landed and
              neither has ever been rendered: the only markup that read them sat
              inside a `{!dayFirst && ...}` branch, and dayFirst is hardcoded
              true. The editor promises three times over that this is "what the
              customer sees when they pick this service" - so it now is.
              whitespace-pre-line preserves the "INCLUDES:" lists barbers type. */}
          {(svc.imageUrl || svc.description) && (
            <div className="mt-2 flex items-start gap-3">
              {svc.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={svc.imageUrl}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-lg object-cover"
                />
              )}
              {svc.description && (
                <p className="min-w-0 whitespace-pre-line text-xs leading-relaxed text-muted">
                  {svc.description}
                </p>
              )}
            </div>
          )}
          <div className="mt-2.5 flex flex-wrap gap-2">
            {chips.map((s) => {
              // Compound key incl. the targeted id (same as the service-first
              // grid): a special and a normal slot can share the same instant
              // on different barbers, and only ONE of them may light up - they
              // carry different prices.
              const chosen =
                slot === s.startsAt &&
                serviceId === svc.id &&
                (slotTargeted?.id ?? null) === (s.targeted?.id ?? null);
              return (
                <button
                  key={`${s.startsAt}-${s.targeted?.id ?? "grid"}`}
                  type="button"
                  onClick={() => pickDaySlot(svc, s)}
                  aria-pressed={chosen}
                  className="rounded-lg border px-3 py-1.5 text-xs transition-colors"
                  style={{
                    // A special keeps its gold even when it isn't the chosen
                    // chip, so it reads as "extra" while scanning the grid.
                    borderColor: s.targeted
                      ? SPECIAL_GOLD
                      : chosen
                        ? accent
                        : "rgba(255,255,255,0.15)",
                    backgroundColor: s.targeted
                      ? `${SPECIAL_GOLD}${chosen ? "2E" : "14"}`
                      : chosen
                        ? `${accent}14`
                        : "transparent",
                    color: s.targeted ? SPECIAL_GOLD : chosen ? accent : undefined,
                  }}
                >
                  {s.targeted && (
                    <span aria-hidden className="mr-1">
                      ★
                    </span>
                  )}
                  {timeFmt.format(new Date(s.startsAt))}
                  {s.targeted && (
                    <span className="ml-1 opacity-80">
                      · ${s.targeted.price}
                      {s.targeted.label ? ` · ${s.targeted.label}` : ""}
                    </span>
                  )}
                  {/* A time-of-day window's own price/length (the API attaches
                      these only when they differ from the day-level card). */}
                  {!s.targeted && (s.price !== undefined || s.durationMin !== undefined) && (
                    <span className="ml-1 opacity-80">
                      {s.price !== undefined && s.price !== null ? ` · $${s.price}` : ""}
                      {s.durationMin !== undefined ? ` · ${s.durationMin} min` : ""}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // Does the CHOSEN service have more than one barber? If so we keep the
  // "Choose your provider" step; a single-barber service skips it and jumps
  // straight to the calendar (loaded for that lone barber in pickService).
  const isMultiBarber = serviceId !== null && staffForService.length > 1;
  // The time step is step 2 when provider is skipped, step 3 otherwise.
  const timeStepNo = isMultiBarber ? 3 : 2;
  // Day-first flow is always day -> time -> details, so details is step 3.
  const detailsStepNo = dayFirst ? 3 : isMultiBarber ? 4 : 3;

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

  /**
   * Human-readable label for a calendar day key (for the day cell's accessible
   * name), e.g. "Mon, Aug 3". For an open day we format the first slot's REAL
   * instant (correct in the shop tz); for an empty day we anchor the key at
   * noon UTC so the date can't drift into the previous/next day in the viewer's
   * zone (the same trap the old day-strip's comment warned about).
   */
  function labelForDay(dayStr: string): string {
    const first = slotsByDay.get(dayStr)?.[0]?.startsAt;
    return dateFmt.format(new Date(first ?? `${dayStr}T12:00:00Z`));
  }

  /** Clear the chosen time (and any targeted-slot / picked-barber riding on it). */
  function clearSlotPick() {
    setSlot(null);
    setSlotTargeted(null);
    setPickedStaffId(null);
    // Invalidate any upsell fetch still in flight for the old slot.
    upsellToken.current += 1;
    setSlotRoomMin(null);
    setUpgrades([]);
  }

  /**
   * Commit a chosen time — the ONE place both pick surfaces go through (the day
   * view's service chips and the per-service calendar's time grid), so the
   * upsell can never be wired to one and silently missing from the other.
   *
   * `room` is the slot's own spare minutes, applied immediately so the add-on
   * list narrows the instant the chip is tapped. The upgrade offers need the
   * server and land a moment later.
   */
  function commitSlotPick(args: {
    svcId: string;
    startsAt: string;
    staffIds: string[];
    targeted?: { id: string; price: number; label: string | null } | null;
    room?: number | undefined;
  }) {
    const staffId = args.staffIds[0] ?? null;
    setSlot(args.startsAt);
    setSlotTargeted(args.targeted ?? null);
    setPickedStaffId(staffId);

    const token = (upsellToken.current += 1);
    // A targeted slot is fixed-length, fixed-price inventory: nothing to extend
    // and nothing to upgrade into, so don't offer (or fetch) either.
    if (args.targeted) {
      setAddOnIds([]);
      setSlotRoomMin(null);
      setUpgrades([]);
      return;
    }
    setSlotRoomMin(args.room ?? null);
    pruneAddOnsToRoom(args.room ?? null);
    setUpgrades([]);
    if (!staffId) return;
    startTransition(async () => {
      const res = await getUpgradesAction(data.shop.slug, {
        startsAt: args.startsAt,
        staffId,
        serviceId: args.svcId,
      });
      // A newer pick (or a cleared one) happened while this was in flight.
      if (token !== upsellToken.current) return;
      if (!res) return; // an upsell that can't load is simply not shown
      setUpgrades(res.upgrades);
      // The server's number is authoritative — it re-derived the slot rather
      // than trusting the payload the page was holding, so a stale calendar
      // can't leave an over-long booking selected.
      setSlotRoomMin(res.maxExtraMin);
      pruneAddOnsToRoom(res.maxExtraMin);
    });
  }

  /**
   * Load availability for a service across the given barbers, merged into one
   * calendar. `staffPool` is the lone barber for a single-barber shop, or the
   * one the customer chose for a multi-barber shop.
   */
  function loadSlots(svc: string, staffPool: string[], keepStartsAt?: string) {
    setLoadingSlots(true);
    setError(null);
    setLoadedPool(staffPool); // remember the pool so a slot_taken retry reloads it
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
      bucketSlots(res.data, svc, staffPool, keepStartsAt);
      setLoadingSlots(false);
    });
  }

  function bucketSlots(
    result: MergedSlotsResult,
    svc: string,
    staffPool: string[],
    keepStartsAt?: string,
  ) {
    const map = new Map<string, DaySlot[]>();
    for (const s of result.slots) {
      const key = dayKey(s.startsAt);
      const list = map.get(key) ?? [];
      list.push({
        startsAt: s.startsAt,
        staffIds: s.staffIds,
        maxExtraMin: s.maxExtraMin,
      });
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
    // Reloading UNDER a pick the customer already made (they upgraded to a
    // longer service at the same time): keep their slot and the day it lives
    // on. The upgrade was confirmed against this exact instant by the server,
    // so the new service really does offer it - blanking the pick here would
    // throw away a valid choice and drop them back to an empty calendar.
    if (keepStartsAt) {
      const keepDay = dayKey(keepStartsAt);
      setDay(keepDay);
      setViewMonth(monthKey(keepDay));
      return;
    }
    // Land on the first day with availability, and open its month in the calendar.
    const firstDay = [...map.keys()].sort()[0] ?? null;
    setDay(firstDay);
    setViewMonth(firstDay ? monthKey(firstDay) : monthKey(dayKey(new Date().toISOString())));
    clearSlotPick();
  }

  /**
   * Take an upgrade: same time, same barber, a longer and dearer service.
   *
   * The server already confirmed this exact instant is bookable for the new
   * service (that is the whole point of /upgrades), so the pick survives the
   * swap. Add-ons are dropped because they belong to the OLD service — the new
   * one has its own list, and its own remaining room, both of which arrive from
   * the fresh /upgrades call that commitSlotPick fires.
   *
   * The per-service calendar is reloaded underneath so its chips describe the
   * service the customer now has: leaving the old service's grid on screen
   * would let them tap a time that isn't on the new service's grid, which the
   * booking POST rejects.
   */
  function applyUpgrade(u: UpgradeOffer) {
    if (!slot) return;
    const staffIds = pickedStaffId ? [pickedStaffId] : [];
    setServiceId(u.serviceId);
    setAddOnIds([]);
    commitSlotPick({
      svcId: u.serviceId,
      startsAt: slot,
      staffIds,
      targeted: null,
      room: undefined, // unknown until /upgrades answers for the new service
    });
    // Only the per-service calendar needs rebuilding; the day view's chips are
    // already per-service and complete.
    if (staffId && slotsByDay.size > 0) {
      loadSlots(u.serviceId, staffPoolFor(u.serviceId), slot);
    }
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

  /**
   * Rebook prefill: land the client on the calendar for the service (and
   * barber) they had last time, so all that is left is picking a time.
   *
   * 🔴 VALIDATED, NEVER TRUSTED. The ids come off a URL that may be months old
   * and forwarded to anyone. A service that has been retired, renamed away, or
   * a barber who has left, must not error and must not silently book something
   * else - it degrades to the ordinary booking page, which is exactly what the
   * client would have seen anyway.
   *
   * 🔴 Deliberately skipped during the demo tour: the tour drives the same
   * controls, and two auto-drivers racing would land somewhere neither meant.
   */
  const prefilled = useRef(false);
  useEffect(() => {
    if (demoTour || prefilled.current || !prefill) return;
    if (serviceId || bookableServices.length === 0) return;
    prefilled.current = true;

    const svc = prefill.serviceId
      ? bookableServices.find((s) => s.id === prefill.serviceId)
      : undefined;
    if (!svc) return; // unknown or no-longer-bookable service: ordinary flow

    const pool = staffPoolFor(svc.id);
    // The barber only survives if they still work here AND still do this
    // service; otherwise the client picks, rather than us choosing for them.
    const stf =
      prefill.staffId && pool.includes(prefill.staffId)
        ? data.staff.find((s) => s.id === prefill.staffId)
        : undefined;

    pickService(svc.id);
    // pickService already loads the calendar for a single-barber service; only
    // force it for a multi-barber one, so this costs exactly one fetch either way.
    if (stf && pool.length > 1) {
      setStaffId(stf.id);
      loadSlots(svc.id, [stf.id]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, demoTour, bookableServices.length]);

  // Add-ons valid for the chosen service (shop-wide null, or scoped to it).
  const addOnsForService = useMemo(() => {
    if (!serviceId) return [];
    return data.addOns.filter(
      (a) => a.serviceIds.length === 0 || a.serviceIds.includes(serviceId),
    );
  }, [serviceId, data.addOns]);

  /**
   * Add-on time already spoken for, and what's left of the slot's room.
   *
   * Add-ons STACK: the engine checks the SUM against the free window, so "each
   * one is shorter than the gap" is the wrong test — two 15-minute extras don't
   * both fit in 25 minutes. Everything below reasons about the remaining room,
   * never about a single add-on in isolation.
   *
   * null = room unknown (no slot picked yet, or a targeted slot). Unknown must
   * mean "no restriction", not "nothing fits", or a shop whose slots predate
   * this field would show an empty add-on list.
   */
  const addOnMinutesChosen = addOnsForService
    .filter((a) => addOnIds.includes(a.id))
    .reduce((sum, a) => sum + a.durationMin, 0);
  const roomLeftMin = slotRoomMin === null ? null : slotRoomMin - addOnMinutesChosen;

  /** Can this add-on still be turned ON? (Turning one OFF is always allowed.) */
  function addOnFits(a: { id: string; durationMin: number }): boolean {
    if (addOnIds.includes(a.id) || roomLeftMin === null) return true;
    return a.durationMin <= roomLeftMin;
  }

  function toggleAddOn(id: string) {
    setAddOnIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  /**
   * Keep only the add-ons that still fit once the room changes (picking a
   * different time). Greedy in selection order, so the customer keeps as much
   * of their choice as the new slot allows instead of losing all of it.
   *
   * Without this, choosing extras at a slot with an hour of room and then
   * moving to one with ten minutes sends an over-long booking that the create
   * endpoint rejects with invalid_slot — at the final step, which is the worst
   * place to discover it.
   */
  function pruneAddOnsToRoom(room: number | null) {
    if (room === null) return;
    setAddOnIds((cur) => {
      let used = 0;
      const kept: string[] = [];
      for (const id of cur) {
        const a = data.addOns.find((x) => x.id === id);
        if (!a) continue;
        if (used + a.durationMin > room) continue;
        used += a.durationMin;
        kept.push(id);
      }
      return kept.length === cur.length ? cur : kept;
    });
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
      setError("Please add your first name.");
      return;
    }
    // Last name is REQUIRED on the customer flow (it is not on the barber's own
    // walk-in form, where a first name is often all he has). Two "Mike"s in one
    // client list are indistinguishable in search, in the agenda, and in every
    // reminder — the barber ends up guessing which one is in his chair.
    if (!lastName.trim()) {
      setError("Please add your last name.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Add a phone or email so we can confirm.");
      return;
    }
    // Confirmations go by email, so a phone-only booking would be silent - the
    // customer would never be told it exists. Caught here so they fix it at the
    // field instead of bouncing off the server.
    if (data.shop.emailRequired && !email.trim()) {
      setError("Add your email — that's where your confirmation goes.");
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
        lastName: lastName.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        smsConsent: consent && Boolean(phone.trim()),
        // A targeted slot has a fixed length/price - no add-ons.
        addOnIds:
          !slotTargeted && addOnIds.length > 0 ? addOnIds : undefined,
        targetedSlotId: slotTargeted?.id,
        // Sent only when the control was visible for it - the same conditions
        // that hide it. A repeat chosen before an add-on was added is not
        // sent, which matches what the customer can see on the screen.
        recurrence:
          repeatOffered && repeat ? { interval: repeat.interval, count: repeat.count } : undefined,
      });
      if (!res.ok) {
        if (res.error === "slot_taken") {
          setError("That time was just taken. Pick another slot.");
          // Refresh availability so the taken slot disappears — day-first
          // refetches the whole day; service-first reloads the SAME pool the
          // calendar was built from (not just one barber), so a merged
          // multi-barber calendar doesn't collapse to a single provider.
          if (dayFirst && dayDate) pickDay(dayDate);
          else if (serviceId && loadedPool.length) loadSlots(serviceId, loadedPool);
          clearSlotPick();
        } else if (res.error === "no_active_access") {
          setError(
            `Online booking is paused for ${data.shop.name} right now. Please contact the shop directly to book.`,
          );
        } else if (res.error === "invalid_slot" && addOnIds.length > 0) {
          setError(
            "With those add-ons this appointment runs longer than that slot. Try fewer add-ons or a different time.",
          );
        } else if (res.error === "invalid_slot") {
          // The offered time is no longer bookable - almost always because the
          // day moved under them (someone booked, or the barber edited hours)
          // while this page sat open. Say what to DO. This read as
          // "Something went wrong" during the Sep boundary-slot outage, which
          // is why a real customer concluded the product was broken instead of
          // picking another time.
          setError("That time isn't available anymore. Pick another slot.");
          if (dayFirst && dayDate) pickDay(dayDate);
          else if (serviceId && loadedPool.length) loadSlots(serviceId, loadedPool);
          clearSlotPick();
        } else if (res.error === "day_full") {
          // The API distinguishes "this TIME went" from "this DAY is done" on
          // purpose (a per-service daily cap). Without its own copy this read
          // as "Something went wrong", and the customer retried the same full
          // day until they gave up.
          setError(
            "That day is fully booked for this service. Try another day.",
          );
          if (dayFirst && dayDate) pickDay(dayDate);
          else if (serviceId && loadedPool.length) loadSlots(serviceId, loadedPool);
          clearSlotPick();
        } else if (res.error === "slot_unavailable_external") {
          // The shop's external calendar (Acuity/Square) refused the mirror, so
          // the booking was rolled back. Their calendar is the authority here.
          setError(
            "That time was just taken on the shop's calendar. Pick another slot.",
          );
          if (dayFirst && dayDate) pickDay(dayDate);
          else if (serviceId && loadedPool.length) loadSlots(serviceId, loadedPool);
          clearSlotPick();
        } else {
          setError("Something went wrong. Please try again.");
        }
        return;
      }
      // Pay-ahead: the booking is created; collect payment before confirming.
      if (res.paymentClientSecret) {
        setManageTokenPending(res.manageToken ?? null);
        setPaymentSecret(res.paymentClientSecret);
        setPayCharge(
          res.paymentAmountCents != null
            ? {
                amountCents: res.paymentAmountCents,
                isDeposit: res.paymentIsDeposit ?? false,
                balanceDueCents: res.paymentBalanceDueCents ?? 0,
                holdMinutes: res.paymentHoldMinutes ?? null,
                expiresAt: res.paymentExpiresAt ?? null,
              }
            : null,
        );
        return;
      }
      setWasRequest(Boolean(res.pending));
      setSeriesResult(res.series ?? null);
      setConfirmedToken(res.manageToken ?? null);
    });
  }

  /**
   * The card cleared. Now find out whether ChairBack actually has a booking.
   *
   * Polls the manage endpoint - the one authority that knows, because it reads
   * the appointment row the webhook promotes. Deliberately bounded: after
   * ~25 seconds we stop guessing and tell the customer exactly where things
   * stand, which is far better than either a false confirmation or a spinner
   * with no end.
   */
  async function confirmAfterPayment(token: string) {
    setPayConfirm("checking");
    const deadline = Date.now() + 25_000;
    for (;;) {
      const res = await bookingStatusAction(token);
      if (res.ok && res.status === "BOOKED") {
        setPayConfirm("no");
        setConfirmedToken(token);
        return;
      }
      // The hold lapsed and the sweep took it (the payment is refunded in
      // full by the same path). Saying so is the only honest option - the
      // alternative is a confirmation for an appointment that does not exist.
      if (res.ok && (res.status === "CANCELED" || res.status === "NO_SHOW")) {
        setPayConfirm("gone");
        return;
      }
      if (Date.now() >= deadline) {
        setPayConfirm("slow");
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // When the repeat control may be shown - and, identically, when a chosen
  // repeat is sent. One expression for both, so they cannot drift.
  const repeatOffered =
    data.shop.recurringAvailable === true && !slotTargeted && addOnIds.length === 0;
  const repeatMax = Math.max(2, Math.min(52, data.shop.recurringMaxCount ?? 12));

  // Sorted day keys (YYYY-MM-DD; lexicographic == chronological). Everything
  // downstream — the calendar month fallback, the soonest slot, availableDays —
  // derives from this one memo instead of re-sorting the map repeatedly.
  const days = useMemo(() => [...slotsByDay.keys()].sort(), [slotsByDay]);
  const daySlots = day ? (slotsByDay.get(day) ?? []) : [];

  // Set of days (YYYY-MM-DD) that actually have open times — the calendar makes
  // exactly these tappable and dims the rest.
  const availableDays = useMemo(() => new Set(days), [days]);

  // The earliest open time across all loaded days (for the "soonest" button).
  // Slots within a day are already time-sorted; the first day is the earliest.
  const soonest = useMemo(() => {
    const firstDay = days[0];
    if (!firstDay) return null;
    const first = (slotsByDay.get(firstDay) ?? [])[0];
    return first ? { day: firstDay, slot: first } : null;
  }, [days, slotsByDay]);

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
  // The barber the booking will actually be written against — named in the
  // upgrade offer so "keeps your time" is a concrete promise, not a vague one.
  const pickedStaffName = pickedStaffId
    ? (data.staff.find((s) => s.id === pickedStaffId)?.name ?? null)
    : null;

  /** Shop-tz weekday (0=Sun..6=Sat) for an ISO instant, matching the API. */
  function weekdayInTz(iso: string): number {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
      new Date(iso),
    );
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 0;
  }

  /**
   * The effective price for a service at a chosen SLOT instant, matching the
   * API's layer order: the time-of-day window covering the slot's shop-local
   * start minute, else that date's weekday override, else the base price.
   */
  function priceForSlot(
    svc: {
      price: number | null;
      priceOverrides: Record<string, number>;
      timeOverrides: {
        s: number;
        e: number;
        /** Weekdays the window repeats on; [] = every day. */
        days?: number[];
        price: number | null;
      }[];
    },
    iso: string,
  ): number | null {
    const minute = zonedMinutesOfDay(new Date(iso), tz);
    const weekday = weekdayInTz(iso);
    // A window matches on TIME **and** DAY. Matching on the minute alone would
    // quote a Sunday-only evening rate on every night of the week - and this
    // number is what the customer is shown before they book.
    const win = svc.timeOverrides.find(
      (w) =>
        minute >= w.s &&
        minute < w.e &&
        (!w.days || w.days.length === 0 || w.days.includes(weekday)),
    );
    if (win && win.price !== null) return win.price;
    const wd = String(weekday);
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
      ? priceForSlot(selectedService, slot)
      : null;
  // Chosen add-ons' extra price + the combined total shown before booking.
  const addOnsTotal = addOnsForService
    .filter((a) => addOnIds.includes(a.id))
    .reduce((sum, a) => sum + (a.price ?? 0), 0);
  const grandTotal = selectedPrice === null ? null : selectedPrice + addOnsTotal;
  /**
   * One short line telling the customer whether the price they are looking at
   * already has a tip in it.
   *
   * null when the barber has not chosen (and when an older API omits the
   * field entirely) - the page then says nothing at all. Saying "tip not
   * included" for a shop that never said so would invent a policy on their
   * behalf, and saying "included" wrongly would cost their staff money.
   */
  const tipNote =
    data.shop.tipPolicy === "included"
      ? "Tip included"
      : data.shop.tipPolicy === "not_included"
        ? "Tip not included"
        : null;
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
            {payCharge?.isDeposit ? "Deposit to confirm" : "Pay to confirm"}
          </h1>
          <p className="mt-1 mb-4 text-sm text-muted">
            {payCharge?.isDeposit ? (
              <>
                Your time is held. Pay a{" "}
                <strong className="text-offwhite">
                  ${(payCharge.amountCents / 100).toFixed(0)} deposit
                </strong>{" "}
                to lock it in
                {payCharge.balanceDueCents > 0 ? (
                  <>
                    {" "}
                    — the remaining{" "}
                    <strong className="text-offwhite">
                      ${(payCharge.balanceDueCents / 100).toFixed(0)}
                    </strong>{" "}
                    is due at {data.shop.name}.
                  </>
                ) : (
                  <> with {data.shop.name}.</>
                )}
              </>
            ) : (
              <>
                Your time is held. Enter payment to lock in your appointment
                with {data.shop.name}.
              </>
            )}
          </p>
          {/*
            The hold is a real deadline now - the appointment does not exist
            until this payment lands, and the chair goes back on sale when the
            window closes. Saying so is the difference between a customer who
            finishes and one who wanders off assuming they are booked.
          */}
          {payCharge?.expiresAt ? (
            <HoldCountdown expiresAt={payCharge.expiresAt} />
          ) : payCharge?.holdMinutes ? (
            <p className="mb-4 text-xs text-muted">
              We&rsquo;ll hold this time for {payCharge.holdMinutes} minutes.
              Your appointment isn&rsquo;t confirmed until this payment goes
              through.
            </p>
          ) : null}
          {/*
            The tip question lands hardest HERE - a card is out and a number is
            on the button. On a DEPOSIT the wording has to be different: the
            deposit is not the whole ticket, so “tip not included” would read
            as though the tip were the only thing left to pay.
          */}
          {tipNote !== null ? (
            <p className="mb-4 text-xs text-muted">
              {payCharge?.isDeposit
                ? data.shop.tipPolicy === "included"
                  ? "Tip is included in your total."
                  : "Tip is not included in your total."
                : data.shop.tipPolicy === "included"
                  ? "Tip is included — nothing more to pay at the shop."
                  : "Tip is not included — you can tip at the shop."}
            </p>
          ) : null}
          {payConfirm === "checking" ? (
            <p role="status" className="py-6 text-center text-sm text-muted">
              Payment received. Confirming your booking&hellip;
            </p>
          ) : payConfirm === "slow" ? (
            <div role="status" className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm">
              <p className="font-medium">Your payment went through.</p>
              <p className="mt-1 text-muted">
                We&rsquo;re still confirming with {data.shop.name} — this
                usually takes a few seconds. Your confirmation will arrive by
                email, and you can check this link any time.
              </p>
              {manageTokenPending && (
                <Link
                  href={`/book/manage/${manageTokenPending}`}
                  className="mt-3 inline-block underline underline-offset-4"
                >
                  Check my appointment
                </Link>
              )}
            </div>
          ) : payConfirm === "gone" ? (
            <div role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-200">
              <p className="font-medium">That time was released before the payment landed.</p>
              <p className="mt-1 text-amber-200/80">
                You have not been charged — anything taken is refunded in full.
                Please pick another time, or call {data.shop.name}.
              </p>
            </div>
          ) : (
            <PaymentStep
              clientSecret={paymentSecret}
              amountLabel={
                payCharge
                  ? `$${(payCharge.amountCents / 100).toFixed(0)}`
                  : selectedPrice !== null
                    ? `$${selectedPrice.toFixed(0)}`
                    : null
              }
              accent={accent}
              // Where a redirect-based method returns to. The manage page is
              // the honest destination: it survives losing every scrap of
              // component state and shows the appointment itself.
              returnUrl={
                manageTokenPending && typeof window !== "undefined"
                  ? `${window.location.origin}/book/manage/${manageTokenPending}`
                  : typeof window !== "undefined"
                    ? window.location.href
                    : ""
              }
              onPaid={() => {
                if (manageTokenPending) void confirmAfterPayment(manageTokenPending);
                else setPayConfirm("slow");
              }}
            />
          )}
          {payConfirm === "no" && (
            <p className="mt-3 text-center text-[11px] text-muted">
              Powered by Stripe. Your card details never touch {data.shop.name}.
            </p>
          )}
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
          {/* Spell out WHEN — "You're booked!" with no date/time forced the
              customer into the manage page just to see what they booked. */}
          {slot !== null && (
            <p className="mt-2 text-base font-semibold">
              {dateFmt.format(new Date(slot))} · {timeFmt.format(new Date(slot))}
              {selectedService ? (
                <span className="font-normal text-muted"> · {selectedService.name}</span>
              ) : null}
            </p>
          )}
          {/* A standing appointment: what actually landed, and WHICH dates did
              not. A customer who asked for twelve and got ten must hear it
              here, not from a missing reminder in March. */}
          {seriesResult && (
            <p className="mt-2 text-sm">
              <span className="font-semibold">
                {seriesResult.booked} of {seriesResult.total} visits booked
              </span>
              {seriesResult.skipped.length > 0 && (
                <span className="block text-xs text-muted">
                  Already taken, so not booked:{" "}
                  {seriesResult.skipped.map((d) => dateFmt.format(new Date(d))).join(", ")}.
                  Book those separately if you still want them.
                </span>
              )}
            </p>
          )}
          <p className="mt-2 text-sm text-muted">
            {/* Confirmations go by EMAIL now (SMS confirmation is off for
                cost - see appointmentNotify.ts); the reminder TEXT stays. The
                promises below must track the channels that actually fire. */}
            {wasRequest ? (
              <>
                {data.shop.name} will review your request and confirm your time.
                {email.trim()
                  ? " We'll email you as soon as it's approved."
                  : " Save this page to check the status."}
              </>
            ) : (
              <>
                {data.shop.name} has your appointment.
                {email.trim() ? " We'll email your confirmation." : ""}
                {consent && phone.trim() ? " We'll text you a reminder before your visit." : ""}
                {!email.trim() && !(consent && phone.trim())
                  ? " Save this page to manage your appointment."
                  : ""}
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
          {/* Escape hatch: in the app WebView the confirmation was a dead end
              (no browser chrome) — pop back to wherever the customer started
              (rewards home or shop page). */}
          <CustomerBack
            label={`← Back to ${data.shop.name}`}
            className="mt-4 block w-full text-center text-xs text-muted transition-colors hover:text-offwhite"
          />

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
      {/* Swipe down at the top to reload. Open times are the one thing on this
          page that goes stale while you look at it - somebody else books the
          4:30 - and a customer on a phone (or inside the iOS shell, which has
          no browser chrome at all) has no refresh button to reach for.

          Deliberately mounted HERE, in the menu/calendar flow, and not in the
          payment or confirmation screens above: those return early, so the
          gesture simply does not exist on them. A reload after
          `paymentSecret` is issued would throw away the Stripe client secret
          while the slot is already held, and one on the confirmation screen
          would wipe the booking's manage link off the screen. Refreshing must
          never be able to cost a customer the thing they just did. */}
      <PullToRefresh />
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
        {/* The handle, under the name — this page is what gets pasted into an
            Instagram bio, so the trip back to the shop's feed should be one tap.
            Stored without the "@"; we render it. */}
        {data.shop.instagramHandle && (
          <a
            href={`https://instagram.com/${data.shop.instagramHandle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm font-medium text-muted transition-colors hover:text-offwhite"
          >
            @{data.shop.instagramHandle}
          </a>
        )}
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

      {/* The calendar, on top — dates only. The day's actual times live on the
          service cards below (each service shows its own bookable chips), so a
          separate time rail here would just duplicate them. */}
      {dayFirst && (
        <Section
          title="1 · Pick a day"
          back={
            <CustomerBack
              label={`← Back to ${data.shop.name}`}
              fallbackHref={`/s/${data.shop.slug}`}
              className="text-xs text-muted transition-colors hover:text-offwhite"
            />
          }
        >
          {/* Soonest-available shortcut: one tap to the earliest open time
              across every service (the day loads and the exact slot binds). */}
          {openInfo && openInfo !== "unavailable" && openInfo.soonest && (
            <button
              type="button"
              onClick={pickSoonestOpen}
              className="mb-3 flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors"
              style={{
                borderColor:
                  slot === openInfo.soonest.startsAt
                    ? accent
                    : "rgba(255,255,255,0.15)",
              }}
            >
              <span className="text-sm font-semibold" style={{ color: accent }}>
                Soonest available
              </span>
              <span className="text-sm text-muted">
                {dateFmt.format(new Date(openInfo.soonest.startsAt))} ·{" "}
                {timeFmt.format(new Date(openInfo.soonest.startsAt))}
              </span>
            </button>
          )}
          <MonthCalendar
            viewMonth={dayMonth ?? dayFirstFallbackMonth}
            availableDays={calendarDays}
            bookedOutDays={bookedOutDays}
            selectedDay={dayDate}
            accent={accent}
            onAccent={onAccent}
            labelForDay={(d) => dateFmt.format(new Date(`${d}T12:00:00Z`))}
            onPrevMonth={() => setDayMonth((m) => addMonths(m ?? dayFirstFallbackMonth, -1))}
            onNextMonth={() => setDayMonth((m) => addMonths(m ?? dayFirstFallbackMonth, 1))}
            onPickDay={(d) => {
              // A real tap: clear the auto-pick marker (this day is the
              // customer's choice now) and any pending soonest-chip binding.
              autoPickedDay.current = null;
              pendingSoonest.current = null;
              pickDay(d);
              // Scroll to the services, which is where the answer to the tap
              // appears. Deliberately HERE and not inside pickDay: the page
              // auto-picks the soonest open day on load, and scrolling the
              // customer down the page before they've touched anything would
              // be worse than the problem this fixes.
              requestAnimationFrame(() => revealElement(servicesSectionRef.current));
            }}
          />
        </Section>
      )}

      {/* THE MENU — the grouped service cards, right below the calendar. Each
          group is a COLLAPSED dropdown card — one tap opens its services with
          the selected day's open times inside; ungrouped services follow. Fed
          by the selected day's bundle fetch — the soonest open day is
          auto-selected on load, so an opened card shows real times instantly.
          Tapping a service's time chip books it. */}
      {dayFirst && (
        <Section title="2 · Choose a service" tour="services" innerRef={servicesSectionRef}>
          {(dayLoading ||
            (!dayData && !dayError && calendarDays.size > 0) ||
            // Availability still in flight. /day answers in ~1s while the
            // open-days sweep takes several, so an empty landing day would
            // otherwise flash the full "nothing left today" dead end — with no
            // Next-available button, because that needs the sweep — on every
            // single page load before quietly re-aiming. Read as loading until
            // we actually know.
            (openInfo === null && dayEmpty)) && (
            <p className="text-sm text-muted">Checking the day&apos;s openings…</p>
          )}
          {!dayLoading && dayError && (
            <div className="flex flex-wrap items-center gap-3" role="alert">
              <p className="text-sm text-muted">
                Couldn&apos;t load this day&apos;s times.
              </p>
              <button
                type="button"
                onClick={() => dayDate && pickDay(dayDate)}
                className="rounded-full border border-white/15 px-4 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.06]"
              >
                Try again
              </button>
            </div>
          )}
          {!dayLoading && !dayError && calendarDays.size === 0 && (
            <p className="text-sm text-muted">
              No open days right now — check back soon.
            </p>
          )}
          {!dayLoading && dayData && visibleDay && (
            <div className="flex flex-col gap-5">
              {/* Services, grouped into the barber's collapsible group cards.
                  Filtered to those bookable at the chosen time (when set). */}
              {visibleDay.bundles.map((b) => {
                const open = expandedGroups.has(b.id);
                return (
                  <div
                    key={b.id}
                    className="overflow-hidden rounded-xl border border-white/12"
                  >
                    <button
                      type="button"
                      onClick={(e) =>
                        toggleDayGroup(b.id, e.currentTarget.parentElement)
                      }
                      aria-expanded={open}
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold">{b.name}</span>
                        <span className="text-xs text-muted">
                          {b.services.length}{" "}
                          {b.services.length === 1 ? "service" : "services"}
                        </span>
                      </span>
                      <span
                        aria-hidden
                        className="shrink-0 text-muted transition-transform"
                        style={{ transform: open ? "rotate(180deg)" : "none" }}
                      >
                        ▾
                      </span>
                    </button>
                    {open && (
                      <div className="flex flex-col gap-3 border-t border-white/8 p-3">
                        {b.services.map((svc) => dayServiceRow(svc))}
                      </div>
                    )}
                  </div>
                );
              })}
              {visibleDay.ungrouped.length > 0 && (
                <div>
                  {visibleDay.bundles.length > 0 && (
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                      More services
                    </h3>
                  )}
                  <div className="flex flex-col gap-3">
                    {visibleDay.ungrouped.map((svc) => dayServiceRow(svc))}
                  </div>
                </div>
              )}

              {visibleDay.bundles.length === 0 &&
                visibleDay.ungrouped.length === 0 &&
                // Only once availability is known either way — see the loading
                // branch above. Showing a dead end before the sweep lands is
                // what made this screen look final when it wasn't.
                openInfo !== null && (
                <div className="flex flex-col gap-3">
                  {/* Honest booked-out state (Drick: "it should show on a day
                      that is booked out completely that there is no available
                      times"). Today reads differently from a future date, and
                      the two ways forward are right here: the next day with a
                      real opening, and the waitlist (a cancellation or a
                      squeeze-in the barber publishes reopens the day on its
                      own — squeeze-ins count as openings upstream). */}
                  <p className="text-sm text-muted" role="status">
                    {(() => {
                      const shopToday = new Intl.DateTimeFormat("en-CA", {
                        timeZone: tz,
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                      }).format(new Date());
                      if (dayDate === shopToday)
                        return "No available times left today.";
                      return bookedOutDays.has(dayDate ?? "")
                        ? "This day is fully booked."
                        : "Nothing open this day — try another date.";
                    })()}
                  </p>
                  {(() => {
                    // Fall back to the heuristic calendar when the open-days
                    // scan is missing: losing it used to remove the only way
                    // forward from this screen, leaving the waitlist as the
                    // sole option on a shop that was open the very next day.
                    // Days already proven empty are skipped either way.
                    const pool = openDaySet
                      ? [...openDaySet].sort()
                      : [...calendarDays].sort();
                    const nextOpen = pool.find(
                      (d) => d > (dayDate ?? "") && !emptyDaysRef.current.has(d),
                    );
                    if (!nextOpen) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          // Stays eligible for the auto-hop: this button is the
                          // page's own suggestion, not the customer naming a
                          // date, so if it also turns out empty we keep going
                          // rather than dead-ending a second time.
                          autoPickedDay.current = nextOpen;
                          pendingSoonest.current = null;
                          pickDay(nextOpen);
                        }}
                        className="w-full rounded-xl border px-4 py-3 text-left text-sm font-semibold transition-colors"
                        style={{ borderColor: accent, color: accent }}
                      >
                        Next available: {dateFmt.format(new Date(`${nextOpen}T12:00:00Z`))} →
                      </button>
                    );
                  })()}
                  {data.shop.waitlistEnabled &&
                    (waitlistMode === "slot" ? (
                      <WaitlistForm
                        slug={data.shop.slug}
                        shopName={data.shop.name}
                        accent={accent}
                        onDone={() => setWaitlistMode(null)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setWaitlistMode("slot")}
                        className="w-full rounded-xl border py-3 text-center text-sm font-semibold transition-colors"
                        style={{ borderColor: accent, color: accent }}
                      >
                        {/* "get notified", not "get texted": customer SMS stays
                            off until 10DLC clears — openings notify by email. */}
                        Join the waitlist — get notified if a time opens up
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {/* Step 1: service (service-first shops; retained but unreachable while
          the combined groups+calendar layout is forced for every shop). */}
      {!dayFirst && (
      <Section
        title="1 · Choose a service"
        tour="services"
        back={
          // Pops real history when there is any (in the app: back to the
          // rewards home or shop page the customer came from), else falls
          // back to the shop page — never a dead end.
          <CustomerBack
            label={`← Back to ${data.shop.name}`}
            fallbackHref={`/s/${data.shop.slug}`}
            className="text-xs text-muted transition-colors hover:text-offwhite"
          />
        }
      >
        <div className="flex flex-col gap-5">
          {/* Only services a barber actually offers (bookableServices) — an
              unbookable service would dead-end the wizard. Rich card layout
              (photo + description + calendar-color rail) is from #114. When the
              shop has service groups, the menu mirrors that taxonomy: one
              uppercase header per group (members in their saved order), then
              everything ungrouped under "More services" — the same presentation
              as the day view's bundles. No groups = the untouched flat list. */}
          {[
            ...menuSections.sections.map((sec) => ({
              key: sec.id,
              name: sec.name,
              services: sec.services,
            })),
            ...(menuSections.ungrouped.length > 0
              ? [
                  {
                    key: "__ungrouped__",
                    // Headerless when there are no group sections at all.
                    name: menuSections.sections.length > 0 ? "More services" : null,
                    services: menuSections.ungrouped,
                  },
                ]
              : []),
          ].map((sec) => (
            <div key={sec.key}>
              {sec.name && (
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  {sec.name}
                </h3>
              )}
              <div className="flex flex-col gap-2">
                {sec.services.map((s) => {
                  const selected = serviceId === s.id;
                  // The barber's calendar color, echoed as a left-edge accent stripe
                  // so the customer sees the same coding. null = no stripe.
                  const stripe = serviceColorHex(s.color);
                  const durationLabel =
                    s.durationRange.min === s.durationRange.max
                      ? `${s.durationMin} min`
                      : `${s.durationRange.min}-${s.durationRange.max} min`;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => pickService(s.id)}
                      aria-pressed={selected}
                      className="overflow-hidden rounded-xl border text-left transition-colors"
                      style={{
                        borderColor: selected ? accent : "rgba(255,255,255,0.12)",
                        backgroundColor: selected ? `${accent}14` : "transparent",
                        // A 3px color rail on the leading edge when the service has one.
                        borderLeft: stripe ? `3px solid ${stripe}` : undefined,
                      }}
                    >
                      <div className="flex items-start gap-3 px-4 py-3">
                        {s.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={s.imageUrl}
                            alt=""
                            className="h-14 w-14 shrink-0 rounded-lg border border-white/10 object-cover"
                          />
                        ) : null}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="block text-sm font-medium">{s.name}</span>
                            {priceLabel(s) && (
                              <span className="shrink-0 text-sm text-muted">{priceLabel(s)}</span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">{durationLabel}</span>
                          {/* Barber's description. whitespace-pre-line keeps the line
                              breaks so an "INCLUDES:" list renders as a list. */}
                          {s.description && (
                            <span className="mt-1.5 block whitespace-pre-line text-xs leading-relaxed text-muted/90">
                              {s.description}
                            </span>
                          )}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {bookableServices.length === 0 && (
            <p className="text-sm text-muted">No services available yet.</p>
          )}
        </div>
      </Section>
      )}

      {/* Step 2: provider — only for services offered by more than one barber.
          A single-barber service skips this and lands on the calendar. */}
      {!dayFirst && serviceId && isMultiBarber && (
        <Section
          title={`2 · Choose your ${vocab.providerNoun}`}
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
                No open times in the next {data.shop.bookingMaxDays} days.
                {/* Only multi-barber shops have another provider to try; a solo
                    shop's provider step is skipped, so don't send them looking
                    for one that isn't there. */}
                {isMultiBarber ? " Try another provider" : ""}
                {data.shop.waitlistEnabled
                  ? isMultiBarber
                    ? " — or join the waitlist"
                    : " Join the waitlist below"
                  : ""}
                .
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
                    // Match the time-grid's compound key so this can't light up
                    // alongside a different slot that merely shares the instant.
                    borderColor:
                      slot === soonest.slot.startsAt &&
                      (slotTargeted?.id ?? null) === (soonest.slot.targeted?.id ?? null)
                        ? accent
                        : `${accent}66`,
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
                labelForDay={labelForDay}
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
                        // Binds the barber who will actually take this booking
                        // (several may be free at this instant on a merged
                        // fetch), and kicks off the "room for more" offers.
                        if (!serviceId) return;
                        commitSlotPick({
                          svcId: serviceId,
                          startsAt: s.startsAt,
                          staffIds: s.staffIds,
                          targeted: s.targeted ?? null,
                          room: s.maxExtraMin,
                        });
                      }}
                      aria-pressed={picked}
                      className="rounded-lg border py-2 text-center text-sm transition-colors"
                      style={{
                        // Gold marks a special whether or not it's picked; when
                        // picked it fills, so it still reads as the selection.
                        borderColor: s.targeted
                          ? SPECIAL_GOLD
                          : picked
                            ? accent
                            : "rgba(255,255,255,0.12)",
                        backgroundColor: s.targeted
                          ? picked
                            ? SPECIAL_GOLD
                            : `${SPECIAL_GOLD}14`
                          : picked
                            ? accent
                            : "transparent",
                        color: s.targeted
                          ? picked
                            ? readableOn(SPECIAL_GOLD)
                            : SPECIAL_GOLD
                          : picked
                            ? onAccent
                            : undefined,
                      }}
                    >
                      {s.targeted && (
                        <span aria-hidden className="mr-1">
                          ★
                        </span>
                      )}
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

      {/* "You have time for more." Sits between the time the customer just
          picked and the details form, because that is the moment the spare time
          becomes a real, specific fact ("25 minutes, after YOUR 4:00, with
          Drick") rather than a general suggestion.

          Every offer here was confirmed by the booking engine for this exact
          instant, barber and service - never inferred from the size of the gap.
          A longer service walks its own slot grid and carries its own hours and
          group caps, so a gap that LOOKS big enough can still be a time the
          create endpoint refuses. See getUpgradesAction. */}
      {slot && !slotTargeted && upgrades.length > 0 && (
        <div
          className="mb-4 rounded-xl border p-4"
          style={{ borderColor: `${accent}55`, backgroundColor: `${accent}0f` }}
        >
          <p className="text-sm font-semibold" style={{ color: accent }}>
            You have time for more
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {slotRoomMin !== null && slotRoomMin > 0
              ? `Your ${timeFmt.format(new Date(slot))} has ${slotRoomMin} spare min after ${selectedService?.name ?? "your service"}.`
              : `These also fit at ${timeFmt.format(new Date(slot))}.`}
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {/* Two at most: this is a nudge, not a second menu. They arrive
                cheapest-first, so the gentlest step up leads. */}
            {upgrades.slice(0, 2).map((u) => (
              <button
                key={u.serviceId}
                type="button"
                onClick={() => applyUpgrade(u)}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-white/5"
                style={{ borderColor: "rgba(255,255,255,0.15)" }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{u.name}</span>
                  <span className="block text-xs text-muted">
                    {u.durationMin} min · {u.extraMin} min longer
                  </span>
                </span>
                <span
                  className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
                  style={{ backgroundColor: accent, color: onAccent }}
                >
                  +${u.priceDelta.toFixed(0)}
                </span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Keeps your {timeFmt.format(new Date(slot))} time
            {pickedStaffName ? ` with ${pickedStaffName}` : ""}.
          </p>
        </div>
      )}

      {/* Details step: contact + consent. Numbered after the time step. */}
      {slot && (
        <Section
          title={`${detailsStepNo} · Your details`}
          back={<BackStep onClick={backToTime} />}
          focusOnMount={!demoTour}
          // The step that mounts furthest down the page: without this, tapping
          // a time looked like nothing happened at all. Not left to the focus
          // move alone - that scrolls only to "nearest", which parks the
          // heading on the bottom edge with the form still off-screen.
          revealOnMount={!demoTour}
        >
          {/* Optional add-ons for the chosen service (a targeted slot's
              length/price are fixed, so add-ons don't apply there). */}
          {!slotTargeted && addOnsForService.length > 0 && (
            <div className="mb-3 rounded-xl border border-white/10 p-3" data-tour="addons">
              <p className="mb-2 flex items-baseline justify-between gap-2 text-xs font-medium uppercase tracking-wide opacity-60">
                <span>Add-ons</span>
                {/* The budget, stated once. Without it a greyed-out row reads as
                    broken rather than as "that one is too long for this slot". */}
                {roomLeftMin !== null && (
                  <span className="normal-case tracking-normal">
                    {roomLeftMin} min left
                  </span>
                )}
              </p>
              <div className="flex flex-col gap-1.5">
                {addOnsForService.map((a) => {
                  const on = addOnIds.includes(a.id);
                  // Add-ons STACK, so this is about the room REMAINING, not the
                  // slot's total. Shown disabled rather than hidden: a customer
                  // who can't find the beard trim they had last time assumes the
                  // page is broken, where "won't fit at 4:00" tells them to try
                  // another time.
                  const fits = addOnFits(a);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleAddOn(a.id)}
                      aria-pressed={on}
                      disabled={!fits}
                      title={fits ? undefined : "Not enough time left at this slot"}
                      className="flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40"
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

          {(slot !== null || grandTotal !== null) && (
            <div
              className="mb-3 flex flex-col gap-1 rounded-xl px-4 py-3 text-sm"
              style={{ backgroundColor: `${accent}14`, color: accent }}
            >
              {/* The one recap of WHEN before committing — time chips show
                  time-of-day only and the highlighted calendar cell is
                  scrolled far above on a phone, so without this line the
                  customer confirms a booking whose date they never see
                  spelled out. */}
              {slot !== null && (
                <div className="flex items-center justify-between font-semibold">
                  <span>{dateFmt.format(new Date(slot))}</span>
                  <span>{timeFmt.format(new Date(slot))}</span>
                </div>
              )}
              {grandTotal !== null && (
                <div className="flex items-center justify-between">
                  <span>
                    {selectedService?.name}
                    {addOnIds.length > 0 && ` + ${addOnIds.length} add-on${addOnIds.length > 1 ? "s" : ""}`}
                  </span>
                  <span className="font-semibold">${grandTotal.toFixed(0)}</span>
                </div>
              )}
              {/*
                Whether that number already has a tip in it. Sits under the
                total rather than beside every service line: it is one fact
                about the shop, and repeating it on each row turns an answer
                into noise. Renders nothing when the barber has not said.
              */}
              {tipNote !== null && grandTotal !== null && (
                <p className="text-xs text-muted">{tipNote}</p>
              )}
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
                placeholder="Last name"
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
              required={data.shop.emailRequired}
              placeholder={data.shop.emailRequired ? "Email" : "Email (optional)"}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Email"
            />
            {/* A standing appointment. Two decisions, kept to two controls:
                how often, and for how many visits. Hidden entirely when the
                shop takes payment at booking or runs approval (the API decides
                that, and would refuse the write), and while a special or an
                add-on is selected (neither can repeat). */}
            {repeatOffered && (
              <div className="flex flex-col gap-2 rounded-xl border border-white/10 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="repeat-every" className="text-xs text-muted">
                    Make it a standing appointment?
                  </label>
                  <select
                    id="repeat-every"
                    className="rounded-lg bg-white/10 px-2 py-1.5 text-base text-offwhite"
                    value={repeat?.interval ?? 0}
                    onChange={(e) => {
                      const interval = Number(e.target.value);
                      setRepeat(interval === 0 ? null : { interval, count: repeat?.count ?? 6 });
                    }}
                  >
                    <option value={0}>Just this once</option>
                    <option value={1}>Every week</option>
                    <option value={2}>Every 2 weeks</option>
                    <option value={3}>Every 3 weeks</option>
                    <option value={4}>Every 4 weeks</option>
                  </select>
                </div>
                {repeat && (
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="repeat-count" className="text-xs text-muted">
                      For how many visits?
                    </label>
                    <select
                      id="repeat-count"
                      className="rounded-lg bg-white/10 px-2 py-1.5 text-base text-offwhite"
                      value={repeat.count}
                      onChange={(e) =>
                        setRepeat({ interval: repeat.interval, count: Number(e.target.value) })
                      }
                    >
                      {Array.from({ length: repeatMax - 1 }, (_, i) => i + 2).map((n) => (
                        <option key={n} value={n}>
                          {n} visits
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {repeat && slot !== null && (
                  <p className="text-xs text-muted">
                    Same time, {timeFmt.format(new Date(slot))}, every{" "}
                    {repeat.interval === 1 ? "week" : `${repeat.interval} weeks`} — each visit gets
                    its own reminder and can be moved or cancelled on its own. If a date is
                    already taken we&apos;ll book the rest and tell you which one.
                  </p>
                )}
              </div>
            )}
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
              {pending
                ? "Booking…"
                : repeatOffered && repeat
                  ? `Confirm ${repeat.count} visits`
                  : "Confirm booking"}
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
  revealOnMount,
  innerRef,
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
  /**
   * Scroll this step into view when it mounts.
   *
   * Related to focusOnMount but not the same thing, and neither replaces the
   * other: `.focus()` happens to scroll, but only far enough to make the
   * element visible ("nearest"), which on a step that mounts just below the
   * fold leaves its heading pinned to the very bottom edge with the content
   * still off-screen. This puts the top of the step at the top of the viewport,
   * and honours reduced-motion the way the demo tour does.
   */
  revealOnMount?: boolean;
  /** Lets a caller reveal this section later, when its CONTENT changes. */
  innerRef?: MutableRefObject<HTMLElement | null>;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
    if (revealOnMount) revealElement(sectionRef.current);
    // Mount-only: refocusing on re-render would steal focus from the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section
      ref={(el) => {
        sectionRef.current = el;
        if (innerRef) innerRef.current = el;
      }}
      className="mb-5"
      data-tour={tour}
    >
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
 * dimmed and inert. The customer pages between months with the arrows, which
 * are floored/ceilinged at the first/last month that has any availability so
 * they can't wander into all-empty months.
 *
 * All dates are shop-local "YYYY-MM-DD" strings and the grid is built in UTC
 * (see monthGrid) so the highlighted day never drifts by the viewer's timezone.
 * Month paging compares the "YYYY-MM" strings directly. `labelForDay` gives each
 * cell a human-readable accessible name (the visible cell shows only the number).
 */
function MonthCalendar({
  viewMonth,
  availableDays,
  bookedOutDays,
  selectedDay,
  accent,
  onAccent,
  labelForDay,
  onPrevMonth,
  onNextMonth,
  onPickDay,
}: {
  viewMonth: string; // "YYYY-MM"
  availableDays: Set<string>; // "YYYY-MM-DD" keys with open times
  // Working days the engine found NO openings on (fully booked / times passed).
  // Rendered dimmed but still TAPPABLE, so the customer lands on an honest
  // "no available times this day" state (with the waitlist) instead of a dead
  // cell that looks like the shop is closed. Days in neither set stay inert.
  bookedOutDays?: Set<string>;
  selectedDay: string | null;
  accent: string;
  onAccent: string;
  labelForDay: (day: string) => string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onPickDay: (day: string) => void;
}) {
  const cells = monthGrid(viewMonth);
  // Bound paging to the span of months that actually hold availability: never
  // let the customer page before the first available month or past the last.
  const sortedDays = [...availableDays].sort();
  const firstAvailableMonth = sortedDays[0]?.slice(0, 7) ?? viewMonth;
  const lastAvailableMonth = sortedDays[sortedDays.length - 1]?.slice(0, 7) ?? viewMonth;
  const atFloor = viewMonth <= firstAvailableMonth;
  const atCeiling = viewMonth >= lastAvailableMonth;

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
          disabled={atCeiling}
          aria-label="Next month"
          className="rounded-lg px-2 py-1 text-sm text-muted transition-colors hover:text-offwhite disabled:opacity-30"
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
          const bookedOut = !open && (bookedOutDays?.has(day) ?? false);
          const tappable = open || bookedOut;
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
              disabled={!tappable}
              onClick={() => onPickDay(day)}
              // aria-pressed only on selectable days; a disabled cell
              // announcing a toggle state is meaningless noise to assistive tech.
              aria-pressed={tappable ? selected : undefined}
              aria-label={`${labelForDay(day)}${
                open ? "" : bookedOut ? " (fully booked)" : " (no openings)"
              }`}
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
                    : bookedOut
                      ? "rgba(255,255,255,0.04)"
                      : "transparent",
                color: selected
                  ? onAccent
                  : open
                    ? undefined
                    : bookedOut
                      ? "rgba(255,255,255,0.45)"
                      : "rgba(255,255,255,0.25)",
                // A booked-out day reads as "was offerable, none left" — the
                // strike distinguishes it from a closed day at a glance.
                textDecoration: bookedOut && !selected ? "line-through" : undefined,
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

/**
 * The chair is held on a real deadline. Count it DOWN.
 *
 * 🔴 A minute count is only true at the instant it renders. The old copy said
 * "we'll hold this time for 10 minutes" and then never moved, so a customer who
 * switched apps to fetch their card came back to a sentence that had been
 * lying to them for however long they were gone — and the first thing they
 * learned about the deadline was that their appointment had vanished.
 *
 * At zero this says so plainly rather than sitting at 0:00: the payment can
 * still succeed and will simply be refunded, and a customer who knows that
 * calls the shop instead of assuming they are booked.
 */
function HoldCountdown({ expiresAt }: { expiresAt: string }) {
  const target = new Date(expiresAt).getTime();
  const [msLeft, setMsLeft] = useState(() => Math.max(0, target - Date.now()));
  useEffect(() => {
    const id = window.setInterval(
      () => setMsLeft(Math.max(0, target - Date.now())),
      1000,
    );
    return () => window.clearInterval(id);
  }, [target]);

  if (!Number.isFinite(target)) return null;
  if (msLeft <= 0) {
    return (
      <p role="alert" className="mb-4 text-xs text-amber-300">
        This hold has expired and the time is back on sale. You can still try to
        pay — if the time has gone, you will not be charged.
      </p>
    );
  }
  const totalSeconds = Math.ceil(msLeft / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return (
    <p className="mb-4 text-xs text-muted">
      {/* aria-live on the WRAPPER, not the number: a per-second announcement
          would make a screen reader unusable. "off" here, and the deadline is
          stated in the sentence itself. */}
      We&rsquo;ll hold this time for{" "}
      <span className="font-medium tabular-nums text-offwhite" aria-live="off">
        {mins}:{secs.toString().padStart(2, "0")}
      </span>
      . Your appointment isn&rsquo;t confirmed until this payment goes through.
    </p>
  );
}
