"use client";

import { useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/contactUri";
import { finishSetupAction } from "../stepActions";

/**
 * Reaching the last screen finishes setup: signing in stops resuming it. Done
 * here, once, after the page is on screen - never while the page renders, so
 * a link prefetch can't finish someone's setup for them.
 */
export function FinishSetup() {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void finishSetupAction().catch(() => {
      // Harmless: the dashboard's checklist still shows what's left, and the
      // next visit here tries again.
    });
  }, []);
  return null;
}

/** The link clients book on, ready to copy and share. */
export function ShareLink({ url }: { url: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  return (
    <div className="flex w-full flex-col items-center gap-2" data-testid="share-link">
      <p className="w-full select-all break-all rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite">
        {url}
      </p>
      <button
        type="button"
        onClick={async () => setCopied((await copyText(url)) ? "yes" : "no")}
        className="text-sm text-gold underline-offset-4 hover:underline"
      >
        {copied === "yes" ? "Copied" : "Copy link"}
      </button>
      {copied === "no" && <p className="text-xs text-muted">Couldn&apos;t copy - press and hold the link to copy it.</p>}
    </div>
  );
}
