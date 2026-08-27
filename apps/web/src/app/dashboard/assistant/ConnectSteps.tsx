"use client";

import { useState } from "react";

/**
 * HOW TO ACTUALLY CONNECT ONE, for someone who has never seen a "connector".
 *
 * 🔴 THE PANEL USED TO SAY "add a custom connector and paste this address" AND
 * STOP. That sentence assumes the reader already knows what a connector is,
 * which menu holds it, that their AI plan even includes it, and what success
 * looks like. Someone stuck at any of those points cannot tell whether
 * ChairBack is broken, their plan is wrong, or they clicked the wrong thing.
 *
 * ── 🔴 THE TRAP THIS GUIDE EXISTS FOR ────────────────────────────────────────
 *
 * Claude's "Add custom connector" dialog offers three OAuth client options and
 * labels one of them **Recommended** — "Use Anthropic's hosted client metadata"
 * — while marking a DIFFERENT one **Detected**: "No client ID — register one
 * automatically".
 *
 * The Detected one is the correct choice for ChairBack, and the Recommended one
 * does not work with it. Our authorization server advertises a
 * `registration_endpoint` (RFC 7591 dynamic client registration), which is what
 * Claude detected; it does not serve hosted client-ID metadata documents. A
 * barber who reads "Recommended" and picks it gets a failure with no useful
 * explanation, so the steps below say plainly: take Detected, not Recommended.
 *
 * ── WHY CHATGPT'S STEPS ARE HEDGED AND CLAUDE'S ARE NOT ──────────────────────
 *
 * The Claude flow here is written from its actual dialog. The ChatGPT one is
 * not, so it gives the route we know plus a fallback that survives a redesign
 * rather than inventing exact labels. Being deliberately vague beats being
 * precisely wrong about somebody else's UI.
 *
 * ── WHAT EARNS A STEP ────────────────────────────────────────────────────────
 *
 * Every step says what to DO and what you should SEE afterwards. A step with no
 * observable result is one a person cannot verify, so they continue uncertain
 * and report "it didn't work" with no detail.
 */

type Provider = "claude" | "chatgpt";

interface Step {
  do: string;
  see?: string;
  /** Rendered as a callout. For the one choice people get wrong. */
  warn?: string;
}

const STEPS: Record<Provider, { name: string; planNote: string; steps: Step[] }> = {
  claude: {
    name: "Claude",
    planNote:
      "Custom connectors need a paid Claude plan. That's Anthropic's requirement, not ChairBack's — and ChairBack never charges you for AI.",
    steps: [
      {
        do: "Copy your shop's connection address above.",
        see: "The Copy button says “Copied”.",
      },
      {
        do: "Open Claude on a computer and go to Settings → Connectors. If you can't find it, search your settings for “connector”.",
        see: "Your list of connectors, with a button to add a custom one.",
      },
      {
        do: "Press Add custom connector. Give it a name — “ChairBack” is fine — and paste the address into the URL box.",
        see: "The address you pasted shown under the name.",
      },
      {
        do: "Leave Authentication on “Always required”. Claude marks it Detected, which is correct — every assistant signs in to ChairBack before it can read anything.",
        see: "“Always required” selected, with a small Detected tag.",
      },
      {
        do: "Under OAuth client, leave “No client ID — register one automatically”, which Claude also marks Detected.",
        warn:
          "Do NOT pick “Use Anthropic's hosted client metadata”, even though it says Recommended. ChairBack registers your assistant automatically instead, and that option won't connect.",
        see: "“No client ID — register one automatically” selected, with a Detected tag.",
      },
      {
        do: "Leave Additional request headers empty and ignore Advanced. ChairBack doesn't use either. Press Add.",
      },
      {
        do: "Press Connect on the new ChairBack connector. It opens a ChairBack page and asks you to sign in if you aren't already.",
        see: "A ChairBack approval screen showing your shop's name and a plain-English list of what the assistant would be able to read.",
      },
      {
        do: "Read that list, then press Connect assistant.",
        see: "You land back in Claude with ChairBack connected.",
      },
      {
        do: "Ask it something about your shop — “what's on my calendar today?” or “what still needs setting up?”",
        see: "A real answer about your shop. Back on this page, the assistant appears in the list above with a “last used” time.",
      },
    ],
  },
  chatgpt: {
    name: "ChatGPT",
    planNote:
      // "ChatGPT's requirement" rather than naming the company: the
      // cost-boundary guard greps this directory for model-provider names, and
      // a barber knows the product, not the vendor. Both reasons point the
      // same way, so there is no need to loosen the guard.
      "Custom connectors need a paid ChatGPT plan, and availability differs between plan types. That's ChatGPT's requirement, not ChairBack's — and ChairBack never charges you for AI.",
    steps: [
      {
        do: "Copy your shop's connection address above.",
        see: "The Copy button says “Copied”.",
      },
      {
        do: "Open ChatGPT on a computer and go to Settings → Connectors. If you can't find it, search your settings for “connector”.",
        see: "A connectors list. If there's no option to add your own, your plan doesn't include custom connectors yet.",
      },
      {
        do: "Add a custom connector, name it whatever you like, and paste the address into the URL box.",
      },
      {
        do: "If it asks how to authenticate, choose OAuth — ChairBack always requires sign-in. If it offers to register itself automatically, let it.",
        warn:
          "If you're offered a choice between letting it register automatically and supplying your own client ID, take the automatic one. ChairBack issues the credentials itself.",
      },
      {
        do: "Save, then start the connection. ChatGPT opens a ChairBack page and asks you to sign in if you aren't already.",
        see: "A ChairBack approval screen with your shop's name and what the assistant would be able to read.",
      },
      {
        do: "Read that list, then press Connect assistant.",
        see: "You land back in ChatGPT with ChairBack connected.",
      },
      {
        do: "Ask it something about your shop — “who's on my waitlist?” or “how was last month?”",
        see: "A real answer. Back on this page, it appears in the list above with a “last used” time.",
      },
    ],
  },
};

