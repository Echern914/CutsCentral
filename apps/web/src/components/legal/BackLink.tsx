"use client";

/**
 * "Back" for pages with no chrome of their own (the LegalShell pages), shown
 * ONLY inside the native app: the iOS WebView has no browser toolbar, so after
 * dashboard -> Help the visible way back is this (edge-swipe also works, but an
 * explicit control must exist - App Review treats gesture-only navigation as a
 * dead end). Plain history.back(): in-app these pages are only ever reached by
 * an in-webview navigation, so there is always an entry to go back to.
 */
export function BackLink() {
  return (
    <button
      type="button"
      onClick={() => history.back()}
      className="mb-5 block text-sm text-muted transition-colors duration-150 ease-out hover:text-offwhite"
    >
      ← Back
    </button>
  );
}
