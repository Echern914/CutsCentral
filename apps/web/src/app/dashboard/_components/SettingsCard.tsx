"use client";

import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Card } from "@/components/ui/Card";
import { saveSettingsAction, smsPreviewAction } from "../actions";

export interface ShopSettings {
  name: string;
  bookingUrl: string;
  nudgeBufferDays: number;
  dailySendCap: number;
  rebookWindowDays: number;
  smsTemplate: string | null;
}

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";

function Save() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal hover:bg-gold-muted disabled:opacity-50"
    >
      {pending ? "Saving…" : "Save settings"}
    </button>
  );
}

export function SettingsCard({ settings }: { settings: ShopSettings }) {
  const [state, action] = useFormState(saveSettingsAction, {});
  const [template, setTemplate] = useState(settings.smsTemplate ?? "");
  const [preview, setPreview] = useState("");

  // Live SMS preview, debounced.
  useEffect(() => {
    const id = setTimeout(() => {
      void smsPreviewAction(template).then(setPreview);
    }, 350);
    return () => clearTimeout(id);
  }, [template]);

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-lg">Settings</h2>
      <form action={action} className="flex flex-col gap-5">
        {/* Shop */}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelCls}>
            Shop name
            <input name="name" defaultValue={settings.name} className={`mt-1 ${field}`} />
          </label>
          <label className={labelCls}>
            Acuity booking link
            <input
              name="bookingUrl"
              type="url"
              defaultValue={settings.bookingUrl}
              className={`mt-1 ${field}`}
            />
          </label>
        </div>

        {/* Nudge numbers (rewards now live in the Rewards tab) */}
        <div className="grid grid-cols-2 gap-4">
          <label className={labelCls}>
            Buffer days
            <input name="nudgeBufferDays" type="number" min={0} defaultValue={settings.nudgeBufferDays} className={`mt-1 ${field}`} />
          </label>
          <label className={labelCls}>
            Daily SMS cap
            <input name="dailySendCap" type="number" min={1} defaultValue={settings.dailySendCap} className={`mt-1 ${field}`} />
          </label>
        </div>
        <p className="-mt-2 text-xs text-muted">
          Looking for your reward setup? It moved to the{" "}
          <a href="/dashboard/rewards" className="text-gold hover:underline">
            Rewards
          </a>{" "}
          tab, where you can build a full menu.
        </p>

        {/* Rebooking window (powers the client countdown timer) */}
        <label className={labelCls}>
          Rebooking window in days. Drives the client countdown timer.
          <input
            name="rebookWindowDays"
            type="number"
            min={1}
            max={90}
            defaultValue={settings.rebookWindowDays}
            className={`mt-1 ${field} sm:max-w-[160px]`}
          />
        </label>

        {/* SMS template + live preview */}
        <div>
          <label className={labelCls}>
            Nudge message
            <span className="ml-2 text-muted/60">
              placeholders: {"{firstName} {shop} {bookingUrl} {rewardsUrl}"}
            </span>
            <textarea
              name="smsTemplate"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              rows={3}
              placeholder="Leave blank to use the default message."
              className={`mt-1 ${field} resize-none`}
            />
          </label>
          <div className="mt-2 rounded-xl border border-subtle bg-charcoal-800 p-3">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">Preview</p>
            <p className="text-sm text-offwhite">{preview || "…"}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Save />
          {state.saved && <span className="text-sm text-emerald-soft">Saved</span>}
          {state.error && <span className="text-sm text-danger-soft">{state.error}</span>}
        </div>
      </form>
    </Card>
  );
}
