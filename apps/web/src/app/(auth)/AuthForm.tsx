"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { APP_NAME } from "@chairback/config/constants";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { Card } from "@/components/ui/Card";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
    >
      {pending ? "Please wait…" : label}
    </button>
  );
}

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

export function AuthForm({
  mode,
  action,
  googleAvailable,
  googleStartUrl,
  forgotPasswordAvailable = false,
  initialError,
  next,
}: {
  mode: "login" | "signup";
  action: (
    state: { error?: string },
    formData: FormData,
  ) => Promise<{ error?: string }>;
  googleAvailable: boolean;
  googleStartUrl: string;
  /**
   * Shows the "Forgot password?" link (login only). Discovered the same way as
   * googleAvailable - the API says whether email is configured - so the link
   * never dead-ends while the reset flow is dark.
   */
  forgotPasswordAvailable?: boolean;
  /** Error carried in from a redirect (e.g. a failed Google sign-in). */
  initialError?: string;
  /** Deep link to return to after login (set by the middleware redirect). */
  next?: string;
}) {
  const [state, formAction] = useFormState(action, {});
  const isSignup = mode === "signup";
  const errorText = state.error ?? initialError;

  return (
    <main className="relative mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      <div
        className="absolute left-1/2 top-1/3 -z-10 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold/10 blur-3xl"
        aria-hidden
      />
      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <p className="mb-4 text-center text-xs uppercase tracking-[0.25em] text-gold">
          <Link href="/" className="transition-opacity duration-200 ease-out hover:opacity-80">
            {APP_NAME}
          </Link>
        </p>
        <h1 className="mb-1 text-center font-display text-3xl tracking-tight">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mb-6 text-center text-sm text-muted">
          {isSignup ? "Set up your shop in minutes." : "Sign in to your dashboard."}
        </p>
        <Card className="p-6">
          {googleAvailable && (
            <>
              <a
                href={googleStartUrl}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm font-medium text-offwhite transition-colors duration-200 ease-out hover:bg-charcoal-800"
              >
                <GoogleGlyph />
                Continue with Google
              </a>
              <div className="my-4 flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-subtle" />
                or
                <span className="h-px flex-1 bg-subtle" />
              </div>
            </>
          )}
          <form action={formAction} className="flex flex-col gap-3">
            {next && <input type="hidden" name="next" value={next} />}
            {isSignup && (
              <input name="name" placeholder="Your name" required className={field} />
            )}
            <input
              name="email"
              type="email"
              placeholder="Email"
              required
              className={field}
            />
            <input
              name="password"
              type="password"
              placeholder="Password"
              required
              minLength={8}
              className={field}
            />
            {!isSignup && forgotPasswordAvailable && (
              <p className="-mt-1 text-right">
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted transition-colors duration-200 ease-out hover:text-gold"
                >
                  Forgot password?
                </Link>
              </p>
            )}
            {isSignup && (
              <label className="mt-1 flex items-start gap-2.5 text-xs leading-relaxed text-muted">
                <input
                  type="checkbox"
                  name="smsAttested"
                  required
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-subtle bg-charcoal-700 accent-gold"
                />
                <span>
                  I&apos;ll only add and text clients who agreed to receive
                  messages from my shop, and I&apos;m authorized to send on their
                  behalf.
                </span>
              </label>
            )}
            {errorText && (
              <p className="text-sm text-danger-soft">{errorText}</p>
            )}
            <div className="mt-1">
              <SubmitButton label={isSignup ? "Create account" : "Sign in"} />
            </div>
            {isSignup && (
              <p className="mt-1 text-center text-xs leading-relaxed text-muted">
                By creating an account, you agree to our{" "}
                <Link href="/terms" className="text-gold hover:underline">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link href="/privacy" className="text-gold hover:underline">
                  Privacy Policy
                </Link>
                , including the{" "}
                <Link href="/sms" className="text-gold hover:underline">
                  SMS Messaging Policy
                </Link>
                .
              </p>
            )}
          </form>
        </Card>
        <p className="mt-5 text-center text-sm text-muted">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="text-gold hover:underline">
                Sign in
              </Link>
            </>
          ) : (
            <>
              New here?{" "}
              <Link href="/signup" className="text-gold hover:underline">
                Create an account
              </Link>
            </>
          )}
        </p>
      </motion.div>
    </main>
  );
}

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
