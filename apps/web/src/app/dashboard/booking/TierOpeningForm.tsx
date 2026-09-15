"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Dialog } from "@/components/ui/Dialog";
import { chip, Field, FormFooter, Group, INPUT } from "./formkit";
import type { ServiceRow, StaffRow } from "./page";
import {
  createTierOpeningAction,
  getDashSlotsAction,
  listTierOpeningsAction,
  previewTierOpeningAction,
  releaseTierOpeningAction,
  type DashSlot,
  type TierKey,
  type TierOpeningRow,
} from "./actions";

type Toast = (msg: string, kind?: "success" | "error") => void;

/**
 * "Offer to a tier": hold an open slot for the shop's best customers first.
 *
 * The barber picks a service, a barber and one of the day's REAL open times
 * (the same slots the booking page offers), chooses who gets first pick and for
 * how long, and sees how many members would actually be told before anything
 * is held. On save the slot leaves the public booking page; the members get a
 * notification and book it in their app; when the hold runs out it is back on
 * the page for anyone. Holds already made are listed at the top, each with a
 * way to end it early.
 */

export const TIER_CHOICES: { key: TierKey; label: string; who: string }[] = [
  { key: "GOLD", label: "Gold", who: "Gold members" },
  { key: "SILVER", label: "Silver & Gold", who: "Silver and Gold members" },
  { key: "BRONZE", label: "Every tier", who: "members of every tier" },
];

export const HOLD_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hr" },
  { minutes: 120, label: "2 hr" },
  { minutes: 240, label: "4 hr" },
  { minutes: 480, label: "8 hr" },
];

/** What the API's refusal codes mean, in the barber's terms. */
export function tierOpeningError(code: string | undefined): string {
  switch (code) {
    case "rewards_off":
      return "Tiers are part of rewards - turn rewards on to hold openings for a tier.";
    case "not_native":
      return "Openings can only be held on a calendar that books through ChairBack.";
    case "requires_payment":
      return "This service takes a deposit at booking, and a held opening can't collect one. Pick another service.";
    case "too_soon":
      return "That appointment starts too soon to hold it for anyone. Pick a later time.";
    case "no_members":
      return "Nobody in that tier has the ChairBack app yet, so there's no one to tell. Try a wider tier.";
    case "slot_unavailable":
      return "That time isn't open any more. Pick another.";
    default:
      return "Couldn't hold that opening. Try again.";
  }
}

