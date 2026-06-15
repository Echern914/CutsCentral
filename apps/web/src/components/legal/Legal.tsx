import Link from "next/link";
import type { ReactNode } from "react";
import { APP_NAME } from "@chairback/config/constants";

/**
 * Shared scaffolding for the public legal pages (/terms, /privacy, /sms).
 * Server components - plain prose on the site's dark theme, no client JS.
 */

export const LEGAL_ENTITY = "ChairBack, a product of Eric Supply LLC"; // Eric Supply LLC is the legal counterparty; ChairBack is its product/brand
export const SUPPORT_EMAIL = "support@getchairback.com";
export const LEGAL_EFFECTIVE_DATE = "June 12, 2026";

export function LegalShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-14">
      <p className="mb-6 text-xs uppercase tracking-[0.25em] text-gold">
        <Link href="/" className="transition-opacity duration-200 ease-out hover:opacity-80">
          {APP_NAME}
        </Link>
      </p>
      <h1 className="font-display text-4xl tracking-tight text-offwhite">{title}</h1>
      <p className="mt-2 text-sm text-muted">Effective date: {LEGAL_EFFECTIVE_DATE}</p>
      {intro && <div className="mt-6">{intro}</div>}
      <div className="mt-8 flex flex-col gap-2">{children}</div>
      <footer className="mt-14 border-t border-subtle pt-6 text-xs text-muted">
        <div className="flex flex-wrap gap-5">
          <Link href="/terms" className="transition-colors duration-200 ease-out hover:text-offwhite">
            Terms of Service
          </Link>
          <Link href="/privacy" className="transition-colors duration-200 ease-out hover:text-offwhite">
            Privacy Policy
          </Link>
          <Link href="/sms" className="transition-colors duration-200 ease-out hover:text-offwhite">
            SMS Policy
          </Link>
        </div>
      </footer>
    </main>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-8 font-display text-2xl tracking-tight text-offwhite">{children}</h2>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-5 text-base font-semibold text-offwhite">{children}</h3>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm leading-relaxed text-muted">{children}</p>;
}

export function UL({ children }: { children: ReactNode }) {
  return (
    <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted">
      {children}
    </ul>
  );
}

export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-offwhite">{children}</strong>;
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http") || href.startsWith("mailto:");
  if (external) {
    return (
      <a href={href} className="text-gold hover:underline">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className="text-gold hover:underline">
      {children}
    </Link>
  );
}

/** Callout used for the all-caps / load-bearing clauses so they stand out. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-xl border border-subtle bg-charcoal-700 p-4 text-sm leading-relaxed text-offwhite/90">
      {children}
    </div>
  );
}
