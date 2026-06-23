"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import type {
  AppointmentRow,
  BookingShop,
  ServiceRow,
  StaffRow,
} from "./page";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  createServiceAction,
  createStaffAction,
  deleteServiceAction,
  deleteStaffAction,
  getAvailabilityAction,
  noShowAppointmentAction,
  saveAvailabilityAction,
  saveBookingSettingsAction,
} from "./actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";
const tabs = ["Settings", "Barbers", "Services", "Hours", "Appointments"] as const;
type Tab = (typeof tabs)[number];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function BookingManager({
  shop,
  appBase,
  initialStaff,
  initialServices,
  initialAppointments,
}: {
  shop: BookingShop;
  appBase: string;
  initialStaff: StaffRow[];
  initialServices: ServiceRow[];
  initialAppointments: AppointmentRow[];
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
            Booking is on, but you need at least one barber and one service before
            customers can book. Add them in the tabs below.
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
        <SettingsTab shop={shop} bookUrl={bookUrl} toast={toast} />
      )}
      {tab === "Barbers" && <StaffTab initial={initialStaff} toast={toast} />}
      {tab === "Services" && (
        <ServicesTab initial={initialServices} staff={initialStaff} toast={toast} />
      )}
      {tab === "Hours" && <HoursTab staff={initialStaff} toast={toast} />}
      {tab === "Appointments" && (
        <AppointmentsTab initial={initialAppointments} toast={toast} />
      )}
    </div>
  );
}

type Toast = (msg: string, kind?: "success" | "error") => void;

//  Settings

function SettingsTab({
  shop,
  bookUrl,
  toast,
}: {
  shop: BookingShop;
  bookUrl: string;
  toast: Toast;
}) {
  const [mode, setMode] = useState(shop.bookingMode);
  const [lead, setLead] = useState(shop.bookingLeadHours);
  const [maxDays, setMaxDays] = useState(shop.bookingMaxDays);
  const [buffer, setBuffer] = useState(shop.bookingBufferMin);
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const r = await saveBookingSettingsAction({
        bookingMode: mode,
        bookingLeadHours: lead,
        bookingMaxDays: maxDays,
        bookingBufferMin: buffer,
      });
      toast(r.ok ? "Booking settings saved" : "Couldn't save", r.ok ? "success" : "error");
    });
  }

  const modes: { key: typeof mode; label: string; desc: string }[] = [
    { key: "link", label: "Link out", desc: "Send customers to your own booking link." },
    { key: "acuity", label: "Acuity", desc: "Sync appointments from your Acuity account." },
    { key: "native", label: "ChairBack booking", desc: "Take bookings right here." },
  ];

  return (
    <Card className="p-5">
      <CardHeader title="How customers book" />
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {modes.map((m) => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={cn(
              "rounded-xl border p-3 text-left transition-colors",
              mode === m.key
                ? "border-gold/60 bg-gold/10"
                : "border-subtle hover:bg-charcoal-700",
            )}
          >
            <span className="block text-sm font-medium">{m.label}</span>
            <span className="mt-0.5 block text-xs text-muted">{m.desc}</span>
          </button>
        ))}
      </div>

      {mode === "native" && (
        <>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
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
            <a href={bookUrl} target="_blank" rel="noreferrer" className="text-gold underline">
              {bookUrl}
            </a>
          </p>
        </>
      )}

      <button
        onClick={save}
        disabled={pending}
        className="mt-5 rounded-xl bg-gold px-5 py-2.5 text-sm font-semibold text-charcoal-900 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </Card>
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
        toast("Barber added", "success");
        setName("");
      } else toast("Couldn't add", "error");
    });
  }
  function remove(id: string) {
    start(async () => {
      const r = await deleteStaffAction(id);
      toast(r.ok ? "Barber removed" : "Couldn't remove", r.ok ? "success" : "error");
    });
  }

  return (
    <Card className="p-5">
      <CardHeader title="Barbers" subtitle="Everyone who takes appointments." />
      <div className="mt-3 flex gap-2">
        <input
          className={field}
          placeholder="Barber name"
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
          <li className="text-sm text-muted">No barbers yet.</li>
        )}
      </ul>
    </Card>
  );
}

//  Services

