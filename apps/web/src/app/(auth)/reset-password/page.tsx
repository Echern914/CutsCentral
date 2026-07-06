import Link from "next/link";
import { ResetPasswordForm } from "./ResetPasswordForm";

export default function ResetPasswordPage({
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
          This reset link isn&apos;t complete
        </h1>
        <p className="mb-6 text-sm text-muted">
          The link is missing its reset code. Open the link from your email
          again, or request a new one.
        </p>
        <Link href="/forgot-password" className="text-sm text-gold hover:underline">
          Request a new link
        </Link>
      </main>
    );
  }

  return <ResetPasswordForm token={token} />;
}
