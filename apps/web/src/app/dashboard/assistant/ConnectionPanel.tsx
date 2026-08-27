"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { disconnectAssistant } from "./actions";
import { since, type McpConnectionsWire } from "./connections";

/**
 * "Which assistants can read my shop, and how do I stop one?"
 *
 * 🔴 THE DISCONNECT BUTTON IS THE POINT OF THIS PANEL. Everything else is
 * informational; this is the control a human reaches for when a laptop is lost
 * or an assistant is behaving oddly. It calls a DELETE that kills the
 * connection and every token on it in one transaction, so the assistant's very
 * next request fails - not its next refresh, and not at expiry.
 *
 * 🔴 NOTHING HERE IS LOAD-BEARING FOR THE REST OF THE TAB. If the connections
 * API is down, `data` is null, this renders an honest "couldn't check" line,
 * and readiness, help and navigation carry on. The Assistant tab has to be
 * worth opening with the connector completely dead.
 */
export function ConnectionPanel({
  data,
  shopName,
  roleLabel,
}: {
  data: McpConnectionsWire | null;
  shopName: string;
  roleLabel: string;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (data === null) {
    return (
      <Shell>
        <Dot tone="muted" />
        <span className="font-medium text-offwhite">Couldn&apos;t check connections</span>
        <span className="text-muted">·</span>
        <span className="text-muted">Everything else on this page still works</span>
      </Shell>
    );
  }

  const connected = data.connections.length > 0;

  async function disconnect(id: string) {
    setBusyId(id);
    setError(null);
    const res = await disconnectAssistant(id);
    setBusyId(null);
    setConfirmId(null);
    if (!res.ok) {
      setError("Couldn't disconnect just now. Try again.");
      return;
    }
    // Re-read from the server rather than dropping the row locally: the list is
    // the truth about what can still reach the shop, and a stale "disconnected"
    // row is exactly the wrong thing to be confident about.
    router.refresh();
  }

  async function copyUrl() {
    if (!data?.connectUrl) return;
    try {
      await navigator.clipboard.writeText(data.connectUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the URL is on screen and selectable anyway.
      setCopied(false);
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-subtle bg-charcoal-800/60 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Dot tone={connected ? "on" : "muted"} />
        <span className="font-medium text-offwhite">
          {connected
            ? `${data.connections.length} assistant${data.connections.length === 1 ? "" : "s"} connected`
            : "No assistant connected"}
        </span>
        <span className="text-muted">·</span>
        <span className="text-muted">
          {shopName} · {roleLabel} · read-only
        </span>
      </div>

      {connected && (
        <ul className="mt-3 divide-y divide-subtle border-y border-subtle">
          {data.connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-offwhite">{c.clientName}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {c.connectedBy} · added {since(c.connectedAt)}
                  {c.lastUsedAt ? ` · last used ${since(c.lastUsedAt)}` : " · not used yet"}
                </p>
                {c.permissions.length > 0 && (
                  <p className="mt-1 text-xs leading-relaxed text-muted">
                    Can read: {c.permissions.join(" · ")}
                  </p>
                )}
              </div>

              {confirmId === c.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void disconnect(c.id)}
                    disabled={busyId === c.id}
                    className="rounded-full bg-danger px-3 py-1.5 text-xs font-semibold text-offwhite transition-colors duration-150 ease-out disabled:opacity-60"
                  >
                    {busyId === c.id ? "Disconnecting…" : "Yes, disconnect"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="rounded-full border border-subtle px-3 py-1.5 text-xs font-medium text-muted"
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(c.id)}
                  className="shrink-0 rounded-full border border-subtle px-3 py-1.5 text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:border-strong"
                >
                  Disconnect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {data.entitled && data.connectUrl ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-offwhite">
            {connected ? "Connect another assistant" : "Connect your own AI assistant"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            In Claude or ChatGPT, add a custom connector and paste this address.
            You&apos;ll be asked to sign in to ChairBack and approve what it can
            read.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-subtle bg-charcoal-900/70 px-3 py-2 font-mono text-xs text-offwhite">
              {data.connectUrl}
            </code>
            <button
              type="button"
              onClick={() => void copyUrl()}
              className="shrink-0 rounded-full bg-gold px-3 py-2 text-xs font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Connecting an AI assistant needs {data.requiredPlan}. Everything on
          this page — setup status, guides and finding your way around — keeps
          working on any plan.
        </p>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted">
        Your AI provider handles the conversation and the usage under your own
        plan, and ChairBack never charges you for AI. Availability depends on
        your provider&apos;s plan; ChairBack does not sell or provide AI model
        credits. Connected assistants are{" "}
        <span className="text-offwhite">read-only</span> — they can look, never
        change or cancel anything.
      </p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-2xl border border-subtle bg-charcoal-800/60 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">{children}</div>
    </div>
  );
}

function Dot({ tone }: { tone: "on" | "muted" }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        tone === "on" ? "bg-success" : "bg-muted"
      }`}
      aria-hidden
    />
  );
}
