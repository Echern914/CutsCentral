"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { disconnectAssistant } from "./actions";
import { ConnectSteps } from "./ConnectSteps";
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
  const [showAll, setShowAll] = useState(false);
  const [confirmSweep, setConfirmSweep] = useState(false);

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
  /**
   * How many rows before a list stops being a list and becomes a wall.
   *
   * 🔴 THIS IS NOT COSMETIC. Every failed connect attempt registers a NEW
   * client with the provider, which is a new connection here - four dead
   * entries filled a screen and pushed the thing people came for below the
   * fold. The list has to stay short whatever the history behind it.
   */
  const VISIBLE = 3;
  const shown = showAll ? data.connections : data.connections.slice(0, VISIBLE);
  const hidden = data.connections.length - shown.length;
  /**
   * Never used = almost certainly a failed attempt. Safe to offer as a batch,
   * because an assistant that has never made a call cannot be in use by anyone.
   */
  const unused = data.connections.filter((c) => c.lastUsedAt === null);

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

  async function disconnectMany(ids: string[]) {
    setBusyId("sweep");
    setError(null);
    // Sequential, not parallel: this is a revocation, and a half-applied batch
    // is harder to reason about than a slightly slower one.
    let failed = 0;
    for (const id of ids) {
      const res = await disconnectAssistant(id);
      if (!res.ok) failed += 1;
    }
    setBusyId(null);
    setConfirmSweep(false);
    if (failed > 0) setError(`Couldn't disconnect ${failed}. Try again.`);
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
        <>
          <ul className="mt-3 divide-y divide-subtle border-y border-subtle">
            {shown.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-offwhite">{c.clientName}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {c.connectedBy} · added {since(c.connectedAt)}
                    {c.lastUsedAt ? ` · last used ${since(c.lastUsedAt)}` : " · not used yet"}
                  </p>
                  {/* 🔴 COLLAPSED. Seven near-identical phrases, repeated per
                      row, were the bulk of the panel's height and the least-read
                      thing on it. One tap away instead of always on. */}
                  {c.permissions.length > 0 && (
                    <details className="group mt-1">
                      <summary className="cursor-pointer list-none text-xs text-muted transition-colors duration-150 ease-out hover:text-offwhite">
                        Can read {c.permissions.length} thing
                        {c.permissions.length === 1 ? "" : "s"}
                        <span aria-hidden className="ml-1 group-open:hidden">
                          — show
                        </span>
                        <span aria-hidden className="ml-1 hidden group-open:inline">
                          — hide
                        </span>
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {c.permissions.map((p) => (
                          <li key={p} className="text-xs leading-relaxed text-muted">
                            · {p}
                          </li>
                        ))}
                      </ul>
                    </details>
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

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-xs font-semibold text-gold transition-colors duration-150 ease-out hover:text-gold-muted"
              >
                Show {hidden} more
              </button>
            )}
            {showAll && data.connections.length > VISIBLE && (
              <button
                type="button"
                onClick={() => setShowAll(false)}
                className="text-xs font-semibold text-gold transition-colors duration-150 ease-out hover:text-gold-muted"
              >
                Show fewer
              </button>
            )}

            {/* 🔴 The escape hatch for the mess a failed connect flow leaves.
                Clearing four dead entries one at a time is the kind of chore
                people simply do not do, so they live there forever looking like
                real access. */}
            {unused.length > 1 &&
              (confirmSweep ? (
                <span className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void disconnectMany(unused.map((c) => c.id))}
                    disabled={busyId === "sweep"}
                    className="rounded-full bg-danger px-3 py-1.5 text-xs font-semibold text-offwhite transition-colors duration-150 ease-out disabled:opacity-60"
                  >
                    {busyId === "sweep"
                      ? "Disconnecting…"
                      : `Yes, disconnect ${unused.length}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmSweep(false)}
                    className="rounded-full border border-subtle px-3 py-1.5 text-xs font-medium text-muted"
                  >
                    Keep them
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmSweep(true)}
                  className="text-xs font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
                >
                  Tidy up {unused.length} never used
                </button>
              ))}
          </div>
        </>
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

          {/* Collapsed by default: someone who has done this before does not
              need nine steps in their face, and someone who hasn't needs all
              of them. */}
          <ConnectSteps connectUrl={data.connectUrl} />
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
