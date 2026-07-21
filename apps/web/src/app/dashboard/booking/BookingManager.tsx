"use client";

import { useEffect, useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { NumberField } from "@/components/ui/NumberField";
import { useToast } from "@/components/ui/Toast";
import { useDemoTour } from "@/components/tour/state";
import { cn } from "@/lib/cn";
import type {
  AddOnRow,
  AgendaResponse,
  BookingShop,
  ConnectStatus,
  ServiceRow,
  StaffRow,
  WaitlistRow,
} from "./page";
import { BookingCalendar } from "./BookingCalendar";
import { ConnectPlatforms } from "./ConnectPlatforms";
import { Sheet } from "./AppointmentForm";
import { TimeSelect } from "@/components/ui/TimeSelect";
import {
  createAddOnAction,
  createServiceAction,
  createStaffAction,
  createTargetedSlotAction,
  deleteAddOnAction,
  deleteServiceAction,
  deleteStaffAction,
  deleteTargetedSlotAction,
  getAvailabilityAction,
  listTargetedSlotsAction,
  saveAvailabilityAction,
  saveBookingSettingsAction,
  updateServiceAction,
  type TargetedSlotRow,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";
const tabs = ["Settings", "Staff", "Services", "Hours", "Appointments"] as const;
type Tab = (typeof tabs)[number];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function BookingManager({
  shop,
  appBase,
  apiBase,
  connect,
  initialStaff,
  initialServices,
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
  initialAddOns: AddOnRow[];
  initialAgenda: AgendaResponse;
  initialWaitlist: WaitlistRow[];
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("Settings");
  const bookUrl = `${appBase}/book/${shop.slug ?? "your-shop"}`;
  const needsSetup = initialStaff.length === 0 || initialServices.length === 0;

  // Dashboard demo tour: its steps on this page live behind tabs, so follow
  // the tour by switching to the tab that hosts the active step's anchor.
  const { stepId: dashTourStepId } = useDemoTour("dashboard");
  useEffect(() => {
    if (dashTourStepId === "dash-agenda") setTab("Appointments");
    else if (dashTourStepId === "dash-services") setTab("Services");
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
            onClick={() => setTab(t)}
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
            initialAddOns={initialAddOns}
            toast={toast}
          />
        </div>
      )}
      {tab === "Hours" && <HoursTab staff={initialStaff} toast={toast} />}
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
  const [remind24h, setRemind24h] = useState(shop.pushReminder24hEnabled);
  const [remind2h, setRemind2h] = useState(shop.pushReminder2hEnabled);
  const [pending, start] = useTransition();

  function persist(
    next: Partial<{
      mode: typeof mode;
      bookingUrl: string;
      slotOpened: boolean;
      requireApproval: boolean;
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
    </div>
  );
}

//  Staff

function StaffTab({ initial, toast }: { initial: StaffRow[]; toast: Toast }) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();

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
            <button
              onClick={() => remove(s.id)}
              className="text-xs text-danger-soft hover:underline"
            >
              Remove
            </button>
          </li>
        ))}
        {initial.filter((s) => s.active).length === 0 && (
          <li className="text-sm text-muted">No staff yet.</li>
        )}
      </ul>
    </Card>
  );
}

//  Services

