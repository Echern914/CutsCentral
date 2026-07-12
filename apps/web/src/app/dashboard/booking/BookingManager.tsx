"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
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
import {
  createAddOnAction,
  createServiceAction,
  createStaffAction,
  deleteAddOnAction,
  deleteServiceAction,
  deleteStaffAction,
  getAvailabilityAction,
  saveAvailabilityAction,
  saveBookingSettingsAction,
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

      {/* Link mode with no link = a public page with no way to book. Nudge the
          barber to add a link OR switch to ChairBack's own booking. */}
      {shop.bookingMode === "link" && !shop.bookingUrl && (
        <Card className="border-gold/30 bg-gold/5 px-5 py-4">
          <p className="text-sm text-gold">
            You haven&apos;t added a booking link yet. Paste your Acuity/Booksy/Square
            link below, or switch to <strong>Run booking on ChairBack</strong> to
            take appointments right here — otherwise customers can only request a
            time.
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
        <ServicesTab
          initial={initialServices}
          staff={initialStaff}
          initialAddOns={initialAddOns}
          toast={toast}
        />
      )}
      {tab === "Hours" && <HoursTab staff={initialStaff} toast={toast} />}
      {tab === "Appointments" && (
        <BookingCalendar
          initial={initialAgenda}
          initialWaitlist={initialWaitlist}
          isNative={shop.bookingMode === "native"}
          staff={initialStaff}
          services={initialServices}
          toast={toast}
        />
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
      slotOpened: boolean;
      requireApproval: boolean;
      remind24h: boolean;
      remind2h: boolean;
    }> = {},
  ) {
    start(async () => {
      const r = await saveBookingSettingsAction({
        bookingMode: next.mode ?? mode,
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

      {mode === "native" && (
        <Card className="p-5">
          <CardHeader title="Booking rules" subtitle="How far out and how tight customers can book." />
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className={labelCls}>Min notice (hours)</span>
              <input
                type="number"
                min={0}
                className={field}
                value={lead}
                onChange={(e) => setLead(Number(e.target.value))}
              />
            </label>
            <label className="block">
              <span className={labelCls}>Book up to (days ahead)</span>
              <input
                type="number"
                min={1}
                className={field}
                value={maxDays}
                onChange={(e) => setMaxDays(Number(e.target.value))}
              />
            </label>
            <label className="block">
              <span className={labelCls}>Buffer between (min)</span>
              <input
                type="number"
                min={0}
                className={field}
                value={buffer}
                onChange={(e) => setBuffer(Number(e.target.value))}
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
  const [pending, start] = useTransition();
  const activeStaff = staff.filter((s) => s.active);

  /** Build the {weekday: price} override map from the day inputs (valid only). */
  function buildOverrides(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [wd, val] of Object.entries(dayPrices)) {
      const n = Number(val);
      if (val.trim() !== "" && Number.isFinite(n) && n >= 0) out[wd] = n;
    }
    return out;
  }

  /** Same for {weekday: minutes} - whole minutes, 5 min floor (API bound). */
  function buildDurationOverrides(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [wd, val] of Object.entries(dayDurations)) {
      const n = Number(val);
      if (val.trim() !== "" && Number.isInteger(n) && n >= 5) out[wd] = n;
    }
    return out;
  }

  function add() {
    if (!name.trim()) return;
    // No explicit selection -> offer it via every active barber.
    const offeredBy = staffIds.length > 0 ? staffIds : activeStaff.map((s) => s.id);
    const overrides = buildOverrides();
    const durOverrides = buildDurationOverrides();
    start(async () => {
      const r = await createServiceAction({
        name: name.trim(),
        durationMin: duration,
        price: price.trim() ? Number(price) : null,
        priceOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        durationOverrides:
          Object.keys(durOverrides).length > 0 ? durOverrides : undefined,
        staffIds: offeredBy,
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
        <input
          className={field}
          type="number"
          min={5}
          placeholder="Minutes"
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
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
          "Friday cuts are 20 min"). A filled day lights up so it's obvious at a
          glance which days are customized. Duration drives the slot grid: a
          20-min Friday makes Friday book in 20-min blocks. */}
      <div className="mt-3">
        <span className={labelCls}>Vary by day? (optional — price and/or minutes)</span>
        <div className="mt-1 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {WEEKDAYS.map((label, wd) => {
            const customized =
              (dayPrices[wd] ?? "").trim() !== "" ||
              (dayDurations[wd] ?? "").trim() !== "";
            return (
              <div
                key={wd}
                className={cn(
                  "flex flex-col gap-1 rounded-lg p-1",
                  customized && "bg-gold/10 ring-1 ring-gold/40",
                )}
              >
                <span
                  className={cn(
                    "text-[10px]",
                    customized ? "font-semibold text-gold" : "text-muted",
                  )}
                >
                  {label}
                </span>
                <input
                  type="number"
                  min={0}
                  inputMode="decimal"
                  placeholder={price.trim() ? `$${price}` : "$ base"}
                  value={dayPrices[wd] ?? ""}
                  onChange={(e) =>
                    setDayPrices((cur) => ({ ...cur, [wd]: e.target.value }))
                  }
                  className="w-full rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite placeholder:text-muted/60 outline-none focus:border-gold/50"
                  aria-label={`${label} price`}
                />
                <input
                  type="number"
                  min={5}
                  inputMode="numeric"
                  placeholder={`${duration || "?"} min`}
                  value={dayDurations[wd] ?? ""}
                  onChange={(e) =>
                    setDayDurations((cur) => ({ ...cur, [wd]: e.target.value }))
                  }
                  className="w-full rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite placeholder:text-muted/60 outline-none focus:border-gold/50"
                  aria-label={`${label} minutes`}
                />
              </div>
            );
          })}
        </div>
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
            <button
              onClick={() => remove(s.id)}
              className="text-xs text-danger-soft hover:underline"
            >
              Remove
            </button>
          </li>
        ))}
        {initial.filter((s) => s.active).length === 0 && (
          <li className="text-sm text-muted">No services yet.</li>
        )}
      </ul>
      </Card>

      <AddOnsManager initial={initialAddOns} services={initial} toast={toast} />
    </div>
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
        <input
          className={field}
          type="number"
          min={0}
          placeholder="+ min"
          value={duration}
          onChange={(e) => setDuration(Number(e.target.value))}
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

function HoursTab({ staff, toast }: { staff: StaffRow[]; toast: Toast }) {
  const activeStaff = staff.filter((s) => s.active);
  const [selected, setSelected] = useState<string>(activeStaff[0]?.id ?? "");
  // Per-weekday on/off + start/end (HH:MM strings). Loaded when a staff is picked.
  const [rows, setRows] = useState<
    { on: boolean; start: string; end: string }[]
  >(() => WEEKDAYS.map(() => ({ on: false, start: "09:00", end: "17:00" })));
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();

  function load(id: string) {
    setSelected(id);
    setLoaded(false);
    start(async () => {
      const r = await getAvailabilityAction(id);
      const next = WEEKDAYS.map(() => ({ on: false, start: "09:00", end: "17:00" }));
      if (r.ok && r.data) {
        for (const rule of r.data.rules) {
          next[rule.weekday] = {
            on: true,
            start: minToHHMM(rule.startMin),
            end: minToHHMM(rule.endMin),
          };
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
      toast("End time must be after start time", "error");
      return;
    }
    start(async () => {
      const r = await saveAvailabilityAction(selected, rules);
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
      <CardHeader title="Weekly hours" subtitle="When each staff member is available to book." />
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
          <div className="mt-4 flex flex-col gap-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-3">
                <label className="flex w-20 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={r.on}
                    onChange={(e) =>
                      setRows((cur) =>
                        cur.map((c, j) => (j === i ? { ...c, on: e.target.checked } : c)),
                      )
                    }
                  />
                  {WEEKDAYS[i]}
                </label>
                <input
                  type="time"
                  disabled={!r.on}
                  value={r.start}
                  onChange={(e) =>
                    setRows((cur) =>
                      cur.map((c, j) => (j === i ? { ...c, start: e.target.value } : c)),
                    )
                  }
                  className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm disabled:opacity-40"
                />
                <span className="text-muted">–</span>
                <input
                  type="time"
                  disabled={!r.on}
                  value={r.end}
                  onChange={(e) =>
                    setRows((cur) =>
                      cur.map((c, j) => (j === i ? { ...c, end: e.target.value } : c)),
                    )
                  }
                  className="rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-sm disabled:opacity-40"
                />
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