function dayKeyOf(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

export function TierOpeningForm({
  staff,
  services,
  timezone,
  dayKey,
  todayKey,
  onClose,
  onHeld,
  toast,
}: {
  staff: StaffRow[];
  services: ServiceRow[];
  timezone: string;
  /** YYYY-MM-DD, shop tz - the day on screen. */
  dayKey: string;
  todayKey: string;
  onClose: () => void;
  onHeld: () => void;
  toast: Toast;
}) {
  const activeStaff = staff.filter((s) => s.active);
  const activeServices = services.filter((s) => s.active);
  const [serviceId, setServiceId] = useState<string | null>(activeServices.length === 1 ? activeServices[0]!.id : null);
  const [staffId, setStaffId] = useState<string | null>(activeStaff.length === 1 ? activeStaff[0]!.id : null);
  const [date, setDate] = useState(dayKey < todayKey ? todayKey : dayKey);
  const [slots, setSlots] = useState<DashSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [minTier, setMinTier] = useState<TierKey>("GOLD");
  const [holdMinutes, setHoldMinutes] = useState(120);
  const [preview, setPreview] = useState<{ members: number; inApp: number } | null>(null);
  const [openings, setOpenings] = useState<TierOpeningRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }),
    [timezone],
  );
  const whenFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    [timezone],
  );

  const loadOpenings = () =>
    listTierOpeningsAction().then((res) => {
      if (res.ok && res.openings) setOpenings(res.openings.filter((o) => o.state === "held"));
    });
  useEffect(() => {
    void loadOpenings();
  }, []);

  // The day's real open times for this service and barber - what the booking
  // page itself would offer. Anything else would be refused anyway.
  useEffect(() => {
    setStartsAt(null);
    if (!serviceId || !staffId || !date) {
      setSlots([]);
      return;
    }
    setLoadingSlots(true);
    const [y, m, d] = date.split("-").map(Number);
    const anchor = Date.UTC(y!, m! - 1, d!, 12);
    const from = new Date(anchor - 36 * 3600_000).toISOString();
    const to = new Date(anchor + 36 * 3600_000).toISOString();
    let cancelled = false;
    getDashSlotsAction(staffId, serviceId, from, to).then((res) => {
      if (cancelled) return;
      setLoadingSlots(false);
      const now = Date.now();
      setSlots(
        res.ok && res.slots
          ? res.slots.filter((s) => dayKeyOf(s.startsAt, timezone) === date && new Date(s.startsAt).getTime() > now)
          : [],
      );
    });
    return () => {
      cancelled = true;
    };
  }, [serviceId, staffId, date, timezone]);

  // Who would hear about it - before anything is held.
  useEffect(() => {
    setPreview(null);
    let cancelled = false;
    previewTierOpeningAction(minTier).then((res) => {
      if (!cancelled && res.ok) setPreview({ members: res.members ?? 0, inApp: res.inApp ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [minTier]);

  const who = TIER_CHOICES.find((t) => t.key === minTier)!.who;
  const heldUntil = startsAt
    ? new Date(Math.min(Date.now() + holdMinutes * 60_000, new Date(startsAt).getTime()))
    : null;

  async function submit() {
    if (inFlight.current) return;
    setError(null);
    if (!serviceId) return setError("Pick a service.");
    if (!staffId) return setError("Pick a provider.");
    if (!startsAt) return setError("Pick one of the open times.");
    if (preview && preview.inApp === 0) return setError(tierOpeningError("no_members"));
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await createTierOpeningAction({ staffId, serviceId, startsAt, minTier, holdMinutes });
      if (!res.ok) {
        setError(tierOpeningError(res.error));
        return;
      }
      toast(
        `Held for ${who} until ${timeFmt.format(new Date(res.heldUntil!))} · ${res.recipients} ${
          res.recipients === 1 ? "person" : "people"
        } notified`,
        "success",
      );
      onHeld();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function release(id: string) {
    const res = await releaseTierOpeningAction(id);
    if (!res.ok) {
      toast("Couldn't end that hold. Try again.", "error");
      return;
    }
    toast("Hold ended - it's back on your booking page.", "success");
    void loadOpenings();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Offer to a tier"
      subtitle="Your best customers get first pick, then it's anyone's."
      titleAlign="center"
      className="sm:max-w-lg"
      footer={
        <FormFooter
          error={error}
          label="Hold & notify"
          pendingLabel="Holding…"
          pending={busy}
          disabled={!startsAt || (preview !== null && preview.inApp === 0)}
          onSubmit={() => void submit()}
        />
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        {openings.length > 0 && (
          <Group title="Held now">
            <ul className="flex min-w-0 flex-col gap-2">
              {openings.map((o) => (
                <li key={o.id} className="flex min-w-0 items-center justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="block [overflow-wrap:anywhere] text-offwhite">
                      {whenFmt.format(new Date(o.startsAt))}
                      {o.serviceName ? ` · ${o.serviceName}` : ""}
                    </span>
                    <span className="block text-xs text-muted">
                      {TIER_CHOICES.find((t) => t.key === o.minTier)?.label} until {timeFmt.format(new Date(o.heldUntil))} ·{" "}
                      {o.recipients} notified
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void release(o.id)}
                    className="flex h-11 shrink-0 items-center rounded-lg border border-subtle px-3 text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite"
                  >
                    End hold
                  </button>
                </li>
              ))}
            </ul>
          </Group>
        )}

        <Group title="Service">
          <div className="flex min-w-0 flex-col gap-1.5">
            {activeServices.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setServiceId(s.id)}
                className={cn(
                  "flex min-h-[2.75rem] w-full min-w-0 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors duration-150 ease-out",
                  serviceId === s.id ? "border-gold/50 bg-gold/10" : "border-subtle hover:bg-charcoal-700/40",
                )}
              >
                <span className="min-w-0">
                  <span className="block [overflow-wrap:anywhere] font-medium text-offwhite">{s.name}</span>
                  <span className="block text-xs text-muted">
                    {s.durationMin} min{s.price != null ? ` · $${s.price.toFixed(0)}` : ""}
                  </span>
                </span>
                {serviceId === s.id && (
                  <span aria-hidden className="shrink-0 text-gold">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </Group>

        {activeStaff.length > 1 && (
          <Group title="Provider">
            <div className="flex flex-wrap gap-1.5">
              {activeStaff.map((s) => (
                <button key={s.id} type="button" onClick={() => setStaffId(s.id)} className={chip(staffId === s.id, "px-4")}>
                  {s.name}
                </button>
              ))}
            </div>
          </Group>
        )}

        <Group title="Open time">
          <Field label="Day">
            <input type="date" className={INPUT} min={todayKey} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {!serviceId || !staffId ? (
            <p className="text-xs text-muted">Pick a service{activeStaff.length > 1 ? " and a provider" : ""} to see open times.</p>
          ) : loadingSlots ? (
            <p className="text-sm text-muted">Loading times…</p>
          ) : slots.length === 0 ? (
            <p className="text-xs text-muted">No open times that day.</p>
          ) : (
            <div className="grid min-w-0 grid-cols-3 gap-1.5">
              {slots.map((s) => (
                <button
                  key={s.startsAt}
                  type="button"
                  onClick={() => setStartsAt(s.startsAt)}
                  className={chip(startsAt === s.startsAt, "min-w-0 px-1 text-center")}
                >
                  {timeFmt.format(new Date(s.startsAt))}
                </button>
              ))}
            </div>
          )}
        </Group>

        <Group title="Who gets first pick">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Who gets first pick">
            {TIER_CHOICES.map((t) => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={minTier === t.key}
                onClick={() => setMinTier(t.key)}
                className={chip(minTier === t.key, "px-4")}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-xs leading-snug text-muted" aria-live="polite">
            {preview === null
              ? "Counting members…"
              : preview.inApp === 0
                ? `${preview.members} ${preview.members === 1 ? "member" : "members"} - none with the ChairBack app yet, so nobody could be told.`
                : `${preview.inApp} of ${preview.members} ${preview.members === 1 ? "member has" : "members have"} the app and will be notified.`}
          </p>
        </Group>

        <Group title="Hold it for">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Hold it for">
            {HOLD_CHOICES.map((h) => (
              <button
                key={h.minutes}
                type="button"
                role="radio"
                aria-checked={holdMinutes === h.minutes}
                onClick={() => setHoldMinutes(h.minutes)}
                className={chip(holdMinutes === h.minutes, "px-4")}
              >
                {h.label}
              </button>
            ))}
          </div>
          {startsAt && heldUntil && (
            <p className="text-xs leading-snug text-muted">
              {`${whenFmt.format(new Date(startsAt))} is held for ${who} until ${timeFmt.format(heldUntil)}, then it's open to anyone.`}
            </p>
          )}
        </Group>
      </div>
    </Dialog>
  );
}
