"use client";

import { cap, useVocab } from "@/components/VocabProvider";
import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { NumberField } from "@/components/ui/NumberField";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  forgetDeviceAction,
  saveNotifyPrefsAction,
  sendTestNotificationAction,
  signOutEverywhereAction,
} from "./actions";
import type { NotifyPrefs, NotifyDevice } from "./types";

/**
 * The barber's own notifications, and the two things that decide whether one
 * can arrive at all: which devices are registered, and a Send test button.
 *
 * Everything saves on change (no Save button): each control is one boolean or
 * one number, and a settings page that silently loses a toggle because you
 * navigated away is the failure mode this app has already been bitten by.
 */

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function fmtHour(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${h >= 12 ? "PM" : "AM"}`;
}

/** The app's on/off pill (BookingManager idiom), saving as you tap. */
function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "shrink-0 rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ease-out disabled:opacity-50",
        on
          ? "bg-emerald-soft/15 text-emerald-soft"
          : "border border-subtle text-muted hover:bg-charcoal-700",
      )}
    >
      {on ? "On" : "Off"}
    </button>
  );
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-offwhite">{title}</p>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function NotificationsCard({
  initial,
  devices: initialDevices,
  shopNotifyPhone,
}: {
  initial: NotifyPrefs;
  devices: NotifyDevice[];
  shopNotifyPhone: string | null;
}) {
  const vocab = useVocab();
  const [prefs, setPrefs] = useState<NotifyPrefs>(initial);
  const [devices, setDevices] = useState<NotifyDevice[]>(initialDevices);
  const [pending, start] = useTransition();
  const [testing, setTesting] = useState(false);
  const { toast } = useToast();

  /** Optimistic: flip locally, persist, roll back if the save fails. */
  function save(patch: Partial<NotifyPrefs>) {
    const before = prefs;
    setPrefs({ ...prefs, ...patch });
    start(async () => {
      const r = await saveNotifyPrefsAction(patch);
      if (!r.ok) {
        setPrefs(before);
        toast("Couldn't save that", "error");
      }
    });
  }

  async function sendTest() {
    setTesting(true);
    const r = await sendTestNotificationAction();
    setTesting(false);
    if (!r.ok) {
      toast("Couldn't send the test", "error");
      return;
    }
    const landed = [
      r.pushed && "push",
      r.texted && "text",
      r.emailed && "email",
    ].filter(Boolean);
    toast(
      landed.length > 0
        ? `Sent — check your ${landed.join(" and ")}.`
        : "Nothing could be delivered. Turn a channel on below, and open the app on your phone at least once so it can register.",
      landed.length > 0 ? "success" : "error",
    );
  }

  function forget(id: string) {
    const before = devices;
    setDevices(devices.filter((d) => d.id !== id));
    start(async () => {
      const r = await forgetDeviceAction(id);
      if (!r.ok) {
        setDevices(before);
        toast("Couldn't remove that device", "error");
      }
    });
  }

  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader
        title="Notifications"
        subtitle={`What you get told about your own ${vocab.stationNoun} — who's coming in, and when.`}
        action={
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testing}
            className="shrink-0 rounded-full border border-gold/50 px-3 py-1.5 text-xs text-gold transition-colors hover:bg-gold/10 disabled:opacity-50"
          >
            {testing ? "Sending…" : "Send test"}
          </button>
        }
      />

      <div className="divide-y divide-subtle px-5">
        {/* ---- What you get told about ---- */}
        <div className="py-2">
          <p className="pt-3 text-[11px] uppercase tracking-wide text-muted">
            Appointments
          </p>
          <Row
            title="Before each appointment"
            hint={`Who's next and what they booked, so you're never surprised at the ${vocab.stationNoun}.`}
          >
            <Toggle
              on={prefs.nextUpEnabled}
              onChange={(v) => save({ nextUpEnabled: v })}
              label="Next-up reminder"
              disabled={pending}
            />
          </Row>
          {prefs.nextUpEnabled && (
            <div className="flex items-center gap-2 pb-2 pl-1 text-xs text-muted">
              Remind me
              <NumberField
                value={prefs.nextUpLeadMin}
                onChange={(n) => save({ nextUpLeadMin: n })}
                min={5}
                max={120}
                step={5}
                integer
                className="w-16 rounded-lg border border-subtle bg-charcoal-800 px-2 py-1 text-right text-xs tabular-nums text-offwhite"
                aria-label="Minutes before the appointment"
              />
              minutes before it starts
            </div>
          )}
          <Row
            title="Tomorrow's schedule"
            hint={`An evening rundown: how many ${vocab.serviceNounPlural}, when they start, who's first.`}
          >
            <Toggle
              on={prefs.dayAheadEnabled}
              onChange={(v) => save({ dayAheadEnabled: v })}
              label="Day-ahead digest"
              disabled={pending}
            />
          </Row>
          {prefs.dayAheadEnabled && (
            <label className="flex items-center gap-2 pb-2 pl-1 text-xs text-muted">
              Send it at
              <select
                value={prefs.dayAheadHour}
                onChange={(e) => save({ dayAheadHour: Number(e.target.value) })}
                className="rounded-lg border border-subtle bg-charcoal-800 px-2 py-1 text-xs text-offwhite"
                aria-label="Hour to send the day-ahead digest"
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {fmtHour(h)}
                  </option>
                ))}
              </select>
              your shop&apos;s time
            </label>
          )}
          <Row title="New bookings" hint="Someone books or requests a time.">
            <Toggle
              on={prefs.newBookingEnabled}
              onChange={(v) => save({ newBookingEnabled: v })}
              label="New booking alerts"
              disabled={pending}
            />
          </Row>
          <Row title="Cancellations" hint="Someone cancels or moves their booking.">
            <Toggle
              on={prefs.cancelEnabled}
              onChange={(v) => save({ cancelEnabled: v })}
              label="Cancellation alerts"
              disabled={pending}
            />
          </Row>
        </div>

        {/* ---- How they reach you ---- */}
        <div className="py-2">
          <p className="pt-3 text-[11px] uppercase tracking-wide text-muted">
            How to reach you
          </p>
          <Row title="Push" hint="Free and instant. Needs the app on your phone.">
            <Toggle
              on={prefs.pushEnabled}
              onChange={(v) => save({ pushEnabled: v })}
              label="Push notifications"
              disabled={pending}
            />
          </Row>
          <Row
            title="Text me about bookings"
            hint="When someone books, moves or cancels. One text per event."
          >
            <Toggle
              on={prefs.smsEnabled}
              onChange={(v) => save({ smsEnabled: v })}
              label="Booking text alerts"
              disabled={pending}
            />
          </Row>
          <Row
            title="Text me my reminders"
            hint="Next-up and tomorrow's rundown by text too. That's one per appointment, so it uses real texting credits."
          >
            <Toggle
              on={prefs.smsRemindersEnabled}
              onChange={(v) => save({ smsRemindersEnabled: v })}
              label="Reminder text alerts"
              disabled={pending}
            />
          </Row>
          {(prefs.smsEnabled || prefs.smsRemindersEnabled) && (
            <label className="flex flex-wrap items-center gap-2 pb-2 pl-1 text-xs text-muted">
              Text me at
              <input
                type="tel"
                defaultValue={prefs.notifyPhone ?? ""}
                placeholder={shopNotifyPhone || "(555) 123-4567"}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (prefs.notifyPhone ?? "")) save({ notifyPhone: v });
                }}
                className="rounded-lg border border-subtle bg-charcoal-800 px-2 py-1 text-xs text-offwhite"
                aria-label="Your alert phone number"
              />
              {!prefs.notifyPhone && shopNotifyPhone && (
                <span>— blank uses the shop&apos;s number</span>
              )}
            </label>
          )}
          <Row title="Email" hint="A copy in your inbox. Good for the daily rundown.">
            <Toggle
              on={prefs.emailEnabled}
              onChange={(v) => save({ emailEnabled: v })}
              label="Email alerts"
              disabled={pending}
            />
          </Row>
        </div>

        {/* ---- Devices ---- */}
        <div className="py-3">
          <p className="text-[11px] uppercase tracking-wide text-muted">
            Your devices
          </p>
          {devices.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              No devices yet. Open ChairBack on your phone and allow
              notifications — this is where push gets delivered.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-subtle px-3 py-2"
                >
                  <span className="min-w-0 text-xs">
                    <span className="block truncate text-offwhite">{d.label}</span>
                    <span className="text-muted">
                      {d.kind === "expo" ? "Phone app" : "Browser"}
                      {d.failing && " · not delivering"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => forget(d.id)}
                    disabled={pending}
                    className="shrink-0 text-xs text-danger-soft hover:underline disabled:opacity-50"
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Advanced: the settings that are real but rarely touched. Deliberately ABOVE
 * the danger zone and in a neutral border - red should keep meaning
 * "irreversible", and none of this is.
 */
export function AdvancedCard({ timezone }: { timezone: string | null }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const { toast } = useToast();

  function signOutEverywhere() {
    start(async () => {
      const r = await signOutEverywhereAction();
      // Success ends THIS session too - the action redirects to /login.
      if (!r.ok) toast("Couldn't sign out the other devices", "error");
    });
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="mb-1 font-display text-lg">Advanced</h2>
      <p className="mb-4 text-xs text-muted">
        Rarely needed, occasionally exactly what you need.
      </p>

      <div className="flex items-center justify-between gap-4 border-t border-subtle py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-offwhite">Your data</p>
          <p className="mt-0.5 text-xs text-muted">
            Download your clients and visit history as a spreadsheet. It&apos;s
            your list — take it anywhere.
          </p>
        </div>
        <a
          href="/dashboard/export/clients"
          className="shrink-0 rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors hover:border-gold/50 hover:text-gold"
        >
          Export CSV
        </a>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-subtle py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-offwhite">Shop time zone</p>
          <p className="mt-0.5 text-xs text-muted">
            {timezone ? (
              <>
                Every booking, reminder and report is in{" "}
                <span className="text-offwhite">{timezone.replace(/_/g, " ")}</span>.
              </>
            ) : (
              "Sets the clock for bookings, reminders and reports."
            )}{" "}
            Change it under Booking → Settings.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-subtle py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-offwhite">
            Sign out everywhere
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Ends every signed-in session, on every device — including this one.
            Use it if you lost a phone or shared a login.
          </p>
        </div>
        {confirming ? (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-full border border-subtle px-3 py-2 text-xs text-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={signOutEverywhere}
              disabled={pending}
              className="rounded-full bg-gold px-4 py-2 text-xs font-semibold text-charcoal-900 disabled:opacity-50"
            >
              {pending ? "Signing out…" : "Yes, sign out"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors hover:border-gold/50 hover:text-gold"
          >
            Sign out
          </button>
        )}
      </div>
    </Card>
  );
}
