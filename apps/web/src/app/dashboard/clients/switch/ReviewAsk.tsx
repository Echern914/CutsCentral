"use client";

import { useEffect, useRef, useState } from "react";
import { useVocab } from "@/components/VocabProvider";
import { copyText } from "@/lib/contactUri";

/**
 * The "ask your regulars for a review" message, ready to copy into the
 * barber's own texts or an Instagram post. ChairBack sends nothing here: the
 * barber sends it, from their own phone, to people they choose.
 *
 * Reviews can't come across from Booksy or TheCut (neither lets them be
 * exported, and copying them in by hand would put words on the page nobody
 * can check), so asking again is the honest way to rebuild them.
 */
export function ReviewAsk({
  appBase,
  slug,
  shopName,
}: {
  /** APP_BASE_URL. Empty when unset - the browser's origin fills in. */
  appBase: string;
  slug: string;
  shopName: string;
}) {
  const vocab = useVocab();
  // A link pasted into someone else's texts MUST be absolute. With no
  // APP_BASE_URL the server would render a path, so use the origin we are
  // served from - read after mount, so the first paint matches the server's.
  const [origin, setOrigin] = useState(appBase.replace(/\/+$/, ""));
  useEffect(() => {
    if (!appBase) setOrigin(window.location.origin);
  }, [appBase]);
  const reviewUrl = `${origin}/s/${slug}#reviews`;

  const written =
    `Hi! It's ${shopName}. I've moved my bookings to a new page, and reviews there help new ${vocab.clientNounPlural} find me. ` +
    `If you've been happy with your ${vocab.serviceNounPlural}, would you leave me a quick review? It takes a minute: ${reviewUrl}`;
  // Editable: it goes out in the barber's own voice. Re-seeded only until
  // they type, so the origin arriving after mount still lands in the link.
  const [message, setMessage] = useState(written);
  const edited = useRef(false);
  useEffect(() => {
    if (!edited.current) setMessage(written);
  }, [written]);

  const box = useRef<HTMLTextAreaElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  async function copy() {
    const ok = await copyText(message);
    if (ok) {
      setCopyState("copied");
      return;
    }
    // Copying is refused in some browsers and in-app views. Select the words
    // so a long-press or Ctrl+C still takes them.
    setCopyState("failed");
    box.current?.focus();
    box.current?.select();
  }

  async function share() {
    try {
      await navigator.share({ text: message });
    } catch (err) {
      // A closed share sheet is changing their mind, not a failure.
      if (err instanceof DOMException && err.name === "AbortError") return;
      await copy();
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor="review-ask" className="text-xs font-medium text-offwhite">
        Your message
      </label>
      <textarea
        id="review-ask"
        ref={box}
        rows={5}
        value={message}
        onChange={(e) => {
          edited.current = true;
          setMessage(e.target.value);
          setCopyState("idle");
        }}
        className="w-full min-w-0 rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm leading-relaxed text-offwhite outline-none focus:border-gold/50"
      />
      <p className="min-w-0 break-all text-[11px] text-muted">
        Review link: <span className="text-offwhite">{reviewUrl}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="rounded-full bg-gold px-5 py-2 text-sm font-semibold text-charcoal transition-colors duration-200 ease-out hover:bg-gold-muted"
        >
          {copyState === "copied" ? "Copied ✓" : "Copy message"}
        </button>
        {canShare && (
          <button
            type="button"
            onClick={share}
            className="rounded-full border border-subtle px-4 py-2 text-sm text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
          >
            Share
          </button>
        )}
      </div>
      {copyState === "failed" && (
        <p role="status" className="text-xs text-muted">
          Couldn&apos;t copy automatically. The message is selected in the box above, so copy it from there.
        </p>
      )}
    </div>
  );
}
