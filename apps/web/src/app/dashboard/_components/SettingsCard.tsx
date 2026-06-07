"use client";

import { useFormState, useFormStatus } from "react-dom";
import { Card } from "@/components/ui/Card";
import { saveSettingsAction } from "../actions";

export interface ShopSettings {
  rewardThreshold: number;
  rewardLabel: string;
  nudgeBufferDays: number;
  dailySendCap: number;
}

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite outline-none focus:border-gold/50";

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
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-lg">Settings</h2>
      <form action={action} className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <label className="text-xs text-muted">
            Cuts per reward
            <input
              name="rewardThreshold"
              type="number"
              min={1}
              defaultValue={settings.rewardThreshold}
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="text-xs text-muted">
            Reward label
            <input
              name="rewardLabel"
              defaultValue={settings.rewardLabel}
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="text-xs text-muted">
            Buffer days
            <input
              name="nudgeBufferDays"
              type="number"
              min={0}
              defaultValue={settings.nudgeBufferDays}
              className={`mt-1 ${field}`}
            />
          </label>
          <label className="text-xs text-muted">
            Daily send cap
            <input
              name="dailySendCap"
              type="number"
              min={1}
              defaultValue={settings.dailySendCap}
              className={`mt-1 ${field}`}
            />
          </label>
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
