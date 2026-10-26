"use client";

import { useEffect } from "react";

/**
 * The last line before a blank page: an error in the ROOT layout itself. It
 * replaces the root layout, so it brings its own <html>/<body> and inline
 * styles - the app's stylesheet and theme may be exactly what failed. Colours
 * are fixed and readable on both a light and a dark phone.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FAF8F3",
          color: "#1C1917",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "0 20px",
          textAlign: "center",
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>This page didn&apos;t load</h1>
          <p style={{ fontSize: 14, margin: "0 0 20px", color: "#57534E" }}>It&apos;s usually a hiccup. Reloading fixes it.</p>
          <button
            type="button"
            data-qa="global-error-reload"
            onClick={() => window.location.reload()}
            style={{
              minHeight: 44,
              padding: "10px 24px",
              borderRadius: 999,
              border: "none",
              background: "#B8913A",
              color: "#1C1917",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
