import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";
import { apiGet } from "@/lib/api";
import { logoutAction } from "../(auth)/actions";
import { DashboardNavLinks } from "./_components/DashboardNav";
import { TrialBanner } from "./_components/TrialBanner";

/** Shared dashboard chrome: sticky glass top nav with brand, links, sign out. */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await apiGet<{ isAdmin?: boolean }>("/api/auth/me");
  const isAdmin = me.data?.isAdmin ?? false;
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 px-4">
        <nav className="glass mx-auto mt-3 flex w-full max-w-6xl items-center justify-between gap-2 rounded-full px-4 py-2.5 sm:px-5">
          <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
            <ScissorsMark />
            <span className="hidden font-display text-sm tracking-tight sm:inline">
              {APP_NAME}
            </span>
          </Link>
          <DashboardNavLinks isAdmin={isAdmin} />
          <form action={logoutAction} className="shrink-0">
            <button className="rounded-full border border-subtle px-3.5 py-1.5 text-xs text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <TrialBanner />
      {children}
    </div>
  );
}

function ScissorsMark() {
  return (
    <svg
      className="h-4 w-4 text-gold"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.12 8.12 20 20M14.47 14.48 20 4M8.12 15.88 12 12" />
    </svg>
  );
}
