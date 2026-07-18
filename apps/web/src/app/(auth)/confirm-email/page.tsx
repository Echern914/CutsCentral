import Link from "next/link";
import { ConfirmEmailForm } from "./ConfirmEmailForm";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "Confirm your new email" };

export default function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams.token;

  // A missing token means a truncated/hand-typed URL - dead-end honestly
  // instead of letting the form 400 on submit.
  if (!token) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col items-center justify-center px-5 text-center">
        <h1 className="mb-2 font-display text-2xl tracking-tight">
          This confirmation link isn&apos;t complete
        </h1>
        <p className="mb-6 text-sm text-muted">
          The link is missing its confirmation code. Open the link from your
          email again, or request the change again from your account page.
        </p>
        <Link href="/login" className="text-sm text-gold hover:underline">
          Go to sign in
        </Link>
      </main>
    );
  }

  return <ConfirmEmailForm token={token} />;
}