function ServicesTab({
  initial,
  staff,
  initialAddOns,
  toast,
}: {
  initial: ServiceRow[];
  staff: StaffRow[];
  initialAddOns: AddOnRow[];
  toast: Toast;
}) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(30);
  const [price, setPrice] = useState("");
  // Per-weekday overrides the barber sets explicitly (weekday -> string).
  // Empty = that day uses the base price/length. Built into the API payload.
  const [dayPrices, setDayPrices] = useState<Record<number, string>>({});
  const [dayDurations, setDayDurations] = useState<Record<number, string>>({});
  // Empty = "offered by everyone" (resolved at submit). Starting empty avoids a
  // stale snapshot of the staff list - a barber added later is included by default.
  const [staffIds, setStaffIds] = useState<string[]>([]);
  // Which service the pencil opened for editing (null = the edit Sheet is closed).
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [pending, start] = useTransition();
  const activeStaff = staff.filter((s) => s.active);

  function add() {
    if (!name.trim()) return;
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
        offeredByAll: all,
        staffIds: all ? undefined : staffIds,
      });
      if (r.ok) {
        toast("Service added", "success");
        setName("");
        setPrice("");
        setDayPrices({});
        setDayDurations({});
        setStaffIds([]);
      } else toast("Couldn't add", "error");
    });
  }
  function remove(id: string) {
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

      <button
        onClick={add}
        disabled={pending}
        className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        Add service
      </button>

      <ul className="mt-5 flex flex-col gap-2">
        {initial.filter((s) => s.active).map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between rounded-xl border border-subtle px-4 py-2.5"
          >
            <span className="text-sm">
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
              </span>
            </span>
            <div className="flex items-center gap-3">
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
        ))}
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
          toast={toast}
          onClose={() => setEditing(null)}
        />
      )}

      <AddOnsManager initial={initialAddOns} services={initial} toast={toast} />

      <TargetedSlotsManager services={initial} staff={staff} toast={toast} />
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
  toast,
  onClose,
}: {
  service: ServiceRow;
  staff: StaffRow[];
  toast: Toast;
  onClose: () => void;
}) {
  const activeStaff = staff.filter((s) => s.active);
  const [name, setName] = useState(service.name);
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
  // Per-service available-hours rows (one window/day in v1), seeded from storage.
  const [hoursRows, setHoursRows] = useState<ServiceHoursRow[]>(() =>
    hoursRowsFromWindows(service.hoursWindows),
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
  function setHoursRow(i: number, patch: Partial<ServiceHoursRow>) {
    setHoursRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  // Check / uncheck every weekday at once (Drick: "an option to open all days
  // instead of checking one by one"). Preserves each row's start/end times.
  const allHoursChecked = hoursRows.every((r) => r.restricted);
  function setAllHours(restricted: boolean) {
    setHoursRows((cur) => cur.map((r) => ({ ...r, restricted })));
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
    // A restricted day whose end is not after its start is a user error, not a
    // "closed" instruction - block save so they don't silently lose the day.
    const badRow = hoursRows.some(
      (r) => r.restricted && hhmmToMin(r.end) <= hhmmToMin(r.start),
    );
    if (badRow) {
      toast("Service hours: end must be after start", "error");
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
        durationMin: duration,
        price: priceNum,
        // Always send the FULL maps (including {}) so clearing an override or a
        // restriction actually persists - PATCH is partial, absent = unchanged.
        priceOverrides: buildPriceOverrides(dayPrices),
        durationOverrides: buildDurationOverrides(dayDurations),
        hoursWindows: buildHoursWindows(hoursRows),
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

        {/* Per-day price/duration overrides (same idiom as the add form). */}
        <VaryByDayEditor
          dayPrices={dayPrices}
          dayDurations={dayDurations}
          basePrice={price}
          baseDuration={duration}
          onPrice={(wd, v) => setDayPrices((cur) => ({ ...cur, [wd]: v }))}
          onDuration={(wd, v) => setDayDurations((cur) => ({ ...cur, [wd]: v }))}
        />

        {/* Per-service available hours. Unchecked day = available whenever the
            barber works; check a day + set a window to limit this service (e.g.
            "Mens Haircut only 10:00-14:00"). It intersects with the barber's
            weekly hours - it never widens them. */}
        <div>
          <div className="flex items-center justify-between gap-3">
            <span className={labelCls}>Available hours for this service (optional)</span>
            {/* Check/uncheck every day in one tap instead of one by one. */}
            <button
              type="button"
              onClick={() => setAllHours(!allHoursChecked)}
              className="shrink-0 rounded-full border border-subtle px-3 py-1 text-xs text-muted transition-colors hover:border-gold/50 hover:text-gold"
            >
              {allHoursChecked ? "Uncheck all days" : "Check all days"}
            </button>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">
            Leave a day unchecked to offer it whenever the barber works. Check a
            day and set a window to limit it.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {hoursRows.map((r, i) => (
              <div key={i} className="flex items-center gap-3">
                <label className="flex w-20 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={r.restricted}
                    onChange={(e) => setHoursRow(i, { restricted: e.target.checked })}
                  />
                  {WEEKDAYS[i]}
                </label>
                <TimeSelect
                  disabled={!r.restricted}
                  value={r.start}
                  onChange={(v) => setHoursRow(i, { start: v })}
                  className={timeSelectCls}
                  aria-label={`${WEEKDAYS[i]} available from`}
                />
                <span className="text-muted">–</span>
                <TimeSelect
                  disabled={!r.restricted}
                  value={r.end}
                  onChange={(v) => setHoursRow(i, { end: v })}
                  className={timeSelectCls}
                  aria-label={`${WEEKDAYS[i]} available until`}
                />
              </div>
            ))}
          </div>
        </div>

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
  toast,
}: {
  services: ServiceRow[];
  staff: StaffRow[];
  toast: Toast;
}) {
  const activeServices = services.filter((s) => s.active);
  const activeStaff = staff.filter((s) => s.active);
  const [slots, setSlots] = useState<TargetedSlotRow[] | null>(null);
  const [serviceId, setServiceId] = useState("");
  const [staffId, setStaffId] = useState("");
  const [label, setLabel] = useState("");
  const [when, setWhen] = useState(""); // datetime-local string
  const [minutes, setMinutes] = useState(30);
  const [price, setPrice] = useState("");
  const [repeatWeeks, setRepeatWeeks] = useState(0);
  const [pending, start] = useTransition();

  function refresh() {
    start(async () => {
      const res = await listTargetedSlotsAction();
      if (res.ok && res.slots) setSlots(res.slots);
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
    const startsAt = new Date(when);
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
        repeatWeeks: repeatWeeks > 0 ? repeatWeeks : undefined,
      });
      if (r.ok) {
        toast("Slot published", "success");
        setLabel("");
        setWhen("");
        setPrice("");
        setRepeatWeeks(0);
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

  const whenFmt = new Intl.DateTimeFormat("en-US", {
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
        <label className="flex items-center gap-2 text-xs text-muted sm:col-span-2">
          Repeat weekly for
          <NumberField
            min={0}
            max={26}
            integer
            className="w-16 rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite"
            value={repeatWeeks}
            onChange={setRepeatWeeks}
            aria-label="Repeat weeks"
          />
          more week{repeatWeeks === 1 ? "" : "s"} (same day &amp; time)
        </label>
      </div>
      <button
        onClick={add}
        disabled={pending}
        className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        Publish slot
      </button>

      <ul className="mt-5 flex flex-col gap-2">
        {(slots ?? []).map((t) => (
          <li
            key={t.id}
            className="flex items-center justify-between rounded-xl border border-subtle px-4 py-2.5"
          >
            <span className="text-sm">
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
            {!t.booked && (
              <button
                onClick={() => remove(t.id)}
                className="text-xs text-danger-soft hover:underline"
              >
                Remove
              </button>
            )}
          </li>
        ))}
        {slots !== null && slots.length === 0 && (
          <li className="text-sm text-muted">No targeted slots yet.</li>
        )}
      </ul>
    </Card>
  );
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
  // "" = offered on every service; a service id scopes it to that one.
  const [serviceId, setServiceId] = useState<string>("");
  const [pending, start] = useTransition();
  const activeServices = services.filter((s) => s.active);
  const serviceName = (id: string | null) =>
    id === null ? "All services" : (services.find((s) => s.id === id)?.name ?? "A service");

  function add() {
    if (!name.trim()) return;
    start(async () => {
      const r = await createAddOnAction({
        name: name.trim(),
        durationMin: duration,
        price: price.trim() ? Number(price) : null,
        serviceId: serviceId || null,
      });
      if (r.ok) {
        toast("Add-on added", "success");
        setName("");
        setPrice("");
        setServiceId("");
      } else toast("Couldn't add", "error");
    });
  }
  function remove(id: string) {
    start(async () => {
      const r = await deleteAddOnAction(id);
      toast(r.ok ? "Add-on removed" : "Couldn't remove", r.ok ? "success" : "error");
    });
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="Add-ons"
        subtitle="Optional extras a customer can add to a service (e.g. beard trim). Adds time and price."
      />
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_110px_110px]">
        <input
          className={field}
          placeholder="Add-on name (e.g. Beard trim)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <NumberField
          className={field}
          min={0}
          integer
          placeholder="+ min"
          value={duration}
          onChange={setDuration}
          aria-label="Extra minutes"
        />
        <input
          className={field}
          type="number"
          min={0}
          inputMode="decimal"
          placeholder="+ price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          aria-label="Extra price"
        />
      </div>
      <div className="mt-2">
        <span className={labelCls}>Offer on</span>
        <select
          className={cn(field, "mt-1")}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          aria-label="Offer add-on on"
        >
          <option value="">All services</option>
          {activeServices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} only
            </option>
          ))}
        </select>
      </div>
      <button
        onClick={add}
        disabled={pending}
        className="mt-4 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        Add add-on
      </button>

      <ul className="mt-5 flex flex-col gap-2">
        {initial.filter((a) => a.active).map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between rounded-xl border border-subtle px-4 py-2.5"
          >
            <span className="text-sm">
              {a.name}{" "}
              <span className="text-xs text-muted">
                · +{a.durationMin} min{a.price !== null ? ` · +$${a.price}` : ""} ·{" "}
                {serviceName(a.serviceId)}
              </span>
            </span>
            <button
              onClick={() => remove(a.id)}
              className="text-xs text-danger-soft hover:underline"
            >
              Remove
            </button>
          </li>
        ))}
        {initial.filter((a) => a.active).length === 0 && (
          <li className="text-sm text-muted">No add-ons yet.</li>
        )}
      </ul>
    </Card>
  );
}

