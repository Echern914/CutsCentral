"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TermsAgreement } from "@/components/legal/TermsAgreement";
import {
  confirmAction,
  sendTurnAction,
  signOutAction,
  startSignInAction,
  verifySignInAction,
  type Choice,
  type Nav,
  type TurnReply,
} from "./actions";

// The five things a customer can do here. Each is a guided flow of buttons;
// typing is a shortcut into the same flows, never a different path.
const MENU: Array<{ nav: Nav; label: string }> = [
  { nav: "book", label: "Book" },
  { nav: "appointments", label: "My appointments" },
  { nav: "move", label: "Reschedule" },
  { nav: "cancel", label: "Cancel" },
  { nav: "ask", label: "Ask the shop" },
];

/**
 * The booking chat. Every sentence it shows from the shop's side was written
 * by ChairBack's server from live data - there is no model. Nothing changes
 * until the person taps Confirm on a preview that names the shop, service,
 * barber, day, time, zone and price, and the result shown is what the server
 * reports back - never assumed from the tap.
 */

type Line =
  | { who: "me"; text: string }
  | { who: "them"; text: string; choices?: Choice[]; link?: { label: string; url: string } }
  | { who: "confirm"; token: string; summary: string; state: "open" | "sending" | "done" | "replaced" | "no_answer" };

