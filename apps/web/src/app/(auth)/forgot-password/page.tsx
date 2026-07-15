import Link from "next/link";
import { apiPublicGet } from "@/lib/api";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "Forgot password" };

export default async function ForgotPasswordPage() {
  // Same capability discovery as the login page: while email isn't configured
  // the login form hides its link, but this URL is still typeable - so render
  // an honest dead-end instead of a form that silently does nothing.
  const res = await apiPublicGet<{ available: boolean }>(
    "/api/auth/password-reset/available",
  );
  const available = res.data?.available ?? false;

  if (!available) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col items-center justify-center px-5 text-center">
        <h1 className="mb-2 font-display text-2xl tracking-tight">
          Password reset isn&apos;t available yet
        </h1>
        <p className="mb-6 text-sm text-muted">
          Email isn&apos;t set up on this server, so we can&apos;t send reset
          links right now.
        </p>
        <Link href="/login" className="text-sm text-gold hover:underline">
          Back to sign in
        </Link>
      </main>
    );
  }

  return <ForgotPasswordForm />;
}
