"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { APP_NAME } from "@chairback/config/constants";
import { motion } from "framer-motion";
import { fadeUp } from "@/components/motion/variants";
import { Card } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { forgotPasswordAction } from "../passwordResetActions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-full bg-gold-gradient px-5 py-3 text-sm font-semibold text-charcoal shadow-glow transition-all duration-200 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
    >
      {pending ? "Please wait…" : "Send reset link"}
    </button>
  );
}

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-4 py-3 text-sm text-offwhite placeholder:text-muted focus:border-gold/50";

export function ForgotPasswordForm() {
  const [state, formAction] = useFormState(forgotPasswordAction, {});

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
          Forgot your password?
        </h1>
        <p className="mb-6 text-center text-sm text-muted">
          Enter your email and we&apos;ll send you a reset link.
        </p>
        <Card className="p-6">
          {state.ok ? (
            // Generic on purpose (mirrors the API): the success card reads the
            // same whether or not an account exists for that email.
            <div role="status" className="text-center">
              <p className="mb-2 text-sm font-semibold text-offwhite">Check your inbox</p>
              <p className="text-sm leading-relaxed text-muted">
                If an account exists for that email, a reset link is on its way.
                It expires in 30 minutes.
              </p>
            </div>
          ) : (
            <form action={formAction} className="flex flex-col gap-3">
              <input
                name="email"
                type="email"
                placeholder="Email"
                aria-label="Email"
                required
                autoComplete="email"
                aria-invalid={state.error ? true : undefined}
                aria-describedby={state.error ? "forgot-error" : undefined}
                className={field}
              />
              <FormError id="forgot-error" className="text-sm">
                {state.error}
              </FormError>
              <div className="mt-1">
                <SubmitButton />
              </div>
            </form>
          )}
        </Card>
        <p className="mt-5 text-center text-sm text-muted">
          Remembered it?{" "}
          <Link href="/login" className="text-gold hover:underline">
            Back to sign in
          </Link>
        </p>
      </motion.div>
    </main>
  );
}