//  Hours (weekly availability per staff)

// A recurring weekly break within a weekday (HH:MM strings for the pickers).
type HourBreak = { start: string; end: string; reason: string };
type HourRow = { on: boolean; start: string; end: string; breaks: HourBreak[] };

const timeSelectCls =
  "rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm text-offwhite disabled:opacity-40";

function HoursTab({ staff, toast }: { staff: StaffRow[]; toast: Toast }) {
  const activeStaff = staff.filter((s) => s.active);
  const [selected, setSelected] = useState<string>(activeStaff[0]?.id ?? "");
  // Per-weekday on/off + start/end + recurring breaks. Loaded when a staff is picked.
  const [rows, setRows] = useState<HourRow[]>(() =>
    WEEKDAYS.map(() => ({ on: false, start: "09:00", end: "17:00", breaks: [] })),
  );
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();

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

  function load(id: string) {
    setSelected(id);
    setLoaded(false);
    start(async () => {
      const r = await getAvailabilityAction(id);
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
      setLoaded(true);
    });
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
    start(async () => {
      const r = await saveAvailabilityAction(selected, rules, recurringBlocks);
      toast(r.ok ? "Hours saved" : "Couldn't save", r.ok ? "success" : "error");
    });
  }

  if (activeStaff.length === 0) {
    return (
      <Card className="p-5 text-sm text-muted">Add a staff member first to set hours.</Card>
    );
  }

  return (
    <Card className="p-5">
      <CardHeader
        title="Weekly hours"
        subtitle="When each staff member is available to book — and any recurring breaks."
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {activeStaff.map((s) => (
          <button
            key={s.id}
            onClick={() => load(s.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              selected === s.id
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-subtle text-muted",
            )}
          >
            {s.name}
          </button>
        ))}
      </div>

      {!loaded ? (
        <p className="mt-4 text-sm text-muted">Pick a staff member to edit their hours.</p>
      ) : (
        <>
          <div className="mt-4 flex flex-col gap-3">
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
          <button
            onClick={save}
            disabled={pending}
            className="mt-5 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save hours"}
          </button>
        </>
      )}
    </Card>
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

// Per-service available-hours rows: one optional window per weekday. `restricted`
// off = the weekday is left out of the payload entirely (unrestricted).
type ServiceHoursRow = { restricted: boolean; start: string; end: string };

/**
 * {weekday: [{s,e}]} from the hours rows. A restricted weekday with a valid
 * window emits it; a restricted weekday with an invalid/empty window emits []
 * (closed that day). Unrestricted weekdays are omitted so they stay "available
 * whenever the barber works". The full map is sent (including {} to clear).
 */
function buildHoursWindows(
  rows: ServiceHoursRow[],
): Record<string, { s: number; e: number }[]> {
  const out: Record<string, { s: number; e: number }[]> = {};
  rows.forEach((r, wd) => {
    if (!r.restricted) return; // absent = unrestricted
    const s = hhmmToMin(r.start);
    const e = hhmmToMin(r.end);
    out[String(wd)] = e > s ? [{ s, e }] : []; // empty = closed that weekday
  });
  return out;
}

/** Seed the edit form's hours rows from a service's stored hoursWindows map. */
function hoursRowsFromWindows(
  windows: Record<string, { s: number; e: number }[]> | undefined,
): ServiceHoursRow[] {
  return WEEKDAYS.map((_, wd) => {
    const w = windows?.[String(wd)];
    if (!w) return { restricted: false, start: "10:00", end: "14:00" };
    const first = w[0];
    return {
      restricted: true,
      start: first ? minToHHMM(first.s) : "10:00",
      end: first ? minToHHMM(first.e) : "14:00",
    };
  });
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
