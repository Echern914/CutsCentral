"use client";

import { useState, useTransition } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormError } from "@/components/ui/FormError";
import { useToast } from "@/components/ui/Toast";
import {
  connectDomainAction,
  removeDomainAction,
  verifyDomainAction,
  type DnsRecordStatus,
  type DnsTxtStatus,
  type DomainStatus,
} from "./domainActions";
import { DomainGuideButton } from "./DomainGuide";
import { relativeRecordName } from "./registrarGuides";

const field =
  "w-full rounded-xl border border-subtle bg-charcoal-700 px-3 py-2 text-sm text-offwhite placeholder:text-muted outline-none focus:border-gold/50";

/**
 * "Use your own domain" card. The flow it renders:
 *
 *   type the domain → Connect → set THREE records at the registrar (A, CNAME,
 *   and a TXT ownership record with this shop's own token) → "Check again"
 *   until our lookup sees all of them → Connected.
 *
 * 🔴 THE COPY IS THE PRODUCT HERE. Three of three owners who connected a domain
 * in production never finished DNS. The old card showed two records and the
 * word "waiting", and gave nobody a way to tell which record was wrong or that
 * a leftover parking record was winning. This one says, per record, what we
 * can see and what it currently points at - and it says up front that
 * connecting REPLACES whatever website is on that domain today, because that
 * is the surprise that costs a support email.
 *
 * Copy is explicit that the domain REDIRECTS to their ChairBack page and that
 * Google will show the getchairback.com address — that's the product decision
 * (every shop strengthens one domain), and saying it here prevents the "why
 * does the URL change?" question.
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
  // Live = ownership proven and pointing here. Only verifiedAt says that now;
  // Vercel's own green means "DNS points at Vercel", which is not proof of
  // anything about WHO set it.
  const live = Boolean(status.verifiedAt);

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
              your page here, over https, automatically. Google search results show
              your page&apos;s getchairback.com address.
            </p>
            <p className="rounded-xl border border-gold/30 bg-gold/5 px-3 py-2 text-sm text-offwhite/90">
              If that domain already has a website on it, connecting it here{" "}
              <span className="font-semibold">replaces that site</span> — visitors
              will see your ChairBack page instead. Email on the domain is not
              affected.
            </p>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (input.trim()) run(() => connectDomainAction(input), "Connected — now add the three records below");
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
            <div>
              <DomainGuideButton domain={null} records={[]} />
            </div>
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
                {live ? "Connected" : "Not connected yet"}
              </span>
            </div>

            {!live && (
              <>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
                  <li>
                    Open the DNS settings wherever you bought the domain (GoDaddy,
                    Namecheap, Squarespace, Google Domains…).
                  </li>
                  <li>
                    Add the three records below, exactly as shown. The TXT one is
                    yours alone — it&apos;s how we know the domain is really yours.
                  </li>
                  <li>
                    If there&apos;s already an A record or a &quot;parking&quot; record
                    on <span className="font-mono text-offwhite">@</span>, delete it.
                    Two A records on @ and the wrong one wins. Leave any other TXT
                    records on @ where they are — those are usually your email.
                  </li>
                  <li>Come back and tap check again. Minutes, usually — up to 48 hours at worst.</li>
                </ol>
                <div>
                  <DomainGuideButton
                    domain={status.domain}
                    records={[
                      ...status.records,
                      ...(status.vercel?.verification ?? []).map((v) => ({
                        type: v.type,
                        name: v.domain,
                        value: v.value,
                      })),
                    ]}
                  />
                </div>

                {/* The records table. Wide values scroll rather than wrap so
                    whoever copies them never grabs a line break. Each row
                    carries what OUR lookup last saw for it - the difference
                    between "waiting" and "your A record points at the wrong
                    place". */}
                <div className="overflow-x-auto rounded-xl border border-subtle">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-subtle text-[11px] uppercase tracking-wide text-muted">
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Value</th>
                        <th className="px-3 py-2">What we see</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-xs">
                      {status.records.map((r) => (
                        <tr key={`${r.type}-${r.name}`} className="border-b border-subtle last:border-0">
                          <td className="px-3 py-2">{r.type}</td>
                          <td className="px-3 py-2 break-all">
                            {relativeRecordName(r.name, status.domain)}
                          </td>
                          <td className="px-3 py-2 break-all">{r.value}</td>
                          <td className="px-3 py-2 font-sans">
                            <RecordSeen record={r} dns={status.dns} />
                          </td>
                        </tr>
                      ))}
                      {/* Vercel's own ownership challenge — only demanded when
                          the domain is claimed by another Vercel account. */}
                      {status.vercel?.verification.map((v) => (
                        <tr key={v.value} className="border-b border-subtle last:border-0">
                          <td className="px-3 py-2">{v.type}</td>
                          <td className="px-3 py-2 break-all">
                            {relativeRecordName(v.domain, status.domain)}
                          </td>
                          <td className="px-3 py-2 break-all">{v.value}</td>
                          <td className="px-3 py-2 font-sans text-muted">Also required</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* 🔴 This used to say a full TXT name was "fine". It is not: a
                    registrar that appends the domain itself stores it twice
                    (`name.example.com.example.com`), and the owner - having
                    typed exactly what they were shown - cannot see why. */}
                <p className="text-xs text-muted">
                  @ means your domain itself — some registrars want that field left
                  blank instead. Type only what&apos;s in the Name column; your
                  registrar adds the rest.
                  {status.dns ? ` Last checked ${new Date(status.dns.checkedAt).toLocaleTimeString()}.` : ""}
                </p>
              </>
            )}

            {live && (
              <p className="text-sm text-muted">
                Working. Visitors to {status.domain} — with or without www — land on
                your page over https, and Google shows your page&apos;s
                getchairback.com address in results.
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
                  if (
                    window.confirm(
                      `Disconnect ${status.domain}? It will stop pointing at your page. Remove the three records at your registrar afterwards too.`,
                    )
                  ) {
                    run(
                      () => removeDomainAction(),
                      "Disconnected — now remove the three records at your registrar",
                    );
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

/** One record's live diagnosis, in plain words. */
function RecordSeen({
  record,
  dns,
}: {
  record: { type: string; name: string; value: string };
  dns: DomainStatus["dns"];
}) {
  if (!dns) return <span className="text-muted">Not checked yet</span>;
  if (record.type === "TXT") return <TxtSeen status={dns.txt.status} />;
  const r = record.type === "A" ? dns.apex : dns.www;
  return <PointerSeen status={r.status} found={r.found} />;
}

function PointerSeen({ status, found }: { status: DnsRecordStatus; found: string | null }) {
  switch (status) {
    case "points_here":
      return <span className="text-green-400">✓ Found</span>;
    case "points_elsewhere":
      return (
        <span className="text-gold">
          Points to <span className="font-mono">{found}</span> — change it to the value shown
        </span>
      );
    case "missing":
      return <span className="text-gold">Not there yet</span>;
    default:
      return <span className="text-muted">Couldn&apos;t check just now</span>;
  }
}

function TxtSeen({ status }: { status: DnsTxtStatus }) {
  switch (status) {
    case "found":
      return <span className="text-green-400">✓ Found</span>;
    case "wrong":
      return <span className="text-gold">Has a different value — replace it with the one shown</span>;
    case "missing":
      return <span className="text-gold">Not there yet</span>;
    default:
      return <span className="text-muted">Couldn&apos;t check just now</span>;
  }
}
