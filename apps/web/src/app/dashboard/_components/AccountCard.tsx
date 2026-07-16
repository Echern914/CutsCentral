"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import {
  changePasswordAction,
  deleteAccountAction,
  deleteShopAction,
  updateNameAction,
} from "../actions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";
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
  hasPassword,
}: {
  name: string;
  email: string;
  shopName: string;
  /** False for social-only (Apple/Google) accounts: no current password to ask for. */
  hasPassword: boolean;
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
  // Which danger-zone confirmation is open: the shop delete (type the shop
  // name) or the account delete (type the account email). Never both.
  const [confirming, setConfirming] = useState<"shop" | "account" | null>(null);
  const [delState, delAction] = useFormState(deleteShopAction, {});
  const [delAcctState, delAcctAction] = useFormState(deleteAccountAction, {});

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-lg">Account</h2>

      {/* Name */}
      <form action={nameAction} className="mb-5 flex flex-col gap-2">
        <label className={labelCls}>
          Your name
          <input name="name" defaultValue={name} className={`mt-1 ${field}`} />
        </label>
        <p className="text-xs text-muted">Signed in as {email}</p>
        <div><Btn label="Save name" /></div>
        {nameState.ok ? null : null}
      </form>

      {/* Password. A social-only (Apple/Google) account has no password yet, so
          asking for a "current password" would be a dead end - offer to SET one
          instead (the API skips the current-password check when none exists). */}
      <form action={pwAction} className="mb-6 flex flex-col gap-2 border-t border-subtle pt-5">
        <p className="text-sm font-medium text-offwhite">
          {hasPassword ? "Change password" : "Set a password"}
        </p>
        {hasPassword ? (
          <input name="currentPassword" type="password" placeholder="Current password" className={field} />
        ) : (
          <p className="text-xs text-muted">
            You signed in with Apple or Google. Add a password to also sign in with
            your email.
          </p>
        )}
        <input name="newPassword" type="password" placeholder="New password (min 8 chars)" className={field} />
        <div><Btn label={hasPassword ? "Update password" : "Set password"} /></div>
        {pwState.error && <span className="text-xs text-danger-soft">{pwState.error}</span>}
      </form>

      {/* Replay the interactive dashboard tour (plain <a>: the full navigation
          remounts the DemoTour overlay, whose ?tour=1 bootstrap starts it). */}
      <div className="mb-6 flex items-center justify-between gap-3 border-t border-subtle pt-5">
        <div>
          <p className="text-sm font-medium text-offwhite">Dashboard tour</p>
          <p className="mt-0.5 text-xs text-muted">
            A guided walk of every page — right on your real dashboard.
          </p>
        </div>
        <a
          href="/dashboard?tour=1"
          className="shrink-0 rounded-full border border-subtle px-4 py-2 text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
        >
          Replay tour
        </a>
      </div>

      {/* Support */}
      <p className="mb-4 text-xs text-muted">
        Stuck or found a bug? Email{" "}
        <a href="mailto:support@getchairback.com" className="text-gold hover:underline">
          support@getchairback.com
        </a>{" "}
        - a human reads every message.
      </p>

      {/* Danger zone */}
      <div className="rounded-xl border border-danger-soft/30 p-4">
        <p className="text-sm font-medium text-danger-soft">Danger zone</p>
        <p className="mt-1 text-xs text-muted">
          Deleting your shop removes all clients, visits, punches, and nudges.
          Deleting your account also removes your login and every shop you own.
          Neither can be undone.
        </p>
        {confirming === null && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setConfirming("shop")}
              className="rounded-full border border-danger-soft/50 px-4 py-2 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
            >
              Delete shop
            </button>
            <button
              onClick={() => setConfirming("account")}
              className="rounded-full border border-danger-soft/50 px-4 py-2 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
            >
              Delete account
            </button>
          </div>
        )}
        {confirming === "shop" && (
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
                onClick={() => setConfirming(null)}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Cancel
              </button>
            </div>
            {delState.error && <span className="text-xs text-danger-soft">{delState.error}</span>}
          </form>
        )}
        {confirming === "account" && (
          <form action={delAcctAction} className="mt-3 flex flex-col gap-2">
            <label className={labelCls}>
              Type <span className="text-offwhite">{email}</span> to confirm
              <input name="confirm" className={`mt-1 ${field}`} autoComplete="off" />
            </label>
            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="rounded-full bg-danger-soft px-4 py-2 text-xs font-semibold text-charcoal transition-opacity duration-150 ease-out hover:opacity-90"
              >
                Permanently delete account
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded-full border border-subtle px-4 py-2 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                Cancel
              </button>
            </div>
            {delAcctState.error && (
              <span className="text-xs text-danger-soft">{delAcctState.error}</span>
            )}
          </form>
        )}
      </div>
    </Card>
  );
}
