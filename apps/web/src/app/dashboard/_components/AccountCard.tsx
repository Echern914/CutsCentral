"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import {
  changePasswordAction,
  deleteShopAction,
  updateNameAction,
} from "../actions";
import { OPEN_TOUR_EVENT } from "./WelcomeTour";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";
const labelCls = "text-xs text-muted";

function Btn({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted disabled:opacity-50"
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

export function AccountCard({
  name,
  email,
  shopName,
}: {
  name: string;
  email: string;
  shopName: string;
}) {
  const { toast } = useToast();
  const [nameState, nameAction] = useFormState(
    async (p: { ok?: boolean; error?: string }, fd: FormData) => {
      const r = await updateNameAction(p, fd);
      toast(r.ok ? "Name updated" : r.error ?? "Error", r.ok ? "success" : "error");
      return r;
    },
    {},
  );
  const [pwState, pwAction] = useFormState(
    async (p: { ok?: boolean; error?: string }, fd: FormData) => {
      const r = await changePasswordAction(p, fd);
      toast(r.ok ? "Password changed" : r.error ?? "Error", r.ok ? "success" : "error");
      return r;
    },
    {},
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [delState, delAction] = useFormState(deleteShopAction, {});

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-lg">Account</h2>

      {/* Name */}
      <form action={nameAction} className="mb-5 flex flex-col gap-2">
        <label className={labelCls}>
          Your name
          <input name="name" defaultValue={name} className={`mt-1 ${field}`} />
        </label>
        <p className="text-xs text-muted/70">Signed in as {email}</p>
        <div><Btn label="Save name" /></div>
        {nameState.ok ? null : null}
      </form>

      {/* Password */}
      <form action={pwAction} className="mb-6 flex flex-col gap-2 border-t border-subtle pt-5">
        <p className="text-sm font-medium text-offwhite">Change password</p>
        <input name="currentPassword" type="password" placeholder="Current password" className={field} />
        <input name="newPassword" type="password" placeholder="New password (min 8 chars)" className={field} />
        <div><Btn label="Update password" /></div>
        {pwState.error && <span className="text-xs text-danger-soft">{pwState.error}</span>}
      </form>

      {/* Replay the first-run welcome tour */}
      <div className="mb-6 flex items-center justify-between gap-3 border-t border-subtle pt-5">
        <div>
          <p className="text-sm font-medium text-offwhite">Welcome tour</p>
          <p className="mt-0.5 text-xs text-muted">
            A quick refresher on what ChairBack does and how to use it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_TOUR_EVENT))}
          className="shrink-0 rounded-full border border-subtle px-4 py-2 text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
        >
          Replay tour
        </button>
      </div>

      {/* Danger zone */}
      <div className="rounded-xl border border-danger-soft/30 p-4">
        <p className="text-sm font-medium text-danger-soft">Danger zone</p>
        <p className="mt-1 text-xs text-muted">
          Deleting your shop removes all clients, visits, punches, and nudges. This
          cannot be undone.
        </p>
        {!confirmOpen ? (
          <button
            onClick={() => setConfirmOpen(true)}
            className="mt-3 rounded-full border border-danger-soft/50 px-4 py-2 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
          >
            Delete shop
          </button>
        ) : (
          <form action={delAction} className="mt-3 flex flex-col gap-2">
            <label className={labelCls}>
              Type <span className="text-offwhite">{shopName}</span> to confirm
              <input name="confirm" className={`mt-1 ${field}`} autoComplete="off" />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="rounded-full bg-danger-soft px-4 py-2 text-xs font-semibold text-charcoal transition-opacity duration-150 ease-out hover:opacity-90"
              >
                Permanently delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Cancel
              </button>
            </div>
            {delState.error && <span className="text-xs text-danger-soft">{delState.error}</span>}
          </form>
        )}
      </div>
    </Card>
  );
}
