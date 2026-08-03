"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { SERVICE_COLORS, SERVICE_COLOR_KEYS } from "@chairback/config/constants";
import { zonedWallTimeToUtc } from "@chairback/config/time";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { NumberField } from "@/components/ui/NumberField";
import { useToast } from "@/components/ui/Toast";
import { useDemoTour } from "@/components/tour/state";
import { cn } from "@/lib/cn";
import { useLeaveGuard } from "@/lib/useLeaveGuard";
import type {
  AddOnRow,
  AgendaResponse,
  BookingShop,
  ConnectStatus,
  ServiceGroupRow,
  ServiceRow,
  StaffRow,
  WaitlistRow,
} from "./page";
import { BookingCalendar } from "./BookingCalendar";
import { ConnectPlatforms } from "./ConnectPlatforms";
import { Sheet } from "./AppointmentForm";
import { TimeSelect } from "@/components/ui/TimeSelect";
import { ImageField } from "../site/ImageField";
import {
  bulkDeleteTargetedSlotsAction,
  createAddOnAction,
  createServiceAction,
  createServiceGroupAction,
  createStaffAction,
  createTargetedSlotAction,
  deleteAddOnAction,
  deleteServiceAction,
  deleteServiceGroupAction,
  deleteStaffAction,
  deleteTargetedSlotAction,
  deleteTargetedSlotRuleAction,
  getAvailabilityAction,
  listTargetedSlotsAction,
  saveAvailabilityAction,
  saveBookingSettingsAction,
  updateAddOnAction,
  updateServiceAction,
  updateServiceGroupAction,
  type ServiceGroupInput,
  type TargetedSlotRow,
  type TargetedSlotRuleRow,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";
const tabs = ["Settings", "Staff", "Services", "Appointments"] as const;
type Tab = (typeof tabs)[number];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Curated color picker for a service's calendar color. A row of swatches from
 * SERVICE_COLORS + a "None" option; the selected one gets a ring. Stores the
 * palette KEY (or null). Used in the service editor.
 */
function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(null)}
        title="No color"
        aria-label="No color"
        aria-pressed={value === null}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-full border border-subtle text-[10px] text-muted transition-transform",
          value === null ? "ring-2 ring-gold ring-offset-2 ring-offset-charcoal-800" : "hover:scale-110",
        )}
      >
        ✕
      </button>
      {SERVICE_COLOR_KEYS.map((key) => {
        const c = SERVICE_COLORS[key];
        const selected = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            title={c.label}
            aria-label={c.label}
            aria-pressed={selected}
            style={{ backgroundColor: c.hex }}
            className={cn(
              "h-7 w-7 rounded-full transition-transform",
              selected ? "ring-2 ring-gold ring-offset-2 ring-offset-charcoal-800" : "hover:scale-110",
            )}
          />
        );
      })}
    </div>
  );
}

// State the open deferred-save editor reports to the collapse / switch-group /
// tab-switch guards: prompt on dirty, and IGNORE the tap while a save is in
// flight (unmounting mid-flight would both cry wolf — dirty stays true until
// the action resolves — and, on a failed save, discard the draft the failure
// toast promises is still there).
type EditorGuardState = { dirty: boolean; saving: boolean };

// The leave guard (beforeunload + Link-click + server-action-submit
// interception) lives in @/lib/useLeaveGuard now, shared with PageEditor and
// any other deferred-save editor.

