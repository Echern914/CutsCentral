"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { APP_NAME } from "@chairback/config/constants";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { Card } from "@/components/ui/Card";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
import { FormError } from "@/components/ui/FormError";
import { useIsNativeApp } from "@/lib/useIsNativeApp";

function SubmitButton({ label, disabled = false }: { label: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
    >
      {pending ? "Please wait…" : label}
    </button>
  );
}

/** HideInNativeApp, but only when `hide` - the login card must stay in-app. */
function HideInAppWhen({ hide, children }: { hide: boolean; children: React.ReactNode }) {
  if (!hide) return <>{children}</>;
  return <HideInNativeApp>{children}</HideInNativeApp>;
}

// Keep the global :focus-visible ring visible (WCAG 2.4.7): we no longer strip
// the outline with `outline-none`; the border tint is an extra, not the sole cue.
const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";

export function AuthForm({
  mode,
  action,
  googleAvailable,
  googleStartUrl,
  appleAvailable = false,
  appleStartUrl,
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
   * Sign in with Apple on the web. Dark until the Apple credentials are set on
   * the API, so this is false in every environment that hasn't configured them.
   */
  appleAvailable?: boolean;
  appleStartUrl?: string;
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
  // App Store Guideline 3.1.1: business registration must not exist inside the
  // iOS app shell. The shell Safari-opens document navigations to /signup, but
  // SPA navigations and older shells still render this page - so in-app the
  // signup CARD is replaced by a neutral notice (flash-proof via
  // HideInNativeApp's data-native-hide on current shells), and as a belt for
  // old shells' pre-hydration window the form's actions stay dead until we
  // KNOW we're in a browser (submit disabled + Google href withheld while the
  // in-app check is unresolved; on the web that's one frame - imperceptible).
  const inApp = useIsNativeApp();
  const signupGateUnknown = isSignup && inApp === null;

  /**
   * Carry the destination onto a provider link. Google and Apple leave our
   * origin, so unlike the password form there is no hidden field to hold it -
   * the start route parks it in a cookie for the trip. Without this an invited
   * barber who taps Google loses the invitation the password path keeps.
   */
  const withNext = (url: string): string =>
    next ? `${url}?next=${encodeURIComponent(next)}` : url;
  /** Same idea for the plain link between /login and /signup. */
  const crossLink = (path: string): string => withNext(path);

  return (
    <main className="relative mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-5">
      <div
        className="absolute left-1/2 top-1/3 -z-10 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold/10 blur-3xl"
        aria-hidden
      />
      <motion.div variants={fadeUp} initial="hidden" animate="show">
        <p className="mb-4 text-center text-xs uppercase tracking-[0.25em] text-gold">
          {/* In-app the wordmark must not lead to the marketing site (3.1.1). */}
          <HideInNativeApp>
            <Link href="/" className="transition-opacity duration-200 ease-out hover:opacity-80">
              {APP_NAME}
            </Link>
          </HideInNativeApp>
          <ShowInNativeApp>
            <span>{APP_NAME}</span>
          </ShowInNativeApp>
        </p>
        <h1 className="mb-1 text-center font-display text-3xl tracking-tight">
          {isSignup ? (
            // In-app the heading must not read as business registration (3.1.1)
            // — the neutral notice below explains sign-up lives on the web.
            <>
              <HideInNativeApp>Create your account</HideInNativeApp>
              <ShowInNativeApp>Welcome to {APP_NAME}</ShowInNativeApp>
            </>
          ) : (
            "Welcome back"
          )}
        </h1>
        <p className="mb-6 text-center text-sm text-muted">
          {isSignup ? (
            <>
              <HideInNativeApp>Set up your shop in minutes.</HideInNativeApp>
              <ShowInNativeApp>Sign in from the app with an account you already have.</ShowInNativeApp>
            </>
          ) : (
            "Sign in to your dashboard."
          )}
        </p>
        {/* In-app, /signup renders a neutral notice instead of the form: no
            account of any kind can be created inside the app (3.1.1). */}
        {isSignup && (
          <ShowInNativeApp>
            <Card className="p-6 text-center">
              <p className="text-sm text-muted">
                Creating a {APP_NAME} account isn&apos;t available in the app.
                If your shop already uses {APP_NAME}, go back and sign in with
                that account.
              </p>
            </Card>
          </ShowInNativeApp>
        )}
        <HideInAppWhen hide={isSignup}>
        <Card className="p-6">
          {/* Hidden inside the native app: barbers sign in with Google NATIVELY
              there (Google blocks OAuth in embedded WebViews), and a web page
              offering ONLY Google + our own account fails App Store Guideline
              4.8 — the native screen is where Sign in with Apple lives. */}
          {(googleAvailable || (appleAvailable && appleStartUrl)) && (
            <HideInNativeApp>
              <div className="flex flex-col gap-2.5">
                {appleAvailable && appleStartUrl && (
                  <a
                    href={signupGateUnknown ? undefined : withNext(appleStartUrl)}
                    onClick={signupGateUnknown ? (e) => e.preventDefault() : undefined}
                    className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-offwhite px-4 py-3 text-sm font-medium text-charcoal transition-opacity duration-200 ease-out hover:opacity-90"
                  >
                    <AppleGlyph />
                    Continue with Apple
                  </a>
                )}
                {googleAvailable && (
                  <a
                    href={signupGateUnknown ? undefined : withNext(googleStartUrl)}
                    onClick={signupGateUnknown ? (e) => e.preventDefault() : undefined}
                    className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm font-medium text-offwhite transition-colors duration-200 ease-out hover:bg-charcoal-800"
                  >
                    <GoogleGlyph />
                    Continue with Google
                  </a>
                )}
              </div>
              <div className="my-4 flex items-center gap-3 text-xs text-muted">
                <span className="h-px flex-1 bg-subtle" />
                or
                <span className="h-px flex-1 bg-subtle" />
              </div>
            </HideInNativeApp>
          )}
          <form action={formAction} className="flex flex-col gap-3">
            {next && <input type="hidden" name="next" value={next} />}
            {isSignup && (
              <input
                name="name"
                placeholder="Your name"
                aria-label="Your name"
                required
                autoComplete="name"
                aria-invalid={errorText ? true : undefined}
                aria-describedby={errorText ? "auth-error" : undefined}
                className={field}
              />
            )}
            <input
              name="email"
              type="email"
              placeholder="Email"
              aria-label="Email"
              required
              autoComplete="email"
              aria-invalid={errorText ? true : undefined}
              aria-describedby={errorText ? "auth-error" : undefined}
              className={field}
            />
            <input
              name="password"
              type="password"
              placeholder="Password"
              aria-label="Password"
              required
              minLength={8}
              autoComplete={isSignup ? "new-password" : "current-password"}
              aria-invalid={errorText ? true : undefined}
              aria-describedby={errorText ? "auth-error" : undefined}
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
            <FormError id="auth-error" className="text-sm">
              {errorText}
            </FormError>
            <div className="mt-1">
              <SubmitButton
                label={isSignup ? "Create account" : "Sign in"}
                disabled={signupGateUnknown}
              />
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
        </HideInAppWhen>
        <p className="mt-5 text-center text-sm text-muted">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <Link href={crossLink("/login")} className="text-gold hover:underline">
                Sign in
              </Link>
            </>
          ) : (
            // No signup steering inside the app (3.1.1) - accounts can't be
            // created there, so the invitation would only dead-end.
            <HideInNativeApp>
              New here?{" "}
              <Link href={crossLink("/signup")} className="text-gold hover:underline">
                Create an account
              </Link>
            </HideInNativeApp>
          )}
        </p>
      </motion.div>
    </main>
  );
}

/** Apple's mark, drawn rather than imported so nothing loads off-origin. */
function AppleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="currentColor">
      <path d="M11.03 8.49c-.02-1.77 1.45-2.62 1.51-2.66-.82-1.2-2.1-1.37-2.56-1.39-1.09-.11-2.13.64-2.68.64-.55 0-1.4-.63-2.31-.61-1.19.02-2.28.69-2.89 1.75-1.23 2.14-.31 5.3.88 7.03.59.85 1.28 1.8 2.2 1.76.88-.03 1.21-.57 2.28-.57s1.37.57 2.31.55c.95-.02 1.55-.86 2.13-1.71.67-.98.95-1.93.96-1.98-.02-.01-1.84-.71-1.86-2.81zM9.28 3.3c.48-.59.81-1.4.72-2.21-.7.03-1.55.47-2.05 1.05-.45.52-.84 1.35-.74 2.14.78.06 1.58-.4 2.07-.98z" />
    </svg>
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
