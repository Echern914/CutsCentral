"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { useToast } from "@/components/ui/Toast";
import {
  connectDomainAction,
  removeDomainAction,
  verifyDomainAction,
  type DomainStatus,
} from "./domainActions";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/**
 * "Use your own domain" card. The flow it renders:
 *
 *   type the domain → Connect (we attach it on Vercel) → set the two DNS
 *   records at the registrar → "Check again" until Vercel reports the DNS is
 *   right → Connected.
 *
 * Copy is explicit that the domain REDIRECTS to their ChairBack page and that
 * Google will show the getchairback.com address — that's the product decision
 * (every shop strengthens one domain), and saying it here prevents the
 * "why does the URL change?" support email.
 */
export function DomainCard({ initial }: { initial: DomainStatus }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<DomainStatus>(initial);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(
    action: () => Promise<{ ok: boolean; status?: DomainStatus; error?: string }>,
    successToast?: string,
  ) {
    setError(null);
    startTransition(async () => {
      const res = await action();
      if (res.ok && res.status) {
        setStatus(res.status);
        if (successToast) toast(successToast, "success");
      } else {
        setError(res.error ?? "Something went wrong. Try again.");
      }
    });
  }

  if (!status.available) {
    return (
      <Card className="overflow-hidden">
        <CardHeader
          title="Use your own domain"
          subtitle="Point a domain you own at your ChairBack page."
        />
        <p className="px-5 pb-5 text-sm text-muted">
          Domain connections aren&apos;t switched on for this account yet. Email{" "}
          <a className="text-gold underline underline-offset-2" href="mailto:support@getchairback.com">
            support@getchairback.com
          </a>{" "}
          with the domain you own and we&apos;ll set it up with you.
        </p>
      </Card>
    );
  }

  const connected = Boolean(status.domain);
  const live = Boolean(
    status.verifiedAt ||
      (status.vercel && status.vercel.verified && !status.vercel.misconfigured),
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Use your own domain"
        subtitle="Your domain sends visitors straight to your ChairBack page."
      />
      <div className="flex flex-col gap-4 px-5 pb-5">
        {!connected && (
          <>
            <p className="text-sm text-muted">
              Own a domain like <span className="text-offwhite">drickcuttinup.com</span>?
              Connect it and anyone who types it — or clicks it anywhere — lands on
              your page here. Google search results show your page&apos;s
              getchairback.com address.
            </p>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (input.trim()) run(() => connectDomainAction(input), "Domain connected — now set the DNS records");
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="yourshop.com"
                aria-label="Your domain"
                className={field}
                maxLength={253}
              />
              <button
                type="submit"
                disabled={pending || !input.trim()}
                className="shrink-0 rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-opacity duration-150 ease-out disabled:opacity-40"
              >
                {pending ? "Connecting…" : "Connect"}
              </button>
            </form>
          </>
        )}

        {connected && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-offwhite">{status.domain}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  live ? "bg-green-500/15 text-green-400" : "bg-gold/15 text-gold"
                }`}
              >
                {live ? "Connected" : "Waiting on DNS"}
              </span>
            </div>

            {!live && (
              <>
                <p className="text-sm text-muted">
                  Add these records where you bought the domain (GoDaddy, Namecheap,
                  Squarespace…). They usually take minutes, occasionally up to 48
                  hours.
                </p>
                {/* The records table. Wide values scroll rather than wrap so a
                    barber copying them never grabs a line break. */}
                <div className="overflow-x-auto rounded-xl border border-subtle">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-subtle text-[11px] uppercase tracking-wide text-muted">
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Value</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-xs">
                      {status.records.map((r) => (
                        <tr key={`${r.type}-${r.name}`} className="border-b border-subtle last:border-0">
                          <td className="px-3 py-2">{r.type}</td>
                          <td className="px-3 py-2">{r.name}</td>
                          <td className="px-3 py-2">{r.value}</td>
                        </tr>
                      ))}
                      {/* Ownership challenge — Vercel only demands this when the
                          domain is claimed by another account. */}
                      {status.vercel?.verification.map((v) => (
                        <tr key={v.value} className="border-b border-subtle last:border-0">
                          <td className="px-3 py-2">{v.type}</td>
                          <td className="px-3 py-2 break-all">{v.domain}</td>
                          <td className="px-3 py-2 break-all">{v.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {live && (
              <p className="text-sm text-muted">
                Working. Visitors to {status.domain} land on your page, and Google
                shows your page&apos;s getchairback.com address in results.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {!live && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => verifyDomainAction())}
                  className="rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-opacity duration-150 ease-out disabled:opacity-40"
                >
                  {pending ? "Checking…" : "I've added them — check again"}
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Disconnect ${status.domain}? It will stop pointing at your page.`)) {
                    run(() => removeDomainAction(), "Domain disconnected");
                  }
                }}
                className="rounded-full border border-subtle px-4 py-2 text-sm text-muted transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite disabled:opacity-40"
              >
                Disconnect
              </button>
            </div>
          </>
        )}

        <FormError>{error}</FormError>
      </div>
    </Card>
  );
}
