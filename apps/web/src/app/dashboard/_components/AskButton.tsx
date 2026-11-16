"use client";

import { useRouter } from "next/navigation";
import { openAssistant } from "@/components/help/openAssistant";

/**
 * The top bar's way into the Assistant for a seat with no feature search (an
 * employee: every search result is a manager page that would refuse them).
 * The dashboard has no floating chat button any more, so without this an
 * employee's only route to help would be the Assistant tab.
 */
export function AskButton({ assistantHref }: { assistantHref: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={(e) => {
        // The panel when it is listening; the full Assistant page if not.
        if (!openAssistant(undefined, e.currentTarget)) router.push(assistantHref);
      }}
      aria-label="Ask a question"
      title="Ask a question"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
    >
      <svg
        className="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M20.5 12.2c0 3.9-3.8 7-8.5 7a9.8 9.8 0 0 1-2.6-.35L4.5 20.5l1.3-3.3A6.7 6.7 0 0 1 3.5 12.2c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" />
      </svg>
    </button>
  );
}
