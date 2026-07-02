import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";

/** Branded 404 - the Next default is an unbranded dead-end with no way back. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-16 text-center text-offwhite">
      <p className="text-xs uppercase tracking-[0.2em] text-muted">404</p>
      <h1 className="mt-3 font-display text-3xl tracking-tight">
        That page doesn&apos;t exist
      </h1>
      <p className="mt-3 text-sm text-muted">
        The link may be old or mistyped. Head back to {APP_NAME} - or if you
        were sent here by your shop, ask them for a fresh link.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/"
          className="rounded-full bg-gold-gradient px-6 py-2.5 text-sm font-semibold text-charcoal transition-[filter] duration-150 ease-out hover:brightness-105"
        >
          Go home
        </Link>
        <Link
          href="/dashboard"
          className="rounded-full border border-subtle px-6 py-2.5 text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
        >
          My dashboard
        </Link>
      </div>
    </main>
  );
}