export function AssistantChat({ slug, shopName, signedIn }: { slug: string; shopName: string; signedIn: boolean }) {
  const [signed, setSigned] = useState(signedIn);
  // The session ended mid-chat: say so on the sign-in screen, instead of the
  // person's message silently vanishing (the WebKit journey showed exactly that).
  const [lost, setLost] = useState(false);
  const [lines, setLines] = useState<Line[]>([
    { who: "them", text: `Hi! Pick what you'd like to do at ${shopName} below, or type it.` },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const recent = useRef<string[]>([]);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  function show(reply: TurnReply) {
    // A preview is shown ONCE, as the confirm card - not again as a message
    // (the browser journey caught it printed twice). Any extra words around it
    // ("your hold ran out...") still show as a message.
    const sameAsCard = reply.confirm && reply.text.trim() === reply.confirm.summary.trim();
    setLines((l) => [
      ...l,
      ...(sameAsCard ? [] : [{ who: "them" as const, text: reply.text, choices: reply.choices, link: reply.link }]),
      ...(reply.confirm ? [{ who: "confirm" as const, token: reply.confirm.token, summary: reply.confirm.summary, state: "open" as const }] : []),
    ]);
  }

  async function run(input: { text: string; recent: string[] } | { pick: string } | { nav: Nav }, echo: string) {
    // One request at a time: a double tap must never send twice.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    // Any new request retires an open preview ON THE SERVER (its Confirm is
    // refused from here on), so the card stops offering it.
    setLines((l) => [...l.map((x) => (x.who === "confirm" && x.state === "open" ? { ...x, state: "replaced" as const } : x)), { who: "me", text: echo }]);
    try {
      // A dropped connection throws; it reads as "couldn't reach", never a hang.
      const r = await sendTurnAction(slug, input).catch(() => ({ ok: false as const, signedOut: false, error: "unavailable" }));
      if (!r.ok) {
        if (r.signedOut) {
          setLost(true);
          setSigned(false);
        }
        setLines((l) => [
          ...l,
          { who: "them", text: r.error === "slow_down" ? "That's a lot of messages - give it a minute." : "I couldn't reach the shop just now. Try again in a moment." },
        ]);
        return;
      }
      show(r.reply);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const prior = recent.current.slice(-3);
    recent.current = [...recent.current, text].slice(-3);
    void run({ text, recent: prior }, text);
  }

  async function confirm(index: number, token: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setLines((l) => l.map((x, i) => (i === index && x.who === "confirm" ? { ...x, state: "sending" } : x)));
    try {
      // A dropped connection THROWS rather than answering (the browser
      // journey's dropped-answer case left the card stuck on "Checking..."):
      // treat it exactly like no answer - the server may well have done it.
      const r = await confirmAction(slug, token).catch(() => ({ ok: false as const, signedOut: false, error: "no_answer" }));
      if (!r.ok) {
        if (r.signedOut) {
          setLost(true);
          setSigned(false);
        }
        // No answer is not a failure: the server may have done it. Offer to
        // ask again with the same token - which reports, or finishes once.
        setLines((l) => l.map((x, i) => (i === index && x.who === "confirm" ? { ...x, state: "no_answer" } : x)));
        return;
      }
      const reply = r.reply;
      setLines((l) => [
        ...l.map((x, i) => (i === index && x.who === "confirm" ? { ...x, state: reply.pending ? ("no_answer" as const) : ("done" as const) } : x)),
        { who: "them" as const, text: reply.text },
        ...(reply.confirm ? [{ who: "confirm" as const, token: reply.confirm.token, summary: reply.confirm.summary, state: "open" as const }] : []),
      ]);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!signed) {
    return (
      <SignIn
        shopName={shopName}
        lost={lost}
        onSignedIn={() => {
          setLost(false);
          setSigned(true);
        }}
      />
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col px-4 py-6 text-offwhite" data-qa="assistant-chat">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gold">{shopName}</p>
          <h1 className="font-display text-xl">Book with the assistant</h1>
        </div>
        <button
          type="button"
          className="text-xs text-muted transition-colors hover:text-offwhite"
          onClick={async () => {
            await signOutAction();
            setSigned(false);
          }}
        >
          Sign out
        </button>
      </header>
      <p className="mb-3 rounded-xl border border-subtle px-3 py-2 text-xs text-muted" data-qa="assistant-guided-notice">
        The buttons below do everything. Typing works for plain requests like "anything tomorrow afternoon?" or "cancel my appointment".
      </p>
      <ol className="flex flex-1 flex-col gap-3 pb-4" aria-live="polite">
        {lines.map((line, i) =>
          line.who === "me" ? (
            <li key={i} className="self-end rounded-2xl bg-charcoal-700 px-3 py-2 text-sm">
              {line.text}
            </li>
          ) : line.who === "them" ? (
            <li key={i} className="flex flex-col gap-2" data-qa="assistant-reply">
              <p className="whitespace-pre-line rounded-2xl border border-subtle px-3 py-2 text-sm">{line.text}</p>
              {line.choices && line.choices.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {line.choices.map((c) => (
                    <button
                      key={c.pick}
                      type="button"
                      disabled={busy}
                      onClick={() => void run({ pick: c.pick }, c.label)}
                      className="rounded-full border border-subtle px-3 py-1.5 text-xs transition-colors hover:border-gold/40 disabled:opacity-50"
                      data-qa="assistant-choice"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
              {line.link && (
                <a className="text-xs text-gold underline" href={line.link.url}>
                  {line.link.label}
                </a>
              )}
            </li>
          ) : (
            <li key={i} className="glass rounded-2xl p-3" data-qa="assistant-confirm" data-state={line.state}>
              <p className="text-sm font-semibold">{line.summary}</p>
              {line.state === "open" && (
                <div className="mt-3 flex gap-2">
                  <Button disabled={busy} onClick={() => void confirm(i, line.token)} data-qa="assistant-confirm-yes">
                    Confirm
                  </Button>
                  {/* Tells the server, so a held time is let go - not just hidden here. */}
                  <Button variant="ghost" disabled={busy} onClick={() => void run({ text: "never mind", recent: [] }, "Not now")} data-qa="assistant-confirm-no">
                    Not now
                  </Button>
                </div>
              )}
              {line.state === "sending" && <p className="mt-2 text-xs text-muted">Checking with the shop…</p>}
              {line.state === "replaced" && <p className="mt-2 text-xs text-muted">Replaced by your newer request. Nothing was changed by this one.</p>}
              {line.state === "no_answer" && (
                <div className="mt-2 flex items-center gap-2">
                  <p className="text-xs text-muted">No answer yet - this can't happen twice, so it's safe to check.</p>
                  <Button variant="ghost" disabled={busy} onClick={() => void confirm(i, line.token)} data-qa="assistant-check-again">
                    Check again
                  </Button>
                </div>
              )}
            </li>
          ),
        )}
        <div ref={end} />
      </ol>
      <div
        // A solid bar in the page's own colour: the journey's screenshots showed
        // a see-through one sitting over Confirm and the receipt.
        className="sticky bottom-0 -mx-4 mt-4 flex flex-col gap-2 border-t border-subtle bg-charcoal px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
      >
      <nav aria-label="What would you like to do" className="flex flex-wrap gap-2" data-qa="assistant-menu">
        {MENU.map((m) => (
          <button
            key={m.nav}
            type="button"
            disabled={busy}
            onClick={() => void run({ nav: m.nav }, m.label)}
            className="rounded-full border border-gold/40 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-gold/10 disabled:opacity-50"
            data-qa={`assistant-menu-${m.nav}`}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor="assistant-input">
          Message
        </label>
        <input
          id="assistant-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          placeholder="e.g. anything open tomorrow afternoon?"
          className="min-w-0 flex-1 rounded-full border border-subtle bg-transparent px-4 py-2.5 text-sm text-offwhite placeholder:text-muted"
          data-qa="assistant-input"
        />
        <Button type="submit" disabled={busy || !draft.trim()} data-qa="assistant-send">
          Send
        </Button>
      </form>
      </div>
    </main>
  );
}

function SignIn({ shopName, lost, onSignedIn }: { shopName: string; lost?: boolean; onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 text-offwhite" data-qa="assistant-signin">
      <p className="text-xs font-semibold uppercase tracking-wide text-gold">{shopName}</p>
      <h1 className="mb-2 font-display text-2xl">Sign in to book with the assistant</h1>
      {lost && (
        <p role="status" className="mb-3 rounded-xl border border-subtle px-3 py-2 text-sm" data-qa="assistant-session-lost">
          Your sign-in ended, so that last message wasn't sent. Sign in again and nothing you booked will be lost.
        </p>
      )}
      <p className="mb-6 text-sm text-muted">We'll email you a code. The assistant only ever sees your own appointments.</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            if (stage === "email") {
              const r = await startSignInAction(email.trim());
              if (r.ok) setStage("code");
              else setError("That email doesn't look right.");
            } else {
              const r = await verifySignInAction(email.trim(), code.trim(), agreed);
              if (r.ok) onSignedIn();
              else setError("That code didn't work. Check it and try again.");
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        {stage === "email" ? (
          <>
            <label className="block text-xs text-muted" htmlFor="assistant-email">
              Email
            </label>
            <input
              id="assistant-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-xl border border-subtle bg-transparent px-3 py-2.5 text-sm"
              data-qa="assistant-email"
            />
            {/* Signing in can create a My ChairBack account: the Terms +
                Privacy tick comes first, and travels with the code. */}
            <TermsAgreement checked={agreed} onChange={setAgreed} audience="customer" id="assistant-terms" />
          </>
        ) : (
          <>
            <label className="block text-xs text-muted" htmlFor="assistant-code">
              Code sent to {email}
            </label>
            <input
              id="assistant-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="rounded-xl border border-subtle bg-transparent px-3 py-2.5 text-sm tracking-widest"
              data-qa="assistant-code"
            />
          </>
        )}
        {error && <p className="text-xs text-danger-soft">{error}</p>}
        <Button type="submit" disabled={busy || !agreed} data-qa="assistant-signin-submit">
          {stage === "email" ? "Email me a code" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