export function BookingManager({
  shop,
  appBase,
  apiBase,
  connect,
  initialStaff,
  initialServices,
  initialServiceGroups,
  initialAddOns,
  initialAgenda,
  initialWaitlist,
}: {
  shop: BookingShop;
  appBase: string;
  apiBase: string;
  connect: ConnectStatus;
  initialStaff: StaffRow[];
  initialServices: ServiceRow[];
  initialServiceGroups: ServiceGroupRow[];
  initialAddOns: AddOnRow[];
  initialAgenda: AgendaResponse;
  initialWaitlist: WaitlistRow[];
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("Settings");
  const bookUrl = `${appBase}/book/${shop.slug ?? "your-shop"}`;
  const needsSetup = initialStaff.length === 0 || initialServices.length === 0;

  // Dirty-check registered by the OPEN service-group editor (null = none open).
  // Group edits persist only on Save, and switching tabs unmounts the Services
  // tab — without this guard a mid-configuration tab tap silently discarded
  // every unsaved hours window (the "I spent so much time doing it all over"
  // trap, same class #128 fixed for the old Hours tab).
  const groupUnsavedRef = useRef<(() => EditorGuardState) | null>(null);

  function switchTab(next: Tab) {
    if (next === tab) return;
    const st = groupUnsavedRef.current?.();
    // Mid-save: ignore the tap. Unmounting now would prompt about edits that
    // are already on the wire (dirty clears only when the action resolves) —
    // and if that save then failed, the draft the toast promises is kept
    // would already be gone. The save settles within a beat; tap again.
    if (st?.saving) return;
    if (
      st?.dirty &&
      !window.confirm("You have unsaved group edits. Leave and lose them?")
    ) {
      return;
    }
    setTab(next);
  }

  // Dashboard demo tour: its steps on this page live behind tabs, so follow
  // the tour by switching to the tab that hosts the active step's anchor —
  // through switchTab, so an active tour can't silently discard a dirty
  // editor's draft (the one caller that used to bypass the guard).
  const { stepId: dashTourStepId } = useDemoTour("dashboard");
  useEffect(() => {
    if (dashTourStepId === "dash-agenda") switchTab("Appointments");
    else if (dashTourStepId === "dash-services") switchTab("Services");
    // switchTab is redefined per render but reads current state; the effect
    // only needs to run when the tour step changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashTourStepId]);

  return (
    <div className="flex flex-col gap-5">
      {shop.bookingMode === "native" && needsSetup && (
        <Card className="border-gold/30 bg-gold/5 px-5 py-4">
          <p className="text-sm text-gold">
            Booking is on, but you need at least one staff member and one service
            before customers can book. Add them in the tabs below.
          </p>
        </Card>
      )}

      {/* Any external mode with no link = a public page with no way to book
          (Acuity/Square sync appointments but store no booking-site URL — the
          Book button opens Shop.bookingUrl). Nudge the barber to paste their
          link OR switch to ChairBack's own booking. */}
      {shop.bookingMode !== "native" && !shop.bookingUrl && (
        <Card className="border-gold/30 bg-gold/5 px-5 py-4">
          <p className="text-sm text-gold">
            {shop.bookingMode === "square" ? (
              <>
                Square is syncing your appointments, but your public page has no
                Book button yet. Paste your Square booking-site link in{" "}
                <strong>Your booking link</strong> below so clients can book
                straight from your page.
              </>
            ) : shop.bookingMode === "acuity" ? (
              <>
                Acuity is syncing your appointments, but your public page has no
                Book button yet. Paste your Acuity scheduling link in{" "}
                <strong>Your booking link</strong> below so clients can book
                straight from your page.
              </>
            ) : (
              <>
                You haven&apos;t added a booking link yet. Paste your
                Acuity/Booksy/Square link in <strong>Your booking link</strong>{" "}
                below, or switch to <strong>Run booking on ChairBack</strong> to
                take appointments right here — otherwise customers can only
                request a time.
              </>
            )}
          </p>
        </Card>
      )}

      <div className="flex items-center gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={cn(
              "rounded-full px-4 py-1.5 text-sm font-medium transition-colors duration-150 ease-out",
              tab === t
                ? "bg-gold/15 text-gold"
                : "text-muted hover:bg-charcoal-700 hover:text-offwhite",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Settings" && (
        <SettingsTab
          shop={shop}
          bookUrl={bookUrl}
          connect={connect}
          apiBase={apiBase}
          toast={toast}
        />
      )}
      {tab === "Staff" && <StaffTab initial={initialStaff} toast={toast} />}
      {tab === "Services" && (
        /* data-tour: keep in sync with packages/config/src/demoTour.ts */
        <div data-tour="booking-setup">
          <ServicesTab
            initial={initialServices}
            staff={initialStaff}
            initialServiceGroups={initialServiceGroups}
            initialAddOns={initialAddOns}
            timezone={initialAgenda.timezone}
            toast={toast}
            groupUnsavedRef={groupUnsavedRef}
          />
        </div>
      )}
      {tab === "Appointments" && (
        <div data-tour="agenda">
          <BookingCalendar
            initial={initialAgenda}
            initialWaitlist={initialWaitlist}
            isNative={shop.bookingMode === "native"}
            staff={initialStaff}
            services={initialServices}
            toast={toast}
          />
        </div>
      )}
    </div>
  );
}

type Toast = (msg: string, kind?: "success" | "error") => void;

//  Settings

function SettingsTab({
  shop,
  bookUrl,
  connect,
  apiBase,
  toast,
}: {
  shop: BookingShop;
  bookUrl: string;
  connect: ConnectStatus;
  apiBase: string;
  toast: Toast;
}) {
  const [mode, setMode] = useState(shop.bookingMode);
  const [bookingUrl, setBookingUrl] = useState(shop.bookingUrl ?? "");
  const [lead, setLead] = useState(shop.bookingLeadHours);
  const [maxDays, setMaxDays] = useState(shop.bookingMaxDays);
  const [buffer, setBuffer] = useState(shop.bookingBufferMin);
  const [slotOpened, setSlotOpened] = useState(shop.slotOpenedTextsEnabled);
  const [requireApproval, setRequireApproval] = useState(shop.requireBookingApproval);
  const [groupsFirst, setGroupsFirst] = useState(shop.bookingGroupsFirst);
  const [remind24h, setRemind24h] = useState(shop.pushReminder24hEnabled);
  const [remind2h, setRemind2h] = useState(shop.pushReminder2hEnabled);
  const [pending, start] = useTransition();

  function persist(
    next: Partial<{
      mode: typeof mode;
      bookingUrl: string;
      slotOpened: boolean;
      requireApproval: boolean;
      groupsFirst: boolean;
      remind24h: boolean;
      remind2h: boolean;
    }> = {},
  ) {
    start(async () => {
      const r = await saveBookingSettingsAction({
        bookingMode: next.mode ?? mode,
        // Only the "Your booking link" card sends the URL; toggles omit it so a
        // half-typed link can never fail an unrelated save (schema is partial).
        ...(next.bookingUrl !== undefined ? { bookingUrl: next.bookingUrl } : {}),
        bookingLeadHours: lead,
        bookingMaxDays: maxDays,
        bookingBufferMin: buffer,
        slotOpenedTextsEnabled: next.slotOpened ?? slotOpened,
        requireBookingApproval: next.requireApproval ?? requireApproval,
        bookingGroupsFirst: next.groupsFirst ?? groupsFirst,
        pushReminder24hEnabled: next.remind24h ?? remind24h,
        pushReminder2hEnabled: next.remind2h ?? remind2h,
      });
      toast(r.ok ? "Booking settings saved" : "Couldn't save", r.ok ? "success" : "error");
    });
  }

  // "" clears the link (the API stores null); anything else must be http(s).
  const bookingUrlTrimmed = bookingUrl.trim();
  const bookingUrlValid =
    bookingUrlTrimmed === "" || /^https?:\/\/\S+$/i.test(bookingUrlTrimmed);

  function saveBookingUrl() {
    persist({ bookingUrl: bookingUrlTrimmed });
  }

  // Flip the "notify waitlist when a slot opens" toggle and save immediately.
  function toggleSlotOpened() {
    const next = !slotOpened;
    setSlotOpened(next);
    persist({ slotOpened: next });
  }

  // Flip "require my approval before a booking is confirmed" and save.
  function toggleRequireApproval() {
    const next = !requireApproval;
    setRequireApproval(next);
    persist({ requireApproval: next });
  }

  // Flip "open the public menu with group cards" and save.
  function toggleGroupsFirst() {
    const next = !groupsFirst;
    setGroupsFirst(next);
    persist({ groupsFirst: next });
  }

  // Flip one of the automatic push-reminder tiers (24h / 2h) and save.
  function toggleRemind24h() {
    const next = !remind24h;
    setRemind24h(next);
    persist({ remind24h: next });
  }
  function toggleRemind2h() {
    const next = !remind2h;
    setRemind2h(next);
    persist({ remind2h: next });
  }

  function save() {
    persist();
  }

  // Picking a platform card both selects AND saves the mode (so the choice
  // sticks without a separate Save click); native config below has its own Save.
  function pickMode(next: typeof mode) {
    setMode(next);
    persist({ mode: next });
  }

  return (
    <div className="flex flex-col gap-5">
      <ConnectPlatforms mode={mode} onPick={pickMode} connect={connect} apiBase={apiBase} />

      {mode !== "native" && (
        <Card className="p-5">
          <CardHeader
            title="Your booking link"
            subtitle={
              mode === "square"
                ? "The Book button on your public page opens this link. Find yours in Square Dashboard → Online Booking → Booking site."
                : mode === "acuity"
                  ? "The Book button on your public page opens this link — your Acuity client scheduling page."
                  : "The Book button on your public page opens this link (Acuity, Booksy, Square, or any booking site)."
            }
          />
          <div className="mt-4 flex flex-col gap-2">
            <input
              value={bookingUrl}
              onChange={(e) => setBookingUrl(e.target.value)}
              placeholder="https://squareup.com/appointments/book/…"
              maxLength={500}
              aria-label="Booking link"
              aria-invalid={!bookingUrlValid || undefined}
              aria-describedby={bookingUrlValid ? undefined : "err-booking-url"}
              className={field}
            />
            {!bookingUrlValid && (
              <FormError id="err-booking-url">
                Must be a full link starting with https://
              </FormError>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={saveBookingUrl}
                disabled={pending || !bookingUrlValid}
                className="rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save link"}
              </button>
              <p className="text-xs text-muted">
                Leave blank to remove the Book button
                {mode === "link" ? "" : " (appointments keep syncing either way)"}.
              </p>
            </div>
          </div>
        </Card>
      )}

      {mode === "native" && (
        <Card className="p-5">
          <CardHeader title="Booking rules" subtitle="How far out and how tight customers can book." />
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className={labelCls}>Min notice (hours)</span>
              <NumberField
                min={0}
                integer
                className={field}
                value={lead}
                onChange={setLead}
              />
            </label>
            <label className="block">
              <span className={labelCls}>Book up to (days ahead)</span>
              <NumberField
                min={1}
                integer
                className={field}
                value={maxDays}
                onChange={setMaxDays}
              />
            </label>
            <label className="block">
              <span className={labelCls}>Buffer between (min)</span>
              <NumberField
                min={0}
                integer
                className={field}
                value={buffer}
                onChange={setBuffer}
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-muted">
            Your booking page:{" "}
            <a
              href={`${bookUrl}?from=dashboard`}
              target="_blank"
              rel="noreferrer"
              className="text-gold underline"
            >
              {bookUrl}
            </a>
          </p>
          <button
            onClick={save}
            disabled={pending}
            className="mt-5 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save booking rules"}
          </button>
        </Card>
      )}

      {mode === "native" && (
        <Card className="p-5">
          <CardHeader
            title="Notify the waitlist when a slot opens"
            subtitle="When a booking cancels, matching waitlisters get a push + email that the time is free. You always get an alert either way."
          />
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-sm text-muted">
              {slotOpened
                ? "On — waitlisters are auto-notified of freed slots."
                : "Off — only you are alerted when a slot opens."}
            </p>
            <button
              onClick={toggleSlotOpened}
              disabled={pending}
              className={cn(
                "shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50",
                slotOpened
                  ? "bg-emerald-soft/15 text-emerald-soft"
                  : "border border-subtle text-muted hover:bg-charcoal-700",
              )}
            >
              {slotOpened ? "On" : "Off"}
            </button>
          </div>
        </Card>
      )}

      {mode === "native" && (
        <Card className="p-5">
          <CardHeader
            title="Automatic appointment reminders"
            subtitle="Free push notifications to the client's phone. No texts are sent."
          />
          <div className="mt-4 flex flex-col gap-3">
            {(
              [
                {
                  label: "24 hours before",
                  on: remind24h,
                  toggle: toggleRemind24h,
                },
                { label: "2 hours before", on: remind2h, toggle: toggleRemind2h },
              ] as const
            ).map((tier) => (
              <div
                key={tier.label}
                className="flex items-center justify-between gap-4"
              >
                <p className="text-sm text-muted">{tier.label}</p>
                <button
                  onClick={tier.toggle}
                  disabled={pending}
                  className={cn(
                    "shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50",
                    tier.on
                      ? "bg-emerald-soft/15 text-emerald-soft"
                      : "border border-subtle text-muted hover:bg-charcoal-700",
                  )}
                >
                  {tier.on ? "On" : "Off"}
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {mode === "native" && (
        <Card className="p-5">
          <CardHeader
            title="Require my approval before a booking is confirmed"
            subtitle="When on, a customer's online booking comes in as a request. You approve or decline it from your calendar, and they're only confirmed once you approve."
          />
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-sm text-muted">
              {requireApproval
                ? "On — new bookings wait for your approval."
                : "Off — customers book confirmed times instantly."}
            </p>
            <button
              onClick={toggleRequireApproval}
              disabled={pending}
              className={cn(
                "shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50",
                requireApproval
                  ? "bg-emerald-soft/15 text-emerald-soft"
                  : "border border-subtle text-muted hover:bg-charcoal-700",
              )}
            >
              {requireApproval ? "On" : "Off"}
            </button>
          </div>
        </Card>
      )}

      {mode === "native" && (
        <Card className="p-5">
          <CardHeader
            title="Day-first booking page (bundles by date)"
            subtitle="When on, customers pick a DATE first, then see only the bundles (your service groups) with openings that day and the exact times inside each — instead of every service at once. Bundles with nothing open that day don't appear."
          />
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-sm text-muted">
              {groupsFirst
                ? "On — customers pick a day, then a time from that day's bundles."
                : "Off — the menu lists every service (service first)."}
            </p>
            <button
              onClick={toggleGroupsFirst}
              disabled={pending}
              className={cn(
                "shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50",
                groupsFirst
                  ? "bg-emerald-soft/15 text-emerald-soft"
                  : "border border-subtle text-muted hover:bg-charcoal-700",
              )}
            >
              {groupsFirst ? "On" : "Off"}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

//  Staff

function StaffTab({ initial, toast }: { initial: StaffRow[]; toast: Toast }) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  // The staff member whose weekly-hours Sheet is open (null = closed).
  const [hoursFor, setHoursFor] = useState<StaffRow | null>(null);

  function add() {
    if (!name.trim()) return;
    start(async () => {
      const r = await createStaffAction({ name: name.trim() });
      if (r.ok) {
        toast("Staff member added", "success");
        setName("");
      } else toast("Couldn't add", "error");
    });
  }
  function remove(id: string) {
    start(async () => {
      const r = await deleteStaffAction(id);
      toast(r.ok ? "Staff member removed" : "Couldn't remove", r.ok ? "success" : "error");
    });
  }

  return (
    <Card className="p-5">
      <CardHeader title="Staff" subtitle="Everyone who takes appointments." />
      <div className="mt-3 flex gap-2">
        <input
          className={field}
          placeholder="Staff member name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button
          onClick={add}
          disabled={pending}
          className="shrink-0 rounded-xl bg-gold px-4 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      <ul className="mt-4 flex flex-col gap-2">
        {initial.filter((s) => s.active).map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between rounded-xl border border-subtle px-4 py-2.5"
          >
            <span className="text-sm">{s.name}</span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setHoursFor(s)}
                className="rounded-full border border-subtle px-3 py-1 text-xs text-muted hover:text-offwhite"
              >
                Hours
              </button>
              <button
                onClick={() => remove(s.id)}
                className="text-xs text-danger-soft hover:underline"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
        {initial.filter((s) => s.active).length === 0 && (
          <li className="text-sm text-muted">No staff yet.</li>
        )}
      </ul>
      {hoursFor && (
        <StaffHoursSheet
          key={hoursFor.id}
          staffId={hoursFor.id}
          staffName={hoursFor.name}
          toast={toast}
          onClose={() => setHoursFor(null)}
        />
      )}
    </Card>
  );
}

//  Services

function ServicesTab({
  initial,
  staff,
  initialServiceGroups,
  initialAddOns,
  timezone,
  toast,
  groupUnsavedRef,
}: {
  initial: ServiceRow[];
  staff: StaffRow[];
  initialServiceGroups: ServiceGroupRow[];
  initialAddOns: AddOnRow[];
  timezone: string; // IANA shop tz (targeted-slot times are shop wall clock)
  toast: Toast;
  // Registered by the open group editor; BookingManager's tab guard reads it.
  groupUnsavedRef: MutableRefObject<(() => EditorGuardState) | null>;
}) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(30);
  const [price, setPrice] = useState("");
  // Per-weekday overrides the barber sets explicitly (weekday -> string).
  // Empty = that day uses the base price/length. Built into the API payload.
  const [dayPrices, setDayPrices] = useState<Record<number, string>>({});
  const [dayDurations, setDayDurations] = useState<Record<number, string>>({});
  // Time-of-day windows ("after 9 PM: $60 / 20 min"); none by default.
  const [timeRows, setTimeRows] = useState<TimeWindowRow[]>([]);
  // Empty = "offered by everyone" (resolved at submit). Starting empty avoids a
  // stale snapshot of the staff list - a barber added later is included by default.
  const [staffIds, setStaffIds] = useState<string[]>([]);
  // Which service the pencil opened for editing (null = the edit Sheet is closed).
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [pending, start] = useTransition();
  const activeStaff = staff.filter((s) => s.active);

  function add() {
    if (!name.trim()) return;
    // Time windows get the same specific validation as the edit Sheet.
    const timeErr = timeRowsError(timeRows);
    if (timeErr) {
      toast(timeErr, "error");
      return;
    }
    // No explicit selection -> offer via every barber as a LIVE intent
    // (offeredByAll), so a barber added later is auto-included. An explicit
    // selection pins the hand-picked set.
    const all = staffIds.length === 0;
    const overrides = buildPriceOverrides(dayPrices);
    const durOverrides = buildDurationOverrides(dayDurations);
    start(async () => {
      const r = await createServiceAction({
        name: name.trim(),
        durationMin: duration,
        price: price.trim() ? Number(price) : null,
        priceOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        durationOverrides:
          Object.keys(durOverrides).length > 0 ? durOverrides : undefined,
        timeOverrides: timeRows.length > 0 ? buildTimeOverrides(timeRows) : undefined,
        offeredByAll: all,
        staffIds: all ? undefined : staffIds,
      });
      if (r.ok) {
        toast("Service added", "success");
        setName("");
        setPrice("");
        setDayPrices({});
        setDayDurations({});
        setTimeRows([]);
        setStaffIds([]);
      } else toast("Couldn't add", "error");
    });
  }
  function remove(id: string) {
    // One tap here used to destroy a fully-configured service — per-day prices
    // and durations, hours, time-of-day windows, staff assignments — with no
    // confirm and no undo, sitting right next to "Edit" on every row. Name
    // exactly what's being lost (group deletion already confirms; a service
    // carries far more setup).
    const svc = initial.find((s) => s.id === id);
    const grp = initialServiceGroups.find(
      (g) => g.active && g.serviceIds.includes(id),
    );
    if (
      !window.confirm(
        `Remove "${svc?.name ?? "this service"}"? Its prices, hours and staff setup are deleted` +
          (grp ? ` and it leaves the "${grp.name}" group` : "") +
          ". This can't be undone.",
      )
    ) {
      return;
    }
    start(async () => {
      const r = await deleteServiceAction(id);
      toast(r.ok ? "Service removed" : "Couldn't remove", r.ok ? "success" : "error");
    });
  }
  function toggleStaff(id: string) {
    setStaffIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
      <CardHeader title="Services" subtitle="What customers can book, with a length." />
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_120px_120px]">
        <input
          className={field}
          placeholder="Service name (e.g. Haircut)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {/* Minutes — persistent "min" suffix so the unit shows even after a
            value is typed (the placeholder alone vanished on input). */}
        <div className="relative">
          <NumberField
            className={`${field} pr-11`}
            min={5}
            integer
            placeholder="Length"
            value={duration}
            onChange={setDuration}
            aria-label="Service length in minutes"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
            min
          </span>
        </div>
        {/* Price — persistent "$" prefix, same reasoning. */}
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">
            $
          </span>
          <input
            className={`${field} pl-7`}
            type="number"
            min={0}
            placeholder="Price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label="Price in dollars"
          />
        </div>
      </div>
      {activeStaff.length > 0 && (
        <div className="mt-3">
          <span className={labelCls}>
            Offered by {staffIds.length === 0 ? "(all staff)" : ""}
          </span>
          <div className="mt-1 flex flex-wrap gap-2">
            {activeStaff.map((s) => (
              <button
                key={s.id}
                onClick={() => toggleStaff(s.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  staffIds.includes(s.id)
                    ? "border-gold/60 bg-gold/10 text-gold"
                    : "border-subtle text-muted",
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Optional per-day overrides ("Vary by day"). Leave a day blank to use
          the base price/length; fill one in to differ (e.g. Sunday premium, or
          "Friday cuts are 20 min"). Duration drives the slot grid: a 20-min
          Friday makes Friday book in 20-min blocks. */}
      <div className="mt-3">
        <VaryByDayEditor
          dayPrices={dayPrices}
          dayDurations={dayDurations}
          basePrice={price}
          baseDuration={duration}
          onPrice={(wd, v) => setDayPrices((cur) => ({ ...cur, [wd]: v }))}
          onDuration={(wd, v) => setDayDurations((cur) => ({ ...cur, [wd]: v }))}
        />
      </div>

      {/* Time-of-day windows ("after 9 PM: $60 / 20 min") — same editor as the
          edit Sheet so a special evening rate can be set at create time. */}
      <div className="mt-3">
        <VaryByTimeEditor
          rows={timeRows}
          onChange={setTimeRows}
          basePrice={price}
          baseDuration={duration}
        />
      </div>

      <button
        onClick={add}
        disabled={pending}
        className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        Add service
      </button>

      <ul className="mt-5 flex flex-col gap-2">
        {initial.filter((s) => s.active).map((s) => {
          // Hours the ENGINE will use for this service (a group overrides it).
          // Restricted => ★ + the windows spelled out, so the barber can spot
          // his evening/weekend-only services without opening a single editor.
          const { windows, groupName } = effectiveServiceHours(s, initialServiceGroups);
          const offHours = hasCustomHours(windows);
          return (
            <li
              key={s.id}
              className={cn(
                "flex items-start justify-between gap-3 rounded-xl border px-4 py-2.5",
                offHours ? "border-gold/40 bg-gold/[0.04]" : "border-subtle",
              )}
            >
              <span className="min-w-0 text-sm">
                {offHours && <OffHoursStar />}
                {s.name}{" "}
                <span className="text-xs text-muted">
                  · {s.durationMin} min{s.price !== null ? ` · $${s.price}` : ""}
                  {Object.keys(s.priceOverrides ?? {}).length > 0 &&
                    " · " +
                      Object.entries(s.priceOverrides)
                        .map(([wd, p]) => `${WEEKDAYS[Number(wd)]} $${p}`)
                        .join(", ")}
                  {Object.keys(s.durationOverrides ?? {}).length > 0 &&
                    " · " +
                      Object.entries(s.durationOverrides ?? {})
                        .map(([wd, m]) => `${WEEKDAYS[Number(wd)]} ${m}min`)
                        .join(", ")}
                  {(s.timeOverrides ?? []).length > 0 &&
                    " · " + (s.timeOverrides ?? []).map(timeWindowSummary).join(", ")}
                </span>
                {offHours && (
                  <span className="mt-0.5 block text-xs text-gold/90">
                    {groupName ? `${groupName} hours · ` : ""}
                    {hoursWindowsSummary(windows)}
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  onClick={() => setEditing(s)}
                  className="text-xs text-gold hover:underline"
                  aria-label={`Edit ${s.name}`}
                >
                  Edit
                </button>
                <button
                  onClick={() => remove(s.id)}
                  className="text-xs text-danger-soft hover:underline"
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
        {initial.filter((s) => s.active).length === 0 && (
          <li className="text-sm text-muted">No services yet.</li>
        )}
      </ul>
      </Card>

      {editing && (
        <ServiceEditForm
          key={editing.id}
          service={editing}
          staff={staff}
          groupName={
            editing.serviceGroupId
              ? (initialServiceGroups.find((g) => g.id === editing.serviceGroupId)
                  ?.name ?? null)
              : null
          }
          toast={toast}
          onClose={() => setEditing(null)}
        />
      )}

      <ServiceGroupsManager
        initial={initialServiceGroups}
        services={initial}
        toast={toast}
        unsavedRef={groupUnsavedRef}
      />

      <AddOnsManager initial={initialAddOns} services={initial} toast={toast} />

      <TargetedSlotsManager services={initial} staff={staff} timezone={timezone} toast={toast} />
    </div>
  );
}

//  Edit an existing service (pencil) - name, price, per-day price/duration,
//  offered-by staff, AND the per-service available-hours restriction. Wires to
//  the existing updateServiceAction (PATCH /services/:id). The list refreshes
//  via revalidatePath on save, so no local list sync is needed.

function ServiceEditForm({
  service,
  staff,
  groupName,
  toast,
  onClose,
}: {
  service: ServiceRow;
  staff: StaffRow[];
  // Non-null = this service is in a group; the group owns hours + limits, so the
  // per-service hours editor is replaced with a note (the group overrides it).
  groupName: string | null;
  toast: Toast;
  onClose: () => void;
}) {
  const activeStaff = staff.filter((s) => s.active);
  const [name, setName] = useState(service.name);
  // Public-card content: a multi-line description (supports an "INCLUDES:" list)
  // and a menu photo. Both optional; empty = the card renders without them.
  const [description, setDescription] = useState(service.description ?? "");
  const [imageUrl, setImageUrl] = useState(service.imageUrl ?? "");
  const [duration, setDuration] = useState(service.durationMin);
  const [price, setPrice] = useState(service.price !== null ? String(service.price) : "");
  // Seed the per-day override inputs from the stored maps (weekday -> string).
  const [dayPrices, setDayPrices] = useState<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    for (const [wd, p] of Object.entries(service.priceOverrides ?? {})) out[Number(wd)] = String(p);
    return out;
  });
  const [dayDurations, setDayDurations] = useState<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    for (const [wd, m] of Object.entries(service.durationOverrides ?? {})) out[Number(wd)] = String(m);
    return out;
  });
  // "Offered by all" is a live intent (see the API): when on, the chips show all
  // active barbers lit and a barber added later is auto-included. Toggling any
  // single chip switches to a hand-picked set. Seed from the stored flag; the
  // chip selection is seeded from the resolved staffIds so the UI matches state.
  const [offeredByAll, setOfferedByAll] = useState<boolean>(service.offeredByAll ?? false);
  const [staffIds, setStaffIds] = useState<string[]>(
    service.offeredByAll ? activeStaff.map((s) => s.id) : (service.staffIds ?? []),
  );
  // Calendar color (a SERVICE_COLORS key, or null = no color).
  const [color, setColor] = useState<string | null>(service.color ?? null);
  // Per-service available-hours rows (one window/day in v1), seeded from storage.
  const [hoursRows, setHoursRows] = useState<ServiceHoursRow[]>(() =>
    hoursRowsFromWindows(service.hoursWindows),
  );
  // Time-of-day price/duration windows ("after 9 PM: $60 / 20 min").
  const [timeRows, setTimeRows] = useState<TimeWindowRow[]>(() =>
    timeRowsFromOverrides(service.timeOverrides),
  );
  const [pending, start] = useTransition();

  function toggleStaff(id: string) {
    // Picking specific barbers means it's no longer "all".
    setOfferedByAll(false);
    setStaffIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }
  function chooseAll() {
    setOfferedByAll(true);
    setStaffIds(activeStaff.map((s) => s.id));
  }
  // Flip every weekday at once (Drick: "an option to open all days instead of
  // checking one by one"). Preserves each row's windows.
  const allHoursCustom = hoursRows.every((r) => r.mode === "custom");
  function setAllHours(mode: ServiceHoursRow["mode"]) {
    setHoursRows((cur) => cur.map((r) => ({ ...r, mode })));
  }

  function save() {
    if (!name.trim()) {
      toast("Name is required", "error");
      return;
    }
    // Duration must be a whole number >= 5 (mirrors the API bound). Clearing the
    // field yields Number("")=0 and letters yield NaN - both are user errors, not
    // "0 minutes", so catch them here with a clear message instead of a generic
    // 400 "Couldn't save" (or, for price, a silent NaN->null "free" service).
    if (!Number.isInteger(duration) || duration < 5) {
      toast("Minutes must be a whole number of 5 or more", "error");
      return;
    }
    // Price is optional (blank = no set price). But a non-empty, non-numeric
    // price (e.g. pasted "abc") must NOT silently serialize to null and save the
    // service as FREE - reject it so the barber sees the problem.
    const trimmedPrice = price.trim();
    const priceNum = trimmedPrice ? Number(trimmedPrice) : null;
    if (priceNum !== null && (!Number.isFinite(priceNum) || priceNum < 0)) {
      toast("Price must be a number (or blank)", "error");
      return;
    }
    // A custom window whose end is not after its start is a user error, not a
    // "closed" instruction - block save so they don't silently lose the day.
    // Skipped when grouped: the group owns hours, so the editor is hidden and we
    // must not send its (now irrelevant) windows.
    if (!groupName && hasInvalidHoursRow(hoursRows)) {
      toast("Service hours: each window's end must be after its start", "error");
      return;
    }
    // Time windows validated with a SPECIFIC message (end>start, price/minutes
    // present + valid, no overlaps) so a mistake doesn't surface as a bare 400.
    const timeErr = timeRowsError(timeRows);
    if (timeErr) {
      toast(timeErr, "error");
      return;
    }
    // If hand-picking, at least one barber must be selected (an empty pick that
    // isn't "all" would offer the service to nobody).
    if (!offeredByAll && staffIds.length === 0) {
      toast("Pick at least one barber, or choose All", "error");
      return;
    }
    start(async () => {
      const r = await updateServiceAction(service.id, {
        name: name.trim(),
        // Send trimmed values (empty string clears the column server-side).
        description: description.trim(),
        imageUrl: imageUrl.trim(),
        durationMin: duration,
        price: priceNum,
        // Always send the FULL maps (including {}) so clearing an override or a
        // restriction actually persists - PATCH is partial, absent = unchanged.
        priceOverrides: buildPriceOverrides(dayPrices),
        durationOverrides: buildDurationOverrides(dayDurations),
        // Same rule for the time windows ([] clears them all).
        timeOverrides: buildTimeOverrides(timeRows),
        // Grouped services get their hours from the group (which overrides these),
        // so omit the field entirely - PATCH is partial, absent = leave unchanged.
        ...(groupName ? {} : { hoursWindows: buildHoursWindows(hoursRows) }),
        color,
        // offeredByAll wins server-side; send staffIds only for the hand-picked
        // case so a later-added barber is auto-included when "all" is chosen.
        offeredByAll,
        staffIds: offeredByAll ? undefined : staffIds,
      });
      if (r.ok) {
        toast("Service updated", "success");
        onClose();
      } else toast("Couldn't save", "error");
    });
  }

  return (
    <Sheet title="Edit service" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-[1fr_110px_110px]">
          <input
            className={field}
            placeholder="Service name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <NumberField
            className={field}
            min={5}
            integer
            placeholder="Minutes"
            value={duration}
            onChange={setDuration}
          />
          <input
            className={field}
            type="number"
            min={0}
            placeholder="Price ($)"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>

        {/* Public booking-card content: what the customer sees when they pick
            this service. A description (one line per bullet works — e.g. an
            "INCLUDES:" list) and a menu photo. Both optional. */}
        <div>
          <span className={labelCls}>Description (shown on the booking page)</span>
          <textarea
            className={cn(field, "mt-1 min-h-[96px] resize-y leading-relaxed")}
            placeholder={"What's included, e.g.\nThe VIP Package — most requested\nINCLUDES:\n• Haircut of choice\n• Hot towel + facial"}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={800}
          />
          <span className="mt-0.5 block text-[11px] text-muted/80">
            Line breaks are kept — put each “includes” item on its own line.
          </span>
        </div>

        <div className="max-w-[220px]">
          <ImageField
            label="Photo (shown on the booking card)"
            hint="A square photo of the cut/result. Optional."
            value={imageUrl}
            onChange={setImageUrl}
            kind="service"
            aspect="square"
          />
        </div>

        {activeStaff.length > 0 && (
          <div>
            <span className={labelCls}>
              Offered by {offeredByAll ? "(all barbers, including any added later)" : ""}
            </span>
            <div className="mt-1 flex flex-wrap gap-2">
              {/* "All" is a live intent: pick it and every barber - now or added
                  later - offers this service. Picking individuals switches off it. */}
              <button
                onClick={chooseAll}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  offeredByAll
                    ? "border-gold/60 bg-gold/10 text-gold"
                    : "border-subtle text-muted",
                )}
              >
                All barbers
              </button>
              {activeStaff.map((s) => (
                <button
                  key={s.id}
                  onClick={() => toggleStaff(s.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    !offeredByAll && staffIds.includes(s.id)
                      ? "border-gold/60 bg-gold/10 text-gold"
                      : "border-subtle text-muted",
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Calendar color: tints this service's appointment blocks so the day
            view is scannable by cut type. */}
        <div>
          <span className={labelCls}>Calendar color</span>
          <div className="mt-1.5">
            <ColorSwatchPicker value={color} onChange={setColor} />
          </div>
        </div>

        {/* Per-day price/duration overrides (same idiom as the add form). */}
        <VaryByDayEditor
          dayPrices={dayPrices}
          dayDurations={dayDurations}
          basePrice={price}
          baseDuration={duration}
          onPrice={(wd, v) => setDayPrices((cur) => ({ ...cur, [wd]: v }))}
          onDuration={(wd, v) => setDayDurations((cur) => ({ ...cur, [wd]: v }))}
        />

        {/* Time-of-day windows: "after 9 PM this runs $60 and takes 20 min".
            Inside a window the slot grid steps by the window's length and the
            customer sees (and is charged) the window's price. */}
        <VaryByTimeEditor
          rows={timeRows}
          onChange={setTimeRows}
          basePrice={price}
          baseDuration={duration}
        />

        {/* Per-service available hours. Unchecked day = available whenever the
            barber works; check a day + set a window to limit this service (e.g.
            "Mens Haircut only 10:00-14:00"). It intersects with the barber's
            weekly hours - it never widens them. When the service is in a group,
            the group owns hours + limits, so the editor is hidden. */}
        {groupName ? (
          <div>
            <span className={labelCls}>Available hours for this service</span>
            <p className="mt-1 rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-xs text-muted">
              Hours &amp; limits are managed by the group{" "}
              <span className="text-offwhite">“{groupName}”</span>. Edit them in{" "}
              <span className="text-offwhite">Service groups</span> below.
            </p>
          </div>
        ) : (
          <CollapsibleHours
            title="Available hours for this service (optional)"
            summary={hoursSummary(hoursRows)}
          >
            <div className="flex items-center justify-end">
              {/* Flip every day in one tap instead of one by one. */}
              <button
                type="button"
                onClick={() => setAllHours(allHoursCustom ? "any" : "custom")}
                className="shrink-0 rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:border-gold/50 hover:text-gold"
              >
                {allHoursCustom ? "All days: open" : "All days: custom"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Open = whenever the barber works that day. Custom = only the windows
              you set (add a second window for a split day). Not open = no
              bookings that day.
            </p>
            <AvailableHoursRows
              rows={hoursRows}
              onChange={setHoursRows}
              ariaScope="this service"
            />
          </CollapsibleHours>
        )}

        <button
          onClick={save}
          disabled={pending}
          className="mt-1 self-start rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </Sheet>
  );
}

//  Targeted slots (one-off special-priced bookable slots under a service)

function TargetedSlotsManager({
  services,
  staff,
  timezone,
  toast,
}: {
  services: ServiceRow[];
  staff: StaffRow[];
  timezone: string; // IANA shop tz - the datetime input is shop wall clock
  toast: Toast;
}) {
  const activeServices = services.filter((s) => s.active);
  const activeStaff = staff.filter((s) => s.active);
  const [slots, setSlots] = useState<TargetedSlotRow[] | null>(null);
  const [rules, setRules] = useState<TargetedSlotRuleRow[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [label, setLabel] = useState("");
  const [when, setWhen] = useState(""); // datetime-local string
  const [minutes, setMinutes] = useState(30);
  const [price, setPrice] = useState("");
  const [repeatWeeks, setRepeatWeeks] = useState(0);
  // "Until I turn it off" — an indefinite weekly series (Drick: capping at N
  // weeks means re-publishing forever). Mutually exclusive with the spinner.
  const [repeatForever, setRepeatForever] = useState(false);
  // Hand-picked slot ids for bulk remove ("select to delete").
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Which series cards are expanded to their individual dates.
  const [openRules, setOpenRules] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  function refresh() {
    start(async () => {
      const res = await listTargetedSlotsAction();
      if (res.ok && res.slots) {
        setSlots(res.slots);
        setRules(res.rules ?? []);
        setSelected(new Set());
      }
    });
  }
  // First load on mount (no server plumbing needed for a settings subsection).
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function add() {
    if (!serviceId || !staffId || !when || !price.trim()) {
      toast("Pick a service, barber, time, and price", "error");
      return;
    }
    // datetime-local is naive wall clock; interpret in the SHOP's tz (the zone
    // the public page + calendar render in) - new Date(when) would use the
    // device's zone and publish the slot (or anchor a weekly series) at the
    // wrong shop-local time whenever the barber's device isn't in the shop tz.
    const [day, time] = when.split("T");
    const [y, m, d] = (day ?? "").split("-").map(Number);
    const [hh, mm] = (time ?? "").split(":").map(Number);
    const startsAt = zonedWallTimeToUtc(y!, m! - 1, d!, hh! * 60 + mm!, timezone);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
      toast("Pick a future time", "error");
      return;
    }
    start(async () => {
      const r = await createTargetedSlotAction({
        staffId,
        serviceId,
        label: label.trim() || undefined,
        startsAt: startsAt.toISOString(),
        durationMin: minutes,
        price: Number(price),
        repeatWeeks: !repeatForever && repeatWeeks > 0 ? repeatWeeks : undefined,
        repeatForever: repeatForever || undefined,
      });
      if (r.ok) {
        toast(repeatForever ? "Series published" : "Slot published", "success");
        setLabel("");
        setWhen("");
        setPrice("");
        setRepeatWeeks(0);
        setRepeatForever(false);
        refresh();
      } else toast("Couldn't publish", "error");
    });
  }

  function remove(id: string) {
    start(async () => {
      const r = await deleteTargetedSlotAction(id);
      toast(r.ok ? "Slot removed" : "Couldn't remove (already booked?)", r.ok ? "success" : "error");
      refresh();
    });
  }

  function removeRule(rule: TargetedSlotRuleRow) {
    start(async () => {
      const r = await deleteTargetedSlotRuleAction(rule.id);
      toast(
        r.ok
          ? rule.indefinite
            ? "Series turned off"
            : "Series removed"
          : "Couldn't remove",
        r.ok ? "success" : "error",
      );
      refresh();
    });
  }

  function removeSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    start(async () => {
      const r = await bulkDeleteTargetedSlotsAction(ids);
      toast(r.ok ? "Selected slots removed" : "Couldn't remove", r.ok ? "success" : "error");
      refresh();
    });
  }

  function toggleSelected(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Shop tz, matching the input interpretation above and the calendar/public
  // page - device-local rendering would show a different hour than was set.
  const whenFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const nameOf = (list: { id: string; name: string }[], id: string) =>
    list.find((x) => x.id === id)?.name ?? "?";

  return (
    <Card className="p-5">
      <CardHeader
        title="Targeted slots"
        subtitle="Publish specific one-off times at their own price - a late-night special, a model rate. They show under the service with a badge, can be booked exactly once, and block that time from normal booking."
      />
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <select
          className={field}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">Service…</option>
          {activeServices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className={field}
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
        >
          <option value="">Barber…</option>
          {activeStaff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          className={field}
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          aria-label="Date and time"
        />
        <input
          className={field}
          placeholder="Label (optional, e.g. Late night retwist)"
          maxLength={60}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <NumberField
          className={field}
          min={5}
          integer
          inputMode="numeric"
          placeholder="Minutes"
          value={minutes}
          onChange={setMinutes}
          aria-label="Minutes"
        />
        <input
          className={field}
          type="number"
          min={0}
          inputMode="decimal"
          placeholder="Price ($)"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          aria-label="Price"
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-2">
          <label
            className={cn(
              "flex items-center gap-2 text-xs text-muted",
              repeatForever && "opacity-40",
            )}
          >
            Repeat weekly for
            <NumberField
              min={0}
              max={26}
              integer
              disabled={repeatForever}
              className="w-16 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite disabled:opacity-50"
              value={repeatWeeks}
              onChange={setRepeatWeeks}
              aria-label="Repeat weeks"
            />
            more week{repeatWeeks === 1 ? "" : "s"} (same day &amp; time)
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={repeatForever}
              onChange={(e) => setRepeatForever(e.target.checked)}
            />
            <span className={cn(repeatForever && "text-gold")}>
              Repeat until I turn it off
            </span>
          </label>
        </div>
      </div>
      <button
        onClick={add}
        disabled={pending}
        className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        Publish slot
      </button>

      {/* Bulk remove bar — appears once anything is checked. */}
      {selected.size > 0 && (
        <div className="mt-5 flex items-center gap-4 rounded-xl border border-gold/40 bg-gold/5 px-4 py-2">
          <span className="text-xs text-gold">{selected.size} selected</span>
          <button
            onClick={removeSelected}
            disabled={pending}
            className="text-xs font-semibold text-danger-soft hover:underline disabled:opacity-50"
          >
            Remove selected
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-muted hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      <ul className="mt-5 flex flex-col gap-2">
        {/* One condensed card per weekly series (Drick: dozens of identical
            rows buried the list). Expand for the individual dates. */}
        {rules.map((rule) => {
          const ruleSlots = (slots ?? []).filter((t) => t.ruleId === rule.id);
          const openCount = ruleSlots.filter((t) => !t.booked).length;
          const bookedCount = ruleSlots.length - openCount;
          const next = ruleSlots[0];
          const isOpen = openRules.has(rule.id);
          return (
            <li key={`rule-${rule.id}`} className="rounded-xl border border-subtle">
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <button
                  onClick={() =>
                    setOpenRules((cur) => {
                      const nextSet = new Set(cur);
                      if (nextSet.has(rule.id)) nextSet.delete(rule.id);
                      else nextSet.add(rule.id);
                      return nextSet;
                    })
                  }
                  aria-expanded={isOpen}
                  className="flex-1 text-left"
                >
                  <span className="text-sm">
                    {WEEKDAYS[rule.weekday]}s · {fmtWallTime(rule.startMin)}{" "}
                    <span className="text-xs text-muted">
                      · {nameOf(activeServices, rule.serviceId)} ·{" "}
                      {nameOf(activeStaff, rule.staffId)} · {rule.durationMin} min · $
                      {rule.price.toFixed(0)}
                      {rule.label ? ` · ${rule.label}` : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted">
                    {rule.indefinite
                      ? "Repeats weekly until turned off"
                      : `${ruleSlots.length} upcoming date${ruleSlots.length === 1 ? "" : "s"}`}
                    {" · "}
                    {openCount} open
                    {bookedCount > 0 ? ` · ${bookedCount} booked` : ""}
                    {next ? ` · next ${whenFmt.format(new Date(next.startsAt))}` : ""}{" "}
                    {isOpen ? "▴" : "▾"}
                  </span>
                </button>
                <button
                  onClick={() => removeRule(rule)}
                  disabled={pending}
                  className="shrink-0 text-xs text-danger-soft hover:underline disabled:opacity-50"
                >
                  {rule.indefinite ? "Turn off" : "Remove series"}
                </button>
              </div>
              {isOpen && (
                <ul className="flex flex-col gap-1 border-t border-subtle px-4 py-2">
                  {ruleSlots.map((t) => slotRow(t))}
                  {ruleSlots.length === 0 && (
                    <li className="text-xs text-muted">No upcoming dates.</li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
        {/* One-off slots (and booked leftovers of turned-off series). */}
        {(slots ?? [])
          .filter((t) => !t.ruleId || !rules.some((r) => r.id === t.ruleId))
          .map((t) => slotRow(t))}
        {slots !== null && slots.length === 0 && rules.length === 0 && (
          <li className="text-sm text-muted">No targeted slots yet.</li>
        )}
      </ul>
    </Card>
  );

  /** One slot row: checkbox (unbooked) + when + meta + badge + Remove. */
  function slotRow(t: TargetedSlotRow) {
    return (
      <li
        key={t.id}
        className="flex items-center justify-between gap-3 rounded-xl border border-subtle px-4 py-2.5"
      >
        <span className="flex items-center gap-3 text-sm">
          {!t.booked && (
            <input
              type="checkbox"
              checked={selected.has(t.id)}
              onChange={() => toggleSelected(t.id)}
              aria-label={`Select ${whenFmt.format(new Date(t.startsAt))}`}
            />
          )}
          <span>
            {whenFmt.format(new Date(t.startsAt))}{" "}
            <span className="text-xs text-muted">
              · {nameOf(activeServices, t.serviceId)} · {nameOf(activeStaff, t.staffId)} ·{" "}
              {t.durationMin} min · ${t.price.toFixed(0)}
              {t.label ? ` · ${t.label}` : ""}
            </span>{" "}
            <span
              className={cn(
                "ml-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                t.booked
                  ? "bg-emerald-soft/15 text-emerald-soft"
                  : "bg-gold/15 text-gold",
              )}
            >
              {t.booked ? "Booked" : "Open"}
            </span>
          </span>
        </span>
        {!t.booked && (
          <button
            onClick={() => remove(t.id)}
            className="text-xs text-danger-soft hover:underline"
          >
            Remove
          </button>
        )}
      </li>
    );
  }
}

/** Shop-local wall minutes → "3:00 PM". */
function fmtWallTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

//  Add-ons (optional extras that add time + price to a service)

function AddOnsManager({
  initial,
  services,
  toast,
}: {
  initial: AddOnRow[];
  services: ServiceRow[];
  toast: Toast;
}) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(15);
  const [price, setPrice] = useState("");
  // [] = offered on every service; ids scope it to just those (Drick: an add-on
  // often applies to several services, not all-or-one).
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const activeServices = services.filter((s) => s.active);
  const scopeLabel = (ids: string[]) => {
    if (ids.length === 0) return "All services";
    const names = ids.map((id) => services.find((s) => s.id === id)?.name ?? "a service");
    return names.length <= 2
      ? names.join(", ")
      : `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
  };

  function toggleService(id: string) {
    setServiceIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }

  function add() {
    if (!name.trim()) return;
    start(async () => {
      const r = await createAddOnAction({
        name: name.trim(),
        durationMin: duration,
        price: price.trim() ? Number(price) : null,
        serviceIds,
      });
      if (r.ok) {
        toast("Add-on added", "success");
        setName("");
        setPrice("");
        setServiceIds([]);
      } else toast("Couldn't add", "error");
    });
  }
  function remove(id: string) {
    start(async () => {
      const r = await deleteAddOnAction(id);
      toast(r.ok ? "Add-on removed" : "Couldn't remove", r.ok ? "success" : "error");
    });
  }

  // Inline edit (Drick: "edits for add ons" - Remove-and-retype loses the
  // scope selection and feels destructive). One row edits at a time; the draft
  // mirrors the add form's fields and saves via the (previously unused) PATCH.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDuration, setDraftDuration] = useState(15);
  const [draftPrice, setDraftPrice] = useState("");
  const [draftServiceIds, setDraftServiceIds] = useState<string[]>([]);

  function beginEdit(a: AddOnRow) {
    setEditingId(a.id);
    setDraftName(a.name);
    setDraftDuration(a.durationMin);
    setDraftPrice(a.price !== null ? String(a.price) : "");
    setDraftServiceIds(a.serviceIds);
  }
  function saveEdit() {
    if (!editingId || !draftName.trim()) return;
    const trimmed = draftPrice.trim();
    const priceNum = trimmed ? Number(trimmed) : null;
    // A non-numeric price must not silently save the add-on as free.
    if (priceNum !== null && (!Number.isFinite(priceNum) || priceNum < 0)) {
      toast("Extra price must be a number (or blank)", "error");
      return;
    }
    if (!Number.isInteger(draftDuration) || draftDuration < 0) {
      toast("Extra minutes must be a whole number", "error");
      return;
    }
    const id = editingId;
    start(async () => {
      const r = await updateAddOnAction(id, {
        name: draftName.trim(),
        durationMin: draftDuration,
        price: priceNum,
        serviceIds: draftServiceIds,
      });
      if (r.ok) {
        toast("Add-on updated", "success");
        setEditingId(null);
      } else toast("Couldn't save", "error");
    });
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="Add-ons"
        subtitle="Optional extras a customer can add to a service (e.g. beard trim). Adds time and price."
      />
      {/* Labeled columns (Drick: two bare spinners read as mystery numbers —
          say which is minutes and which is dollars). */}
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_110px_110px]">
        <label className="block">
          <span className={labelCls}>Add-on name</span>
          <input
            className={cn(field, "mt-1")}
            placeholder="e.g. Beard trim"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block">
          <span className={labelCls}>Extra minutes</span>
          <NumberField
            className={cn(field, "mt-1")}
            min={0}
            integer
            placeholder="+ min"
            value={duration}
            onChange={setDuration}
            aria-label="Extra minutes"
          />
        </label>
        <label className="block">
          <span className={labelCls}>Extra price ($)</span>
          <input
            className={cn(field, "mt-1")}
            type="number"
            min={0}
            inputMode="decimal"
            placeholder="+ $"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label="Extra price in dollars"
          />
        </label>
      </div>
      <div className="mt-3">
        <span className={labelCls}>Offer on</span>
        {/* Multi-select chips; each shows the service's own minutes + price so
            it's clear what the add-on extends. Nothing selected = every service. */}
        <div className="mt-1.5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setServiceIds([])}
            aria-pressed={serviceIds.length === 0}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              serviceIds.length === 0
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-subtle text-muted hover:text-offwhite",
            )}
          >
            All services
          </button>
          {activeServices.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggleService(s.id)}
              aria-pressed={serviceIds.includes(s.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                serviceIds.includes(s.id)
                  ? "border-gold/60 bg-gold/10 text-gold"
                  : "border-subtle text-muted hover:text-offwhite",
              )}
            >
              {s.name}
              <span className="opacity-70">
                {" "}
                · {s.durationMin} min{s.price !== null ? ` · $${s.price}` : ""}
              </span>
            </button>
          ))}
        </div>
      </div>
      <button
        onClick={add}
        disabled={pending}
        className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        Add add-on
      </button>

      <ul className="mt-5 flex flex-col gap-2">
        {initial.filter((a) => a.active).map((a) =>
          editingId === a.id ? (
            // Inline editor: the same labeled fields as the add form, prefilled.
            <li
              key={a.id}
              className="rounded-xl border border-gold/40 bg-charcoal-700/40 px-4 py-3"
            >
              <div className="grid gap-2 sm:grid-cols-[1fr_110px_110px]">
                <label className="block">
                  <span className={labelCls}>Add-on name</span>
                  <input
                    className={cn(field, "mt-1")}
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    aria-label="Add-on name"
                  />
                </label>
                <label className="block">
                  <span className={labelCls}>Extra minutes</span>
                  <NumberField
                    className={cn(field, "mt-1")}
                    min={0}
                    integer
                    value={draftDuration}
                    onChange={setDraftDuration}
                    aria-label="Extra minutes"
                  />
                </label>
                <label className="block">
                  <span className={labelCls}>Extra price ($)</span>
                  <input
                    className={cn(field, "mt-1")}
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={draftPrice}
                    onChange={(e) => setDraftPrice(e.target.value)}
                    aria-label="Extra price in dollars"
                  />
                </label>
              </div>
              <div className="mt-2">
                <span className={labelCls}>Offer on</span>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setDraftServiceIds([])}
                    aria-pressed={draftServiceIds.length === 0}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs transition-colors",
                      draftServiceIds.length === 0
                        ? "border-gold/60 bg-gold/10 text-gold"
                        : "border-subtle text-muted hover:text-offwhite",
                    )}
                  >
                    All services
                  </button>
                  {activeServices.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() =>
                        setDraftServiceIds((cur) =>
                          cur.includes(s.id)
                            ? cur.filter((x) => x !== s.id)
                            : [...cur, s.id],
                        )
                      }
                      aria-pressed={draftServiceIds.includes(s.id)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-xs transition-colors",
                        draftServiceIds.includes(s.id)
                          ? "border-gold/60 bg-gold/10 text-gold"
                          : "border-subtle text-muted hover:text-offwhite",
                      )}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={saveEdit}
                  disabled={pending}
                  className="rounded-xl bg-gold px-4 py-2 text-xs font-semibold text-charcoal-900 disabled:opacity-50"
                >
                  {pending ? "Saving…" : "Save changes"}
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="text-xs text-muted hover:underline"
                >
                  Cancel
                </button>
              </div>
            </li>
          ) : (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-xl border border-subtle px-4 py-2.5"
            >
              <span className="text-sm">
                {a.name}{" "}
                <span className="text-xs text-muted">
                  · +{a.durationMin} min{a.price !== null ? ` · +$${a.price}` : ""} ·{" "}
                  {scopeLabel(a.serviceIds)}
                </span>
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => beginEdit(a)}
                  className="text-xs text-gold hover:underline"
                  aria-label={`Edit ${a.name}`}
                >
                  Edit
                </button>
                <button
                  onClick={() => remove(a.id)}
                  className="text-xs text-danger-soft hover:underline"
                >
                  Remove
                </button>
              </div>
            </li>
          ),
        )}
        {initial.filter((a) => a.active).length === 0 && (
          <li className="text-sm text-muted">No add-ons yet.</li>
        )}
      </ul>
    </Card>
  );
}

//  Service groups (Acuity-style) - bundle services under ONE shared config:
//  shared available-hours that OVERRIDE each member's own windows, plus booking
//  limits (maxPerDay = total bookings/shop-local-day across all members;
//  maxConcurrent = overlapping bookings at once across the group). Each group
//  renders COMPACT (collapsed header) by default and EXPANDED on toggle. The list
//  refreshes via revalidatePath on every action, so there's no local list sync.

function ServiceGroupsManager({
  initial,
  services,
  toast,
  unsavedRef,
}: {
  initial: ServiceGroupRow[];
  services: ServiceRow[];
  toast: Toast;
  // Dirty/saving check registered by the open editor (see ServiceGroupEditor).
  unsavedRef: MutableRefObject<(() => EditorGuardState) | null>;
}) {
  const [name, setName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const activeGroups = initial.filter((g) => g.active);

  // Collapsing this group — or expanding another — unmounts the open editor
  // and its draft. Confirm first when it holds unsaved edits, so a stray tap
  // can't silently discard a half-configured hours grid. Mid-save the tap is
  // ignored outright (see switchTab for why).
  function toggle(id: string) {
    const st = unsavedRef.current?.();
    if (st?.saving) return;
    if (
      st?.dirty &&
      !window.confirm("You have unsaved group edits. Leave and lose them?")
    ) {
      return;
    }
    setExpandedId((cur) => (cur === id ? null : id));
  }

  function add() {
    if (!name.trim()) return;
    start(async () => {
      const r = await createServiceGroupAction({ name: name.trim() });
      if (r.ok) {
        toast("Group added", "success");
        setName("");
      } else toast("Couldn't add", "error");
    });
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="Service groups"
        subtitle="Bundle services under one shared set of available hours and booking limits (Acuity-style). A grouped service uses the group's hours instead of its own."
      />
      <div className="mt-3 flex gap-2">
        <input
          className={field}
          placeholder="Group name (e.g. Color services)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button
          onClick={add}
          disabled={pending}
          className="shrink-0 rounded-xl bg-gold px-4 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
        >
          Add group
        </button>
      </div>

      <ul className="mt-5 flex flex-col gap-2">
        {activeGroups.map((g) => (
          <ServiceGroupItem
            key={g.id}
            group={g}
            services={services}
            expanded={expandedId === g.id}
            onToggle={() => toggle(g.id)}
            toast={toast}
            unsavedRef={unsavedRef}
          />
        ))}
        {activeGroups.length === 0 && (
          <li className="text-sm text-muted">No service groups yet.</li>
        )}
      </ul>
    </Card>
  );
}

/** A limits summary for the collapsed header ("Using global limits" / "5/day ·
 *  2 at once" / "5/day" / "2 at once"). Both null = no caps set on the group. */
function limitsSummary(maxPerDay: number | null, maxConcurrent: number | null): string {
  const parts: string[] = [];
  if (maxPerDay != null) parts.push(`${maxPerDay}/day`);
  if (maxConcurrent != null) parts.push(`${maxConcurrent} at once`);
  return parts.length ? parts.join(" · ") : "Using global limits";
}

// One group row: COMPACT header (name · N services · limits · chevron). The
// editor mounts ONLY while expanded (ServiceGroupEditor below), so its draft
// always seeds from the CURRENT server row at open — the same open-time-seed
// idiom as the add-on inline edit and the staff hours Sheet.
function ServiceGroupItem({
  group,
  services,
  expanded,
  onToggle,
  toast,
  unsavedRef,
}: {
  group: ServiceGroupRow;
  services: ServiceRow[];
  expanded: boolean;
  onToggle: () => void;
  toast: Toast;
  unsavedRef: MutableRefObject<(() => EditorGuardState) | null>;
}) {
  // The row a save JUST persisted, until the server props catch up. After Save,
  // revalidatePath refetches this page's eight API calls — seconds on prod —
  // and a collapse + re-expand inside that window used to re-seed the editor
  // from PRE-save props: the barber watched his just-saved hours "revert" and
  // typed them all in again ("it still isn't saving"). Seeding from the
  // last-saved row instead makes a reopened editor always show what was
  // actually written. Cleared once props deep-equal it (the refresh landed),
  // so later genuine server changes are never masked.
  const [lastSaved, setLastSaved] = useState<ServiceGroupRow | null>(null);
  useEffect(() => {
    if (!lastSaved) return;
    if (
      group.name === lastSaved.name &&
      group.maxPerDay === lastSaved.maxPerDay &&
      group.maxConcurrent === lastSaved.maxConcurrent &&
      JSON.stringify(group.serviceIds) === JSON.stringify(lastSaved.serviceIds) &&
      JSON.stringify(group.hoursWindows) === JSON.stringify(lastSaved.hoursWindows)
    ) {
      setLastSaved(null);
    }
  }, [group, lastSaved]);
  const current = lastSaved ?? group;
  // Group hours govern every member service, so a restricted group is the one
  // place a whole bundle silently leaves the regular schedule — star it here
  // too, reading from `current` so a just-saved change stars immediately.
  const offHours = hasCustomHours(current.hoursWindows);
  return (
    <li className={cn("rounded-xl border", offHours ? "border-gold/40" : "border-subtle")}>
      {/* COMPACT header - always visible; the chevron toggles the editor. */}
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 px-4 py-2.5 text-left"
      >
        <span className="min-w-0 text-sm">
          {offHours && <OffHoursStar />}
          {current.name}{" "}
          <span className="text-xs text-muted">
            · {current.serviceIds.length} service
            {current.serviceIds.length === 1 ? "" : "s"} ·{" "}
            {limitsSummary(current.maxPerDay, current.maxConcurrent)}
          </span>
          {offHours && (
            <span className="mt-0.5 block text-xs text-gold/90">
              {hoursWindowsSummary(current.hoursWindows)}
            </span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 text-muted transition-transform duration-150 ease-out",
            expanded && "rotate-180",
          )}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {/* EXPANDED - the editor. Mounted per open so drafts can't go stale:
          it seeds from the freshest row we know — the just-saved values while
          the post-save refetch is still in flight, server props otherwise. */}
      {expanded && (
        <ServiceGroupEditor
          group={current}
          services={services}
          toast={toast}
          unsavedRef={unsavedRef}
          onSaved={setLastSaved}
        />
      )}
    </li>
  );
}

// The expanded editor for ONE group. Three deliberate behaviors, all fixes for
// real data loss ("every time you save or modify, hours reset" — Drick):
//  1. Drafts seed when the barber OPENS the group, never at tab render. The old
//     form mounted (collapsed) with the tab and never resynced with refreshed
//     props, so a Save from a stale row wrote its mount-time snapshot back.
//  2. Save PATCHes ONLY the fields changed in THIS editor. The old full-form
//     payload turned any staleness into silent overwrites — an untouched
//     all-Open hours grid re-serialized to {} and CLEARED the saved windows on
//     every unrelated save (rename, reorder, membership, caps).
//  3. Unsaved edits are guarded: collapse / switch-group / tab-switch confirm
//     first, and a hard unload gets the browser prompt (StaffHoursSheet idiom).
function ServiceGroupEditor({
  group,
  services,
  toast,
  unsavedRef,
  onSaved,
}: {
  group: ServiceGroupRow;
  services: ServiceRow[];
  toast: Toast;
  unsavedRef: MutableRefObject<(() => EditorGuardState) | null>;
  // Reports the row a successful save persisted, so the parent item can seed
  // a re-opened editor from it while the post-save refetch is in flight.
  onSaved: (row: ServiceGroupRow) => void;
}) {
  const activeServices = services.filter((s) => s.active);
  const [name, setName] = useState(group.name);
  const [serviceIds, setServiceIds] = useState<string[]>(group.serviceIds);
  const [hoursRows, setHoursRows] = useState<ServiceHoursRow[]>(() =>
    hoursRowsFromWindows(group.hoursWindows),
  );
  // 0 = no cap (sent to the API as null). NumberField holds a number and settles
  // an emptied field back to 0, so 0 is the natural "no cap" sentinel here.
  const [maxPerDay, setMaxPerDay] = useState<number>(group.maxPerDay ?? 0);
  const [maxConcurrent, setMaxConcurrent] = useState<number>(
    group.maxConcurrent ?? 0,
  );
  const [pending, start] = useTransition();
  // The last-persisted values in PAYLOAD form — the baseline the Save diff and
  // the dirty flag compare against. Hours round-trip rows -> windows so both
  // sides compare canonically ("any" days absent, closed days as []).
  const [saved, setSaved] = useState(() => ({
    name: group.name,
    hours: JSON.stringify(buildHoursWindows(hoursRowsFromWindows(group.hoursWindows))),
    maxPerDay: group.maxPerDay ?? null,
    maxConcurrent: group.maxConcurrent ?? null,
    serviceIds: JSON.stringify(group.serviceIds),
  }));

  function toggleService(id: string) {
    setServiceIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  }
  const allHoursCustom = hoursRows.every((r) => r.mode === "custom");

  // 0 (or blank, which NumberField settles to 0) = no cap → null. Otherwise the
  // cap must be a positive integer.
  function parseCap(n: number): { ok: boolean; value: number | null } {
    if (n <= 0) return { ok: true, value: null };
    if (!Number.isInteger(n)) return { ok: false, value: null };
    return { ok: true, value: n };
  }

  // Unsaved edits? Caps compare through the same 0/blank -> null they save as.
  const dirty =
    name.trim() !== saved.name ||
    JSON.stringify(buildHoursWindows(hoursRows)) !== saved.hours ||
    (maxPerDay <= 0 ? null : maxPerDay) !== saved.maxPerDay ||
    (maxConcurrent <= 0 ? null : maxConcurrent) !== saved.maxConcurrent ||
    JSON.stringify(serviceIds) !== saved.serviceIds;

  // While this editor is the open one, its dirty/saving state is what the
  // collapse / switch-group / tab-switch guards consult. Cleared on unmount.
  // The refs are written from effects, not during render — save() runs inside
  // useTransition, whose interruptible renders can be discarded before commit,
  // and a render-time write from a discarded render would leave the guards
  // reading state the UI never showed.
  const dirtyLive = useRef(dirty);
  const savingLive = useRef(pending);
  useEffect(() => {
    dirtyLive.current = dirty;
  }, [dirty]);
  useEffect(() => {
    savingLive.current = pending;
  }, [pending]);
  useEffect(() => {
    unsavedRef.current = () => ({
      dirty: dirtyLive.current,
      saving: savingLive.current,
    });
    return () => {
      unsavedRef.current = null;
    };
  }, [unsavedRef]);

  // Guard every exit while dirty: hard unloads via beforeunload, and the
  // dashboard's sticky-nav <Link>s / Sign-out form via the capture-phase
  // interceptors (soft navigation never fires beforeunload — one tap on
  // "Clients" used to silently discard the whole draft).
  useLeaveGuard(dirty, "You have unsaved group edits. Leave and lose them?");

  function save() {
    if (!name.trim()) {
      toast("Group name is required", "error");
      return;
    }
    if (hasInvalidHoursRow(hoursRows)) {
      toast("Group hours: each window's end must be after its start", "error");
      return;
    }
    const perDay = parseCap(maxPerDay);
    const concurrent = parseCap(maxConcurrent);
    if (!perDay.ok || !concurrent.ok) {
      toast("Limits must be a whole number (or blank for no cap)", "error");
      return;
    }
    const trimmed = name.trim();
    const hours = buildHoursWindows(hoursRows);
    const hoursJson = JSON.stringify(hours);
    const idsJson = JSON.stringify(serviceIds);
    // Only what changed in THIS editor goes in the PATCH (the API keeps absent
    // fields as-is) — an untouched field can never overwrite anything.
    const payload: Partial<ServiceGroupInput> = {
      ...(trimmed !== saved.name ? { name: trimmed } : {}),
      ...(hoursJson !== saved.hours ? { hoursWindows: hours } : {}),
      ...(perDay.value !== saved.maxPerDay ? { maxPerDay: perDay.value } : {}),
      ...(concurrent.value !== saved.maxConcurrent
        ? { maxConcurrent: concurrent.value }
        : {}),
      ...(idsJson !== saved.serviceIds ? { serviceIds } : {}),
    };
    if (Object.keys(payload).length === 0) {
      toast("Group saved", "success"); // nothing changed - already saved
      return;
    }
    // Snapshot exactly what's being persisted so a successful save clears
    // dirty; a failure keeps the draft AND the flag (nothing silently lost).
    const next = {
      name: trimmed,
      hours: hoursJson,
      maxPerDay: perDay.value,
      maxConcurrent: concurrent.value,
      serviceIds: idsJson,
    };
    start(async () => {
      const r = await updateServiceGroupAction(group.id, payload);
      if (r.ok) {
        setSaved(next);
        // Hand the persisted row up so a collapse + re-open seeds from it
        // while revalidatePath's refetch is still in flight (seconds on prod)
        // — re-seeding from pre-save props made saved hours LOOK reverted.
        onSaved({
          ...group,
          name: trimmed,
          hoursWindows: hours,
          maxPerDay: perDay.value,
          maxConcurrent: concurrent.value,
          serviceIds: [...serviceIds],
        });
        toast("Group saved", "success");
      } else {
        toast("Couldn't save — your changes are still here. Try again.", "error");
      }
    });
  }

  function remove() {
    if (
      !window.confirm(
        `Remove the group "${group.name}"? Its services stay, but the shared hours and limits are gone.`,
      )
    ) {
      return;
    }
    start(async () => {
      const r = await deleteServiceGroupAction(group.id);
      toast(r.ok ? "Group removed" : "Couldn't remove", r.ok ? "success" : "error");
    });
  }

  return (
    <div className="flex flex-col gap-4 border-t border-subtle px-4 py-4">
      <div>
        <span className={labelCls}>Group name</span>
        <input
          className={cn(field, "mt-1")}
          placeholder="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <span className={labelCls}>Services in this group</span>
        <p className="mt-0.5 text-[11px] text-muted">
          Tap a service to add it to — or remove it from — this group. A
          service can be in one group at a time, so adding it here moves it out
          of any other group. Hit Save to keep the change.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {activeServices.map((s) => {
            const inGroup = serviceIds.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => toggleService(s.id)}
                aria-pressed={inGroup}
                title={
                  inGroup
                    ? `Remove ${s.name} from this group`
                    : `Add ${s.name} to this group`
                }
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  inGroup
                    ? "border-gold/60 bg-gold/10 text-gold"
                    : "border-subtle text-muted hover:text-offwhite",
                )}
              >
                <span aria-hidden>{inGroup ? "✓ " : "+ "}</span>
                {s.name}
              </button>
            );
          })}
          {activeServices.length === 0 && (
            <span className="text-xs text-muted">Add a service first.</span>
          )}
        </div>
      </div>

      {/* Order within the group (Drick): the saved order is what customers
          see on the booking page. Save persists the array order. */}
      {serviceIds.length > 1 && (
        <div>
          <span className={labelCls}>Order in this group</span>
          <ul className="mt-1 flex flex-col gap-1">
            {serviceIds.map((id, i) => (
              <li
                key={id}
                className="flex items-center gap-2 rounded-lg border border-subtle px-3 py-1.5"
              >
                <span className="w-4 text-xs text-muted">{i + 1}.</span>
                <span className="flex-1 text-sm">
                  {services.find((s) => s.id === id)?.name ?? "…"}
                </span>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() =>
                    setServiceIds((cur) => {
                      const next = [...cur];
                      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                      return next;
                    })
                  }
                  className="px-1 text-sm text-muted transition-colors hover:text-gold disabled:opacity-30"
                  aria-label={`Move ${services.find((s) => s.id === id)?.name ?? "service"} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={i === serviceIds.length - 1}
                  onClick={() =>
                    setServiceIds((cur) => {
                      const next = [...cur];
                      [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                      return next;
                    })
                  }
                  className="px-1 text-sm text-muted transition-colors hover:text-gold disabled:opacity-30"
                  aria-label={`Move ${services.find((s) => s.id === id)?.name ?? "service"} down`}
                >
                  ↓
                </button>
                {/* Explicit remove — the chip above toggles membership too,
                    but an ✕ on the row is the affordance barbers look for. */}
                <button
                  type="button"
                  onClick={() => toggleService(id)}
                  className="px-1 text-xs text-muted transition-colors hover:text-danger-soft"
                  aria-label={`Remove ${services.find((s) => s.id === id)?.name ?? "service"} from this group`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-[11px] text-muted">
            This is the order customers see. Hit Save to keep it.
          </p>
        </div>
      )}

      {/* Shared available-hours grid - same idiom as ServiceEditForm; these
          hours OVERRIDE each member service's own windows. */}
      {/* All-Open = NO restriction: the group's services are bookable any
          time the barber works, and each member's OWN windows are ignored
          (the group override masks them). Said out loud because a wiped or
          never-set grid otherwise just looks like "Open everywhere" — and a
          barber who set per-service windows sees those times "reset" the
          moment a service joins the group, with no clue why. */}
      {hoursRows.every((r) => r.mode === "any") && (
        <p className="mb-1 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 text-[11px] text-gold/90">
          No group hours set — these services can be booked whenever the barber
          works, even if a service has its own hours. Set windows below to
          restrict them.
        </p>
      )}
      <CollapsibleHours
        title="Available hours for this group (optional)"
        summary={hoursSummary(hoursRows)}
      >
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() =>
              setHoursRows((cur) =>
                cur.map((r) => ({ ...r, mode: allHoursCustom ? "any" : "custom" })),
              )
            }
            className="shrink-0 rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:border-gold/50 hover:text-gold"
          >
            {allHoursCustom ? "All days: open" : "All days: custom"}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          Open = whenever the barber works that day. Custom = only the windows
          you set (add a second window for a split day). Not open = no
          bookings that day, for every service in this group.
        </p>
        <AvailableHoursRows
          rows={hoursRows}
          onChange={setHoursRows}
          ariaScope="this group"
        />
      </CollapsibleHours>

      {/* Booking limits across the whole group. Blank/0 = no cap. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelCls}>Max per day (blank = no cap)</span>
          <NumberField
            min={0}
            max={1000}
            integer
            className={cn(field, "mt-1")}
            placeholder="No cap"
            value={maxPerDay}
            onChange={setMaxPerDay}
            aria-label="Max bookings per day for this group"
          />
        </label>
        <label className="block">
          <span className={labelCls}>Max at once (blank = no cap)</span>
          <NumberField
            min={0}
            max={100}
            integer
            className={cn(field, "mt-1")}
            placeholder="No cap"
            value={maxConcurrent}
            onChange={setMaxConcurrent}
            aria-label="Max concurrent bookings for this group"
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={pending}
          className="rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          onClick={remove}
          disabled={pending}
          className="text-xs text-danger-soft hover:underline disabled:opacity-50"
        >
          Remove
        </button>
        {dirty && (
          <span className="text-[11px] text-gold" role="status">
            Unsaved changes — hit Save to keep them.
          </span>
        )}
      </div>
    </div>
  );
}

// A recurring weekly break within a weekday (HH:MM strings for the pickers).
type HourBreak = { start: string; end: string; reason: string };
type HourRow = { on: boolean; start: string; end: string; breaks: HourBreak[] };

// Time pickers sit shoulder-to-shoulder in every hours editor, so they carry
// their own padding (px-2.5 py-1.5) rather than relying on the gap alone — two
// adjacent selects with tight padding read as one wide control.
const timeSelectCls =
  "rounded-lg border border-subtle bg-charcoal-700 px-2.5 py-1.5 text-sm text-offwhite disabled:opacity-40";

// Weekly-hours editor for ONE staff member, shown in a Sheet from the Staff tab.
// Hours persist only on "Save hours", so an unsaved close would silently lose
// edits — the same "I filled it in, left, and it was gone" trap the old Hours
// tab guarded. We diff against the loaded/saved snapshot and confirm on close.
function StaffHoursSheet({
  staffId,
  staffName,
  toast,
  onClose,
}: {
  staffId: string;
  staffName: string;
  toast: Toast;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<HourRow[]>(() =>
    WEEKDAYS.map(() => ({ on: false, start: "09:00", end: "17:00", breaks: [] })),
  );
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();
  // JSON snapshot of the last loaded/saved state; `dirty` = unsaved edits exist.
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const dirty = loaded && JSON.stringify(rows) !== savedSnapshot;

  // Load this staff member's hours on mount (the Sheet only opens for one).
  useEffect(() => {
    start(async () => {
      const r = await getAvailabilityAction(staffId);
      const next: HourRow[] = WEEKDAYS.map(() => ({
        on: false,
        start: "09:00",
        end: "17:00",
        breaks: [],
      }));
      if (r.ok && r.data) {
        for (const rule of r.data.rules) {
          next[rule.weekday] = {
            ...next[rule.weekday]!,
            on: true,
            start: minToHHMM(rule.startMin),
            end: minToHHMM(rule.endMin),
          };
        }
        // Recurring breaks bucket onto their weekday (turn the day on too, so a
        // break isn't stranded on an unchecked - and therefore closed - day).
        for (const b of r.data.recurringBlocks) {
          const row = next[b.weekday];
          if (!row) continue;
          row.on = true;
          row.breaks.push({
            start: minToHHMM(b.startMin),
            end: minToHHMM(b.endMin),
            reason: b.reason ?? "",
          });
        }
      }
      setRows(next);
      setSavedSnapshot(JSON.stringify(next)); // this loaded state IS the baseline
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staffId]);

  // Guard every exit while dirty: hard unloads, and the dashboard's sticky-nav
  // <Link>s / Sign-out form (soft navigation never fires beforeunload — the
  // Sheet's backdrop doesn't cover the top nav, so a stray tap there used to
  // discard the whole week silently). The in-app close is guarded by
  // attemptClose below.
  useLeaveGuard(dirty, "You have unsaved hours. Leave and lose them?");

  function attemptClose() {
    if (dirty && !window.confirm("You have unsaved hours. Close and lose them?")) {
      return;
    }
    onClose();
  }

  function patchRow(i: number, patch: Partial<HourRow>) {
    setRows((cur) => cur.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  function addBreak(i: number) {
    setRows((cur) =>
      cur.map((c, j) =>
        j === i
          ? { ...c, breaks: [...c.breaks, { start: "12:00", end: "13:00", reason: "" }] }
          : c,
      ),
    );
  }
  function patchBreak(i: number, bi: number, patch: Partial<HourBreak>) {
    setRows((cur) =>
      cur.map((c, j) =>
        j === i
          ? { ...c, breaks: c.breaks.map((b, k) => (k === bi ? { ...b, ...patch } : b)) }
          : c,
      ),
    );
  }
  function removeBreak(i: number, bi: number) {
    setRows((cur) =>
      cur.map((c, j) => (j === i ? { ...c, breaks: c.breaks.filter((_, k) => k !== bi) } : c)),
    );
  }

  function save() {
    const rules = rows
      .map((r, weekday) =>
        r.on ? { weekday, startMin: hhmmToMin(r.start), endMin: hhmmToMin(r.end) } : null,
      )
      .filter((x): x is { weekday: number; startMin: number; endMin: number } => x !== null);
    if (rules.some((r) => r.endMin <= r.startMin)) {
      toast("Each day's end time must be after its start time", "error");
      return;
    }
    // Only breaks on ENABLED days are meaningful (a break on a closed day
    // subtracts from nothing).
    const recurringBlocks: {
      weekday: number;
      startMin: number;
      endMin: number;
      reason?: string;
    }[] = [];
    for (const [weekday, r] of rows.entries()) {
      if (!r.on) continue;
      for (const b of r.breaks) {
        recurringBlocks.push({
          weekday,
          startMin: hhmmToMin(b.start),
          endMin: hhmmToMin(b.end),
          reason: b.reason.trim() || undefined,
        });
      }
    }
    if (recurringBlocks.some((b) => b.endMin <= b.startMin)) {
      toast("Each break's end time must be after its start time", "error");
      return;
    }
    // Snapshot exactly what's being persisted so a successful save clears dirty.
    const snapshotAtSave = JSON.stringify(rows);
    start(async () => {
      const r = await saveAvailabilityAction(staffId, rules, recurringBlocks);
      if (r.ok) {
        setSavedSnapshot(snapshotAtSave);
        toast("Hours saved", "success");
      } else {
        // Do NOT clear dirty on failure - the edits are still unsaved.
        toast("Couldn't save — your changes are still here. Try again.", "error");
      }
    });
  }

  return (
    <Sheet title={`${staffName} — weekly hours`} onClose={attemptClose}>
      <p className="mb-3 text-xs text-muted">
        When this staff member is available to book — and any recurring breaks.
      </p>
      {!loaded ? (
        <p className="text-sm text-muted">Loading hours…</p>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {rows.map((r, i) => (
              <div key={i} className="rounded-lg border border-subtle/60 p-2.5">
                <div className="flex items-center gap-3">
                  <label className="flex w-20 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={r.on}
                      onChange={(e) => patchRow(i, { on: e.target.checked })}
                    />
                    {WEEKDAYS[i]}
                  </label>
                  <TimeSelect
                    disabled={!r.on}
                    value={r.start}
                    onChange={(v) => patchRow(i, { start: v })}
                    className={timeSelectCls}
                    aria-label={`${WEEKDAYS[i]} start`}
                  />
                  <span className="text-muted">–</span>
                  <TimeSelect
                    disabled={!r.on}
                    value={r.end}
                    onChange={(v) => patchRow(i, { end: v })}
                    className={timeSelectCls}
                    aria-label={`${WEEKDAYS[i]} end`}
                  />
                </div>

                {/* Recurring breaks for this weekday (a standing lunch etc.) -
                    subtracted from the shift automatically every week. */}
                {r.on && (
                  <div className="mt-2 flex flex-col gap-2 pl-[5.75rem]">
                    {r.breaks.map((b, bi) => (
                      <div key={bi} className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] uppercase tracking-wide text-muted">
                          Break
                        </span>
                        <TimeSelect
                          value={b.start}
                          onChange={(v) => patchBreak(i, bi, { start: v })}
                          className={timeSelectCls}
                          aria-label={`${WEEKDAYS[i]} break start`}
                        />
                        <span className="text-muted">–</span>
                        <TimeSelect
                          value={b.end}
                          onChange={(v) => patchBreak(i, bi, { end: v })}
                          className={timeSelectCls}
                          aria-label={`${WEEKDAYS[i]} break end`}
                        />
                        <input
                          type="text"
                          placeholder="Label (e.g. Lunch)"
                          maxLength={200}
                          value={b.reason}
                          onChange={(e) => patchBreak(i, bi, { reason: e.target.value })}
                          className="w-32 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm text-offwhite placeholder:text-muted"
                          aria-label={`${WEEKDAYS[i]} break label`}
                        />
                        <button
                          type="button"
                          onClick={() => removeBreak(i, bi)}
                          className="text-xs text-danger-soft hover:underline"
                          aria-label="Remove break"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addBreak(i)}
                      className="self-start text-xs text-gold hover:underline"
                    >
                      + Add a recurring break
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={save}
              disabled={pending}
              className="rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
            >
              {pending ? "Saving…" : dirty ? "Save hours" : "Saved ✓"}
            </button>
            {dirty && !pending && <span className="text-xs text-gold">Unsaved changes</span>}
          </div>
        </>
      )}
    </Sheet>
  );
}

//  helpers

function minToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// Shared by the add form (ServicesTab) and the edit Sheet (ServiceEditForm) so
// the "vary by day" and per-service-hours payloads are built identically.

/** {weekday: price} from the day inputs, keeping only valid non-negative entries. */
function buildPriceOverrides(dayPrices: Record<number, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [wd, val] of Object.entries(dayPrices)) {
    const n = Number(val);
    if (val.trim() !== "" && Number.isFinite(n) && n >= 0) out[wd] = n;
  }
  return out;
}

/** {weekday: minutes} - whole minutes, 5 min floor (mirrors the API bound). */
function buildDurationOverrides(
  dayDurations: Record<number, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [wd, val] of Object.entries(dayDurations)) {
    const n = Number(val);
    if (val.trim() !== "" && Number.isInteger(n) && n >= 5) out[wd] = n;
  }
  return out;
}

// Per-weekday availability rows. Three modes (Drick: unchecking a day looked
// like "closed" but actually meant "whenever the barber works" — so the day
// still showed bookable; and one window/day couldn't express 9-10am + 8-11pm):
//  "any"    — key omitted from the payload: open whenever the barber works
//  "custom" — one or more windows limit the day (stored as [{s,e},...])
//  "closed" — [] stored: no bookings that day at all
type HoursWindow = { start: string; end: string };
type ServiceHoursRow = { mode: "any" | "custom" | "closed"; windows: HoursWindow[] };

/** Most windows one day can hold in the UI (the API accepts up to 6). */
const MAX_DAY_WINDOWS = 4;

/**
 * {weekday: [{s,e},...]} from the hours rows. "any" days are omitted (open
 * whenever the barber works), "closed" days emit [] (no bookings), "custom"
 * days emit every window. The full map is sent (including {} to clear).
 * Windows are assumed valid — save() rejects end<=start before calling this.
 */
function buildHoursWindows(
  rows: ServiceHoursRow[],
): Record<string, { s: number; e: number }[]> {
  const out: Record<string, { s: number; e: number }[]> = {};
  rows.forEach((r, wd) => {
    if (r.mode === "any") return; // absent = open per barber's hours
    out[String(wd)] =
      r.mode === "closed"
        ? []
        : r.windows.map((w) => ({ s: hhmmToMin(w.start), e: hhmmToMin(w.end) }));
  });
  return out;
}

/** True when any custom day holds a window whose end isn't after its start. */
function hasInvalidHoursRow(rows: ServiceHoursRow[]): boolean {
  return rows.some(
    (r) =>
      r.mode === "custom" &&
      r.windows.some((w) => hhmmToMin(w.end) <= hhmmToMin(w.start)),
  );
}

const DEFAULT_WINDOW: HoursWindow = { start: "10:00", end: "14:00" };

/** Seed the edit form's hours rows from a stored hoursWindows map. */
function hoursRowsFromWindows(
  windows: Record<string, { s: number; e: number }[]> | undefined,
): ServiceHoursRow[] {
  return WEEKDAYS.map((_, wd) => {
    const w = windows?.[String(wd)];
    // Keep a default window in state even for any/closed so switching the mode
    // to "custom" starts from something sensible instead of an empty list.
    if (!w) return { mode: "any", windows: [{ ...DEFAULT_WINDOW }] };
    if (w.length === 0) return { mode: "closed", windows: [{ ...DEFAULT_WINDOW }] };
    return {
      mode: "custom",
      windows: w.map((x) => ({ start: minToHHMM(x.s), end: minToHHMM(x.e) })),
    };
  });
}

/** "6:00 PM" from shop-local minutes-past-midnight. */
function fmtClock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** Same clock, minus the noise: "6 PM" on the hour, "6:30 PM" otherwise. */
function fmtClockShort(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/**
 * A window as a compact range. Both ends in the same half of the day share one
 * meridiem ("1–3 PM", not "1:00 PM–3:00 PM") — over a seven-day schedule that
 * repetition is most of the line.
 */
function fmtRangeShort(s: number, e: number): string {
  const sameHalf = Math.floor(s / 60) % 24 < 12 === (Math.floor(e / 60) % 24 < 12);
  const start = sameHalf ? fmtClockShort(s).replace(/ [AP]M$/, "") : fmtClockShort(s);
  return `${start}–${fmtClockShort(e)}`;
}

//  OFF-REGULAR-HOURS BADGE. A service/group left entirely on "Open (barber's
//  hours)" stores {} — it runs whenever the chair does. The moment ANY weekday
//  is set to custom windows or to closed, that item no longer follows the
//  regular schedule, and until now the only way to discover that was to open
//  the editor and expand "Available hours". These two helpers drive the ★ and
//  the plain-language hours line on the list rows.

/** True when any weekday is restricted — a custom window OR a closed day. */
function hasCustomHours(
  windows: Record<string, { s: number; e: number }[]> | undefined,
): boolean {
  return Object.keys(windows ?? {}).length > 0;
}

/**
 * The stored hours map in plain language: "Tue, Thu 6–9 PM · closed Sun".
 * Weekdays sharing identical windows collapse onto one clause, and days ABSENT
 * from the map are never mentioned — those are the regular hours, which is the
 * whole point of the badge. Returns "" for an unrestricted map.
 *
 * TRUNCATED ON PURPOSE. The first version spelled out every distinct day, which
 * on a real seven-day schedule with split shifts ran to 278 characters PER ROW
 * and buried the page — "it got overloaded looks like too much is going on"
 * (Drick). The row only has to answer "is this one on regular hours, and
 * roughly when?"; the editor is where the full grid belongs. So: at most
 * MAX_CLAUSES day-clauses, then a count of the rest, and the closed-days clause
 * kept last because "closed Sun" is the part a barber scans for.
 */
const MAX_CLAUSES = 2;
function hoursWindowsSummary(
  windows: Record<string, { s: number; e: number }[]> | undefined,
): string {
  const closed: string[] = [];
  // Window-text -> the weekdays that share it, so "Tue 6-9, Thu 6-9" reads as
  // "Tue, Thu 6-9 PM". Insertion order is Sun..Sat (the loop below).
  const byWindows = new Map<string, string[]>();
  for (let wd = 0; wd < 7; wd++) {
    const w = windows?.[String(wd)];
    if (!w) continue; // absent = the barber's regular hours
    const day = WEEKDAYS[wd]!;
    if (w.length === 0) {
      closed.push(day);
      continue;
    }
    const text = w.map((x) => fmtRangeShort(x.s, x.e)).join(", ");
    const days = byWindows.get(text);
    if (days) days.push(day);
    else byWindows.set(text, [day]);
  }
  const all = [...byWindows.entries()].map(
    ([text, days]) => `${days.join(", ")} ${text}`,
  );
  const parts = all.slice(0, MAX_CLAUSES);
  const hiddenDays = [...byWindows.values()]
    .slice(MAX_CLAUSES)
    .reduce((n, days) => n + days.length, 0);
  if (hiddenDays > 0) parts.push(`+${hiddenDays} more day${hiddenDays > 1 ? "s" : ""}`);
  if (closed.length > 0) parts.push(`closed ${closed.join(", ")}`);
  return parts.join(" · ");
}

/**
 * Which hours actually govern a service — mirroring engines/slots.ts exactly:
 * membership in an ACTIVE group makes the GROUP's windows override the
 * service's own (an inactive group is ignored, so the service's own windows
 * apply again). Getting this wrong would star the wrong rows: a grouped service
 * with {} of its own still runs on restricted hours, and its own leftover
 * windows are dead config the engine never reads.
 */
function effectiveServiceHours(
  service: ServiceRow,
  groups: ServiceGroupRow[],
): { windows: Record<string, { s: number; e: number }[]>; groupName: string | null } {
  const group = service.serviceGroupId
    ? groups.find((g) => g.id === service.serviceGroupId && g.active)
    : undefined;
  return group
    ? { windows: group.hoursWindows, groupName: group.name }
    : { windows: service.hoursWindows, groupName: null };
}

/**
 * The ★ that marks a row as not-on-regular-hours. Decorative on its own (the
 * hours line beside it carries the meaning in text, so this is never
 * symbol-or-color-only), with an sr-only lead-in for screen readers.
 */
function OffHoursStar() {
  return (
    <>
      <span aria-hidden="true" className="mr-1 text-gold" title="Not on regular hours">
        ★
      </span>
      <span className="sr-only">Custom hours. </span>
    </>
  );
}

/**
 * One-line summary of the per-day hours state, shown on the collapsed button so
 * a barber sees the setting without expanding. "Open every day" is the untouched
 * default (all days = the barber's own hours); otherwise it names how many days
 * are custom and/or closed.
 */
function hoursSummary(rows: ServiceHoursRow[]): string {
  const custom = rows.filter((r) => r.mode === "custom").length;
  const closed = rows.filter((r) => r.mode === "closed").length;
  if (custom === 0 && closed === 0) return "Open every day";
  const parts: string[] = [];
  if (custom > 0) parts.push(`custom on ${custom} day${custom > 1 ? "s" : ""}`);
  if (closed > 0) parts.push(`closed ${closed} day${closed > 1 ? "s" : ""}`);
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Collapsible "Available hours" wrapper: a summary button that expands the given
 * editor in place when tapped (and collapses again). Keeps the tall 7-day grid
 * out of the way until the barber wants it — the Edit-service / group modals were
 * dominated by it. `summary` reflects the current state so it's readable closed.
 */
function CollapsibleHours({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-subtle bg-charcoal-700 px-3 py-2.5 text-left transition-colors hover:border-gold/50"
      >
        <span className="flex flex-col">
          <span className="text-sm text-offwhite">{title}</span>
          <span className="text-[11px] text-muted">{summary}</span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-muted transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          ▸
        </span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/**
 * The shared per-weekday availability editor (service editor + group editor).
 * Each day picks a mode — Open (barber's hours) / Custom hours / Not open —
 * and a custom day can hold several windows ("+ hours": 9-10am AND 8-11pm).
 */
function AvailableHoursRows({
  rows,
  onChange,
  ariaScope,
}: {
  rows: ServiceHoursRow[];
  onChange: (rows: ServiceHoursRow[]) => void;
  /** e.g. "this service" / "this group" — used in aria labels. */
  ariaScope: string;
}) {
  function patchRow(i: number, patch: Partial<ServiceHoursRow>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function patchWindow(i: number, k: number, patch: Partial<HoursWindow>) {
    patchRow(i, {
      windows: rows[i]!.windows.map((w, j) => (j === k ? { ...w, ...patch } : w)),
    });
  }
  return (
    // One bordered list with a rule between days. Seven bare rows 8px apart
    // read as a single dense block of dropdowns — you can't tell at a glance
    // where Monday ends and Tuesday begins, which is exactly the row you're
    // trying to edit. The divider does that work; the row padding gives each
    // day room to breathe.
    <div className="mt-2 divide-y divide-subtle overflow-hidden rounded-xl border border-subtle">
      {rows.map((r, i) => (
        // flex-wrap: the windows sit beside the select where they fit and wrap
        // under it on narrow screens — never overflowing the card (the full-
        // width `field` select pushed the times out of the card entirely).
        <div
          key={i}
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5",
            // A closed day has nothing to configure — dim it so the days that
            // DO carry settings are what the eye lands on.
            r.mode === "closed" && "opacity-60",
          )}
        >
          <span className="w-10 shrink-0 text-sm font-medium">{WEEKDAYS[i]}</span>
          {/* Deliberately NOT the shared `field` class (w-full): a compact
              fixed-width select keeps all 7 rows aligned. Short labels — the
              helper text above the grid explains each mode. */}
          <select
            className="w-32 shrink-0 rounded-lg border border-subtle bg-charcoal-700 px-2.5 py-1.5 text-xs text-offwhite outline-none focus:border-gold/50"
            value={r.mode}
            onChange={(e) =>
              patchRow(i, { mode: e.target.value as ServiceHoursRow["mode"] })
            }
            aria-label={`${WEEKDAYS[i]} availability for ${ariaScope}`}
          >
            <option value="any">Open</option>
            <option value="custom">Custom hours</option>
            <option value="closed">Not open</option>
          </select>
          {r.mode === "custom" && (
            // Stacked windows on one day need to read as a set that belongs to
            // THIS day, not as more loose rows: a left rule ties them together
            // and to the weekday beside them.
            <div className="flex flex-col gap-2 border-l border-subtle pl-3">
              {r.windows.map((w, k) => (
                <div key={k} className="flex items-center gap-2.5">
                  <TimeSelect
                    value={w.start}
                    onChange={(v) => patchWindow(i, k, { start: v })}
                    className={timeSelectCls}
                    aria-label={`${WEEKDAYS[i]} window ${k + 1} from`}
                  />
                  <span className="px-0.5 text-muted">–</span>
                  <TimeSelect
                    value={w.end}
                    onChange={(v) => patchWindow(i, k, { end: v })}
                    className={timeSelectCls}
                    aria-label={`${WEEKDAYS[i]} window ${k + 1} until`}
                  />
                  {/* The row actions get their own margin + hit area: butted
                      straight against the "until" select they read as part of
                      the control, and were a hard tap target on a phone. */}
                  {r.windows.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        patchRow(i, { windows: r.windows.filter((_, j) => j !== k) })
                      }
                      className="ml-1 rounded px-1.5 py-1 text-xs text-muted transition-colors hover:text-danger-soft"
                      aria-label={`Remove ${WEEKDAYS[i]} window ${k + 1}`}
                    >
                      ✕
                    </button>
                  )}
                  {k === r.windows.length - 1 && r.windows.length < MAX_DAY_WINDOWS && (
                    <button
                      type="button"
                      onClick={() =>
                        // Seed the new window after the last one (a second
                        // evening window is the common case, e.g. 8-11pm).
                        patchRow(i, {
                          windows: [...r.windows, { start: w.end, end: "23:00" }],
                        })
                      }
                      className="ml-1 whitespace-nowrap rounded px-1.5 py-1 text-xs text-muted transition-colors hover:text-gold"
                      aria-label={`Add another ${WEEKDAYS[i]} window`}
                    >
                      + hours
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Per-weekday price/duration overrides ("vary by day"). Laid out as one ROW per
 * day rather than a cramped 7-column grid, with an explicit "$" on the price and
 * "min" on the duration, and inputs wide enough to actually show the number -
 * the old grid squeezed both into ~1/7 of the sheet, so values rendered as
 * unreadable stubs ("$6", "3C"). Blank = that day uses the base price/length; a
 * filled day highlights so it's obvious which days differ. Shared by the add and
 * edit forms so the two stay identical.
 */
function VaryByDayEditor({
  dayPrices,
  dayDurations,
  basePrice,
  baseDuration,
  onPrice,
  onDuration,
}: {
  dayPrices: Record<number, string>;
  dayDurations: Record<number, string>;
  basePrice: string;
  baseDuration: number;
  onPrice: (wd: number, value: string) => void;
  onDuration: (wd: number, value: string) => void;
}) {
  const cell =
    "w-full rounded-lg border border-subtle bg-charcoal-700 py-1.5 pl-6 pr-2 text-sm text-offwhite placeholder:text-muted/60 outline-none focus:border-gold/50";
  return (
    <div>
      <span className={labelCls}>Vary by day? (optional — price and/or minutes)</span>
      <p className="mt-0.5 text-[11px] text-muted">
        Leave a day blank to use the base {basePrice.trim() ? `$${basePrice}` : "price"} /{" "}
        {baseDuration || "?"} min. Fill one in to charge or run that day differently.
      </p>
      {/* Column headers so it's obvious which field is dollars vs. minutes. */}
      <div className="mt-2 grid grid-cols-[3rem_1fr_1fr] gap-2 px-0.5 text-[10px] uppercase tracking-wide text-muted">
        <span />
        <span>Price</span>
        <span>Minutes</span>
      </div>
      <div className="mt-1 flex flex-col gap-1.5">
        {WEEKDAYS.map((label, wd) => {
          const customized =
            (dayPrices[wd] ?? "").trim() !== "" || (dayDurations[wd] ?? "").trim() !== "";
          return (
            <div key={wd} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2">
              <span
                className={cn(
                  "text-xs",
                  customized ? "font-semibold text-gold" : "text-muted",
                )}
              >
                {label}
              </span>
              {/* Price — a persistent "$" prefix so the unit is never in doubt. */}
              <div className="relative">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted">
                  $
                </span>
                <input
                  type="number"
                  min={0}
                  inputMode="decimal"
                  placeholder={basePrice.trim() ? basePrice : "base"}
                  value={dayPrices[wd] ?? ""}
                  onChange={(e) => onPrice(wd, e.target.value)}
                  className={cell}
                  aria-label={`${label} price in dollars`}
                />
              </div>
              {/* Minutes — a persistent "min" suffix. */}
              <div className="relative">
                <input
                  type="number"
                  min={5}
                  inputMode="numeric"
                  placeholder={`${baseDuration || "?"}`}
                  value={dayDurations[wd] ?? ""}
                  onChange={(e) => onDuration(wd, e.target.value)}
                  className="w-full rounded-lg border border-subtle bg-charcoal-700 py-1.5 pl-2 pr-10 text-sm text-offwhite placeholder:text-muted/60 outline-none focus:border-gold/50"
                  aria-label={`${label} minutes`}
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted">
                  min
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

//  "Vary by time of day" — per-service TIME windows where the price and/or the
//  length differ (Drick: "select hours in which appointment duration varies …
//  slots would be shorter within a specific service"). Each row is a window
//  [from, to) in shop-local time that applies EVERY day, on top of any per-day
//  settings above. Inside a window the slot grid steps by the window's length
//  and the customer is shown (and charged) the window's price.

/** One draft row: HH:MM bounds + string drafts for the two optional fields. */
type TimeWindowRow = { start: string; end: string; price: string; durationMin: string };

const DEFAULT_TIME_WINDOW: TimeWindowRow = {
  start: "21:00",
  end: "23:00",
  price: "",
  durationMin: "",
};

/** Seed rows from the stored windows ([] -> no rows). */
function timeRowsFromOverrides(
  overrides:
    | { s: number; e: number; price: number | null; durationMin: number | null }[]
    | undefined,
): TimeWindowRow[] {
  return (overrides ?? []).map((w) => ({
    start: minToHHMM(w.s),
    end: minToHHMM(w.e),
    price: w.price !== null ? String(w.price) : "",
    durationMin: w.durationMin !== null ? String(w.durationMin) : "",
  }));
}

/**
 * Validate the draft rows; returns an error message or null. Mirrors the API
 * rules (end after start, price and/or minutes required per window, valid
 * values, no overlaps) so the barber gets a specific message instead of a
 * generic 400 "Couldn't save".
 */
function timeRowsError(rows: TimeWindowRow[]): string | null {
  const spans: { s: number; e: number }[] = [];
  for (const r of rows) {
    const s = hhmmToMin(r.start);
    const e = hhmmToMin(r.end);
    if (e <= s) return "Time windows: each window's end must be after its start";
    const price = r.price.trim();
    const mins = r.durationMin.trim();
    if (!price && !mins) {
      return "Time windows: set a price and/or minutes for each window (or remove it)";
    }
    if (price && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
      return "Time windows: price must be a number";
    }
    if (mins && (!Number.isInteger(Number(mins)) || Number(mins) < 5)) {
      return "Time windows: minutes must be a whole number of 5 or more";
    }
    spans.push({ s, e });
  }
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.s < sorted[i - 1]!.e) return "Time windows can't overlap";
  }
  return null;
}

/** API payload from validated rows (the FULL array; [] clears every window). */
function buildTimeOverrides(
  rows: TimeWindowRow[],
): { s: number; e: number; price?: number | null; durationMin?: number | null }[] {
  return rows.map((r) => ({
    s: hhmmToMin(r.start),
    e: hhmmToMin(r.end),
    price: r.price.trim() ? Number(r.price) : null,
    durationMin: r.durationMin.trim() ? Number(r.durationMin) : null,
  }));
}

/** Compact "9:00 PM–11:00 PM $65 / 20 min" label for the services list. */
function timeWindowSummary(w: {
  s: number;
  e: number;
  price: number | null;
  durationMin: number | null;
}): string {
  const bits = [
    w.price !== null ? `$${w.price}` : null,
    w.durationMin !== null ? `${w.durationMin}min` : null,
  ].filter(Boolean);
  return `${fmtClock(w.s)}–${fmtClock(w.e)} ${bits.join(" / ")}`;
}

function VaryByTimeEditor({
  rows,
  onChange,
  basePrice,
  baseDuration,
}: {
  rows: TimeWindowRow[];
  onChange: (rows: TimeWindowRow[]) => void;
  basePrice: string;
  baseDuration: number;
}) {
  const select =
    "rounded-lg border border-subtle bg-charcoal-700 py-1.5 px-2 text-sm text-offwhite outline-none focus:border-gold/50";
  function patch(i: number, part: Partial<TimeWindowRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...part } : r)));
  }
  return (
    <div>
      <span className={labelCls}>Vary by time of day? (optional — price and/or minutes)</span>
      <p className="mt-0.5 text-[11px] text-muted">
        e.g. after 9 PM cuts run $60 and take 20 min. Applies every day, on top
        of any per-day settings. Leave a field blank to keep the usual{" "}
        {basePrice.trim() ? `$${basePrice}` : "price"} / {baseDuration || "?"} min.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {rows.map((r, i) => (
          <div
            key={i}
            className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[1fr_1fr_96px_96px_auto]"
          >
            <TimeSelect
              value={r.start}
              onChange={(v) => patch(i, { start: v })}
              className={select}
              aria-label={`Window ${i + 1} start time`}
            />
            <TimeSelect
              value={r.end}
              onChange={(v) => patch(i, { end: v })}
              className={select}
              aria-label={`Window ${i + 1} end time`}
            />
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted">
                $
              </span>
              <input
                type="number"
                min={0}
                inputMode="decimal"
                placeholder={basePrice.trim() ? basePrice : "base"}
                value={r.price}
                onChange={(e) => patch(i, { price: e.target.value })}
                className="w-full rounded-lg border border-subtle bg-charcoal-700 py-1.5 pl-6 pr-2 text-sm text-offwhite placeholder:text-muted/60 outline-none focus:border-gold/50"
                aria-label={`Window ${i + 1} price in dollars`}
              />
            </div>
            <div className="relative">
              <input
                type="number"
                min={5}
                inputMode="numeric"
                placeholder={`${baseDuration || "?"}`}
                value={r.durationMin}
                onChange={(e) => patch(i, { durationMin: e.target.value })}
                className="w-full rounded-lg border border-subtle bg-charcoal-700 py-1.5 pl-2 pr-10 text-sm text-offwhite placeholder:text-muted/60 outline-none focus:border-gold/50"
                aria-label={`Window ${i + 1} minutes`}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted">
                min
              </span>
            </div>
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              className="justify-self-start text-xs text-danger-soft hover:underline"
              aria-label={`Remove time window ${i + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { ...DEFAULT_TIME_WINDOW }])}
        className="mt-2 rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:border-gold/50 hover:text-gold"
      >
        + Add time window
      </button>
    </div>
  );
}
