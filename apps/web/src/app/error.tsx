"use client";

import { useEffect } from "react";

/**
 * 🔴 NEVER A BLANK PAGE. Without this file, an error in a LAYOUT (the
 * dashboard's own header, bell, shop switcher...) had no boundary above it -
 * dashboard/error.tsx only wraps the pages inside that layout - so Next
 * replaced everything with an empty white page. In the iPhone app that reads
 * as "the app is blank" and the only way out was to force-quit.
 *
 * A full reload, not reset(): a stale tab (an old deploy's server actions, a
 * dead stream) is exactly what a fresh load fixes, and reset() re-renders the
 * same broken tree.
 */
export default function AppError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col justify-center px-5 text-center">
      <h1 className="font-display text-2xl">This page didn&apos;t load</h1>
      <p className="mt-2 text-sm text-muted">It&apos;s usually a hiccup. Reloading fixes it.</p>
      <div className="mt-6 flex justify-center">
        <button
          type="button"
          data-qa="app-error-reload"
          onClick={() => window.location.reload()}
          className="min-h-[44px] rounded-full bg-gold px-6 py-2.5 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
        >
          Reload
        </button>
      </div>
    </main>
  );
}