function ServicesTab({
  initial,
  staff,
  toast,
}: {
  initial: ServiceRow[];
  staff: StaffRow[];
  toast: Toast;
}) {
  const [name, setName] = useState("");
  const [duration, setDuration] = useState(30);
  const [price, setPrice] = useState("");
  // Per-weekday price overrides the barber sets explicitly (weekday -> price
  // string). Empty = that day uses the base price. Built into the API payload.
  const [dayPrices, setDayPrices] = useState<Record<number, string>>({});
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

  function add() {
    if (!name.trim()) return;
    // No explicit selection -> offer it via every active barber.
    const offeredBy = staffIds.length > 0 ? staffIds : activeStaff.map((s) => s.id);
    const overrides = buildOverrides();
    start(async () => {
      const r = await createServiceAction({
        name: name.trim(),
        durationMin: duration,
        price: price.trim() ? Number(price) : null,
        priceOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
        staffIds: offeredBy,
      });
      if (r.ok) {
        toast("Service added", "success");
        setName("");
        setPrice("");
        setDayPrices({});
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
            Offered by {staffIds.length === 0 ? "(all barbers)" : ""}
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

      {/* Optional per-day pricing. Leave a day blank to use the base price; fill
          one in to charge differently (e.g. a Sunday premium). The customer sees
          the right price for the day they pick. */}
      <div className="mt-3">
        <span className={labelCls}>Different price on certain days? (optional)</span>
        <div className="mt-1 grid grid-cols-4 gap-2 sm:grid-cols-7">
          {WEEKDAYS.map((label, wd) => (
            <label key={wd} className="flex flex-col gap-1">
              <span className="text-[10px] text-muted">{label}</span>
              <input
                type="number"
                min={0}
                inputMode="decimal"
                placeholder={price.trim() ? `$${price}` : "base"}
                value={dayPrices[wd] ?? ""}
                onChange={(e) =>
                  setDayPrices((cur) => ({ ...cur, [wd]: e.target.value }))
                }
                className="w-full rounded-lg border border-subtle bg-charcoal-700 px-2 py-1 text-xs text-offwhite placeholder:text-muted/60 outline-none focus:border-gold/50"
                aria-label={`${label} price`}
              />
            </label>
          ))}
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
      <Card className="p-5 text-sm text-muted">Add a barber first to set hours.</Card>
    );
  }

  return (
    <Card className="p-5">
      <CardHeader title="Weekly hours" subtitle="When each barber is available to book." />
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
        <p className="mt-4 text-sm text-muted">Pick a barber to edit their hours.</p>
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

//  Appointments

function AppointmentsTab({
  initial,
  toast,
}: {
  initial: AppointmentRow[];
  toast: Toast;
}) {
  const [pending, start] = useTransition();
  const fmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  function act(
    id: string,
    fn: (id: string) => Promise<{ ok: boolean }>,
    label: string,
  ) {
    start(async () => {
      const r = await fn(id);
      toast(r.ok ? label : "Couldn't update", r.ok ? "success" : "error");
    });
  }

  const upcoming = initial.filter((a) => a.status === "BOOKED");

  return (
    <Card className="p-5">
      <CardHeader title="Upcoming appointments" />
      {upcoming.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No upcoming appointments.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {upcoming.map((a) => (
            <li key={a.id} className="rounded-xl border border-subtle px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">
                    {a.firstName} {a.lastName ?? ""}
                  </p>
                  <p className="text-xs text-muted">
                    {a.service.name} · {a.staff.name} · {fmt.format(new Date(a.startsAt))}
                  </p>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => act(a.id, completeAppointmentAction, "Marked done")}
                  disabled={pending}
                  className="rounded-lg border border-emerald-soft/40 px-3 py-1 text-xs text-emerald-soft disabled:opacity-50"
                >
                  Mark done
                </button>
                <button
                  onClick={() => act(a.id, noShowAppointmentAction, "Marked no-show")}
                  disabled={pending}
                  className="rounded-lg border border-subtle px-3 py-1 text-xs text-muted disabled:opacity-50"
                >
                  No-show
                </button>
                <button
                  onClick={() => act(a.id, cancelAppointmentAction, "Canceled")}
                  disabled={pending}
                  className="rounded-lg border border-danger-soft/40 px-3 py-1 text-xs text-danger-soft disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </li>
          ))}
        </ul>
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