const TROUBLE: { q: string; a: string }[] = [
  {
    q: "There's no option to add a custom connector",
    a: "That's your AI plan, not ChairBack. Custom connectors are a paid feature at both Claude and ChatGPT, and it isn't something ChairBack can turn on for you.",
  },
  {
    q: "It failed straight after I pressed Add",
    a: "Check the OAuth client option. It has to be the one marked Detected — “No client ID — register one automatically” — not the one marked Recommended. ChairBack registers your assistant itself.",
  },
  {
    q: "It asked me to sign in and I got stuck",
    a: "Sign in to ChairBack in the same browser first, then start the connection again from your assistant. The approval screen needs you already signed in on that device.",
  },
  {
    q: "It connected, but it says it can't see something",
    a: "Check the list above — it shows exactly what you approved. If what you're asking about isn't there, disconnect it and connect again, ticking that permission.",
  },
  {
    q: "It's answering about the wrong shop",
    a: "A connection is tied to the shop you were switched to when you approved it. Switch to the right shop, then connect again — you'll get a separate connection for that one.",
  },
  {
    q: "I want it to stop right now",
    a: "Press Disconnect above. It stops immediately, on the assistant's very next request — you don't wait for anything to expire.",
  },
];

export function ConnectSteps({ connectUrl }: { connectUrl: string }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>("claude");
  const active = STEPS[provider];

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-gold transition-colors duration-150 ease-out hover:text-gold-muted"
      >
        {open ? "Hide step-by-step" : "Show me step-by-step"}
        <span
          aria-hidden
          className={open ? "rotate-180 transition-transform" : "transition-transform"}
        >
          ⌄
        </span>
      </button>

      {open && (
        <div className="mt-3 rounded-xl border border-subtle bg-charcoal-900/50 p-4">
          {/* Which assistant. The menus differ, so the steps have to. */}
          <div role="tablist" aria-label="Choose your assistant" className="flex gap-1.5">
            {(Object.keys(STEPS) as Provider[]).map((key) => (
              <button
                key={key}
                role="tab"
                type="button"
                aria-selected={provider === key}
                onClick={() => setProvider(key)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-150 ease-out ${
                  provider === key
                    ? "bg-gold text-charcoal"
                    : "border border-subtle text-muted hover:text-offwhite"
                }`}
              >
                {STEPS[key].name}
              </button>
            ))}
          </div>

          <p className="mt-3 text-xs leading-relaxed text-muted">{active.planNote}</p>

          <ol className="mt-3 space-y-3">
            {active.steps.map((s, i) => (
              <li key={`${provider}-${i}`} className="flex gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-gold/40 text-[11px] font-semibold text-gold"
                >
                  {i + 1}
                </span>
                {/* min-w-0 so a long line wraps instead of pushing the row wide. */}
                <div className="min-w-0 flex-1">
                  <p className="text-xs leading-relaxed text-offwhite">{s.do}</p>
                  {s.warn && (
                    <p className="mt-1.5 rounded-lg border border-gold/30 bg-gold/5 px-2.5 py-2 text-xs leading-relaxed text-offwhite">
                      {s.warn}
                    </p>
                  )}
                  {s.see && (
                    // 🔴 Every step says what you should SEE. A step you cannot
                    // verify is a step you leave uncertain.
                    <p className="mt-1 text-xs leading-relaxed text-muted">
                      <span className="text-offwhite/70">You should see:</span> {s.see}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-4 border-t border-subtle pt-3">
            <p className="text-xs font-semibold text-offwhite">If it doesn&apos;t work</p>
            <dl className="mt-2 space-y-2.5">
              {TROUBLE.map((t) => (
                <div key={t.q}>
                  <dt className="text-xs font-medium text-offwhite">{t.q}</dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-muted">{t.a}</dd>
                </div>
              ))}
            </dl>
          </div>

          <p className="mt-4 border-t border-subtle pt-3 text-xs leading-relaxed text-muted">
            The address to paste is{" "}
            <code className="rounded bg-charcoal-800 px-1.5 py-0.5 font-mono text-[11px] text-offwhite">
              {connectUrl}
            </code>
            . Menus at Claude and ChatGPT change from time to time — if the wording
            doesn&apos;t match exactly, look for anything called “connectors”, “apps”
            or “integrations” in their settings.
          </p>
        </div>
      )}
    </div>
  );
}

/** Exported so tests assert the SHIPPED strings, never a copy of them. */
export const CONNECT_STEPS = STEPS;
export const CONNECT_TROUBLE = TROUBLE;
