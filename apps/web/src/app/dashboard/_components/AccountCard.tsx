"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { useToast } from "@/components/ui/Toast";
import { ImageField } from "../site/ImageField";
import {
  changePasswordAction,
  deleteAccountAction,
  deleteShopAction,
  requestEmailChangeAction,
  updateAvatarAction,
  updateNameAction,
} from "../actions";

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
  avatarUrl,
  shopName,
  hasPassword,
  hasGoogle,
  hasApple,
  emailChangeAvailable,
}: {
  name: string;
  email: string;
  /** "" when no profile photo is set. */
  avatarUrl: string;
  /** "" when the user owns no shop (deleted it) - hides the delete-shop form. */
  shopName: string;
  /** False for social-only (Apple/Google) accounts: no current password to ask for. */
  hasPassword: boolean;
  hasGoogle: boolean;
  hasApple: boolean;
  /** False until transactional email is configured - hides the email-change form. */
  emailChangeAvailable: boolean;
}) {
  const { toast } = useToast();
  const [, nameAction] = useFormState(
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
  const [emailState, emailAction] = useFormState(requestEmailChangeAction, {});
  // Which danger-zone confirmation is open: the shop delete (type the shop
  // name) or the account delete (type the account email). Never both.
  const [confirming, setConfirming] = useState<"shop" | "account" | null>(null);
  const [delState, delAction] = useFormState(deleteShopAction, {});
  const [delAcctState, delAcctAction] = useFormState(deleteAccountAction, {});

  // Avatar saves on change (no separate Save button - matches how the picker
  // behaves in the page editor, where changes feel immediate).
  const [avatar, setAvatar] = useState(avatarUrl);
  function onAvatarChange(url: string) {
    setAvatar(url);
    void updateAvatarAction(url).then((r) =>
      toast(
        r.ok ? (url ? "Photo saved" : "Photo removed") : r.error ?? "Error",
        r.ok ? "success" : "error",
      ),
    );
  }

  // Which sign-in methods are connected (shown as chips) + provider-accurate
  // copy for the "Set a password" state.
  const methods = [
    hasPassword && "Email & password",
    hasGoogle && "Google",
    hasApple && "Apple",
  ].filter((m): m is string => Boolean(m));
  const providerNames =
    [hasGoogle && "Google", hasApple && "Apple"].filter(Boolean).join(" and ") ||
    "Apple or Google";

  return (
    <Card className="p-5">
      <h2 className="mb-4 font-display text-lg">Account</h2>

      {/* Profile: photo + name */}
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start">
        <ImageField
          label="Profile photo"
          kind="avatar"
          aspect="square"
          value={avatar}
          onChange={onAvatarChange}
          hint="Optional. Shows next to the Account link up top."
        />
        <form action={nameAction} className="flex min-w-0 flex-1 flex-col gap-2">
          <label className={labelCls}>
            Your name
            <input name="name" defaultValue={name} className={`mt-1 ${field}`} />
          </label>
          <p className="text-xs text-muted/70">Signed in as {email}</p>
          <div><Btn label="Save name" /></div>
        </form>
      </div>

      {/* Sign-in methods */}
      <div className="mb-5 border-t border-subtle pt-5">
        <p className="text-sm font-medium text-offwhite">Sign-in methods</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {methods.map((m) => (
            <span
              key={m}
              className="rounded-full border border-subtle px-3 py-1 text-xs text-muted"
            >
              {m} ✓
            </span>
          ))}
        </div>
      </div>

      {/* Password. A social-only (Apple/Google) account has no password yet, so
          asking for a "current password" would be a dead end - offer to SET one
          instead (the API skips the current-password check when none exists). */}
      <form action={pwAction} className="mb-6 flex flex-col gap-2 border-t border-subtle pt-5">
        <p className="text-sm font-medium text-offwhite">
          {hasPassword ? "Change password" : "Set a password"}
        </p>
        {hasPassword ? (
          <input
            name="currentPassword"
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            aria-invalid={pwState.error ? true : undefined}
            aria-describedby={pwState.error ? "err-password" : undefined}
            className={field}
          />
        ) : (
          <p className="text-xs text-muted">
            You signed in with {providerNames}. Add a password to also sign in
            with your email.
          </p>
        )}
        <input
          name="newPassword"
          type="password"
          placeholder="New password (min 8 chars)"
          autoComplete="new-password"
          className={field}
        />
        <div><Btn label={hasPassword ? "Update password" : "Set password"} /></div>
        <FormError id="err-password">{pwState.error}</FormError>
      </form>

      {/* Login email. Dark until transactional email is configured: the change
          only applies after a confirmation link sent to the NEW address. */}
      {emailChangeAvailable && (
        <form action={emailAction} className="mb-6 flex flex-col gap-2 border-t border-subtle pt-5">
          <p className="text-sm font-medium text-offwhite">Change login email</p>
          {emailState.ok ? (
            <p role="status" className="text-sm text-muted">
              Check <span className="text-offwhite">{emailState.sentTo}</span> and
              click the confirmation link within 30 minutes. Once confirmed,
              you&apos;ll be signed out everywhere and sign back in with the new
              address.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted">
                Currently <span className="text-offwhite">{email}</span>. We&apos;ll
                email the new address a confirmation link — nothing changes until
                it&apos;s clicked.
              </p>
              <input
                name="newEmail"
                type="email"
                required
                placeholder="new@email.com"
                autoComplete="email"
                aria-invalid={emailState.error ? true : undefined}
                aria-describedby={emailState.error ? "err-email-change" : undefined}
                className={field}
              />
              {hasPassword && (
                <input
                  name="currentPassword"
                  type="password"
                  placeholder="Current password"
                  autoComplete="current-password"
                  className={field}
                />
              )}
              <div><Btn label="Send confirmation" /></div>
              <FormError id="err-email-change">{emailState.error}</FormError>
            </>
          )}
        </form>
      )}

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
      <div className="mb-6 flex items-center justify-between gap-3 border-t border-subtle pt-5">
        <div>
          <p className="text-sm font-medium text-offwhite">Help &amp; support</p>
          <p className="mt-0.5 text-xs text-muted">
            Stuck or found a bug? Email{" "}
            <a href="mailto:support@getchairback.com" className="text-gold hover:underline">
              support@getchairback.com
            </a>{" "}
            - a human reads every message.
          </p>
        </div>
        <a
          href="/support"
          className="shrink-0 rounded-full border border-subtle px-4 py-2 text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
        >
          Support page
        </a>
      </div>

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
            {shopName && (
              <button
                onClick={() => setConfirming("shop")}
                className="rounded-full border border-danger-soft/50 px-4 py-2 text-xs font-medium text-danger-soft transition-colors duration-150 ease-out hover:bg-danger-soft/10"
              >
                Delete shop
              </button>
            )}
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
              <input
                name="confirm"
                className={`mt-1 ${field}`}
                autoComplete="off"
                aria-invalid={delState.error ? true : undefined}
                aria-describedby={delState.error ? "err-del-shop" : undefined}
              />
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
            <FormError id="err-del-shop">{delState.error}</FormError>
          </form>
        )}
        {confirming === "account" && (
          <form action={delAcctAction} className="mt-3 flex flex-col gap-2">
            <label className={labelCls}>
              Type <span className="text-offwhite">{email}</span> to confirm
              <input
                name="confirm"
                className={`mt-1 ${field}`}
                autoComplete="off"
                aria-invalid={delAcctState.error ? true : undefined}
                aria-describedby={delAcctState.error ? "err-del-account" : undefined}
              />
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
            <FormError id="err-del-account">{delAcctState.error}</FormError>
          </form>
        )}
      </div>
    </Card>
  );
}
