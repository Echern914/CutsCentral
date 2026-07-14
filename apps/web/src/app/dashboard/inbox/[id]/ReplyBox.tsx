"use client";

import { useState, useTransition } from "react";
import { sendReplyAction } from "./actions";

const ERROR_COPY: Record<string, string> = {
  no_client: "No client on file for this number — add them first, then reply.",
  send_failed_or_opted_out:
    "Couldn't send — this number may have texted STOP (opted out).",
  invalid_input: "Type a message first.",
};

/**
 * Barber's manual-reply box. Sending takes over the thread (the AI goes silent)
 * and the text goes out from the shop's own number. On success the page
 * revalidates and the message appears in the transcript.
 */
export function ReplyBox({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setError(null);
    startTransition(async () => {
      const r = await sendReplyAction(conversationId, body);
      if (r.ok) {
        setText("");
      } else {
        setError(ERROR_COPY[r.error ?? ""] ?? "Couldn't send. Try again.");
      }
    });
  };

  return (
    <div className="rounded-2xl border border-subtle bg-charcoal-800 p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter makes a newline.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        maxLength={1000}
        placeholder="Type a reply — sends from your shop's number and takes over from the AI"
        className="w-full resize-none bg-transparent px-1 text-sm text-offwhite outline-none placeholder:text-muted/60"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted/70">
          {error ? (
            <span className="text-danger-soft">{error}</span>
          ) : (
            "Replying pauses the AI on this thread."
          )}
        </p>
        <button
          type="button"
          disabled={pending || text.trim().length === 0}
          onClick={send}
          className="rounded-full bg-gold-gradient px-5 py-2 text-sm font-semibold text-charcoal shadow-glow transition-all duration-150 ease-out hover:shadow-glow-lg hover:brightness-105 disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
