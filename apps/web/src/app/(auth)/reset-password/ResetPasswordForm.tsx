"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { APP_NAME } from "@chairback/config/constants";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { useIsNativeApp } from "@/lib/useIsNativeApp";
import { resetPasswordAction } from "../passwordResetActions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
    >
      {pending ? "Please wait…" : "Set new password"}
    </button>
  );
}

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction] = useFormState(resetPasswordAction, {});
  // In-app the wordmark must not lead to the marketing site (3.1.1).
  const inApp = useIsNativeApp();

  return (
    <main className="relative mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      <div
        className="absolute left-1/2 top-1/3 -z-10 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold/10 blur-3xl"
        aria-hidden
      />
      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <p className="mb-4 text-center text-xs uppercase tracking-[0.25em] text-gold">
          {inApp ? (
            <span>{APP_NAME}</span>
          ) : (
            <Link href="/" className="transition-opacity duration-200 ease-out hover:opacity-80">
              {APP_NAME}
            </Link>
          )}
        </p>
        <h1 className="mb-1 text-center font-display text-3xl tracking-tight">
          Set a new password
        </h1>
        <p className="mb-6 text-center text-sm text-muted">
          Pick a new password for your account.
        </p>
        <Card className="p-6">
          {state.ok ? (
            <div role="status" className="text-center">
              <p className="mb-2 text-sm font-semibold text-offwhite">Password updated</p>
              <p className="mb-4 text-sm leading-relaxed text-muted">
                You&apos;ve been signed out everywhere. Sign in with your new
                password to get back to your dashboard.
              </p>
              <Link
                href="/login"
                className="inline-block rounded-full bg-gold-gradient px-6 py-2.5 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105"
              >
                Sign in
              </Link>
            </div>
          ) : (
            <form action={formAction} className="flex flex-col gap-3">
              {/* The token rides the form, not component state, so the server
                  action gets it even with JS-light progressive submission. */}
              <input type="hidden" name="token" value={token} />
              <input
                name="newPassword"
                type="password"
                placeholder="New password (8+ characters)"
                aria-label="New password"
                required
                minLength={8}
                autoComplete="new-password"
                aria-invalid={state.error ? true : undefined}
                aria-describedby={state.error ? "reset-error" : undefined}
                className={field}
              />
              <FormError id="reset-error" className="text-sm">
                {state.error}
              </FormError>
              <div className="mt-1">
                <SubmitButton />
              </div>
            </form>
          )}
        </Card>
        {!state.ok && (
          <p className="mt-5 text-center text-sm text-muted">
            Link expired?{" "}
            <Link href="/forgot-password" className="text-gold hover:underline">
              Request a new one
            </Link>
          </p>
        )}
      </motion.div>
    </main>
  );
}
