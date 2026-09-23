"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import {
  EVERYWHERE,
  REGISTRAR_GUIDES,
  guideById,
  hostFor,
  type RegistrarGuide,
  type RegistrarId,
} from "./registrarGuides";

type DnsRecord = { type: string; name: string; value: string };

/**
 * The "Step-by-step" button beside the domain card's actions, and the guide it
 * opens: pick the company that manages your domain, get that company's clicks
 * and the records written the way THAT company's form wants them.
 *
 * Nothing is preselected on purpose. The costliest wrong turn is following
 * the guide for where the domain was BOUGHT when its DNS actually lives
 * somewhere else (a Wix or Squarespace site, a move to Cloudflare), so the
 * first thing the dialog says is how to tell - before any company's steps.
 */
export function DomainGuideButton({
  domain,
  records,
}: {
  domain: string | null;
  /** Empty before Connect - the TXT value does not exist until then. */
  records: readonly DnsRecord[];
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<RegistrarId | null>(null);
  const guide = picked ? guideById(picked) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-subtle px-3 py-1.5 text-xs font-medium text-offwhite/90 transition-colors duration-150 ease-out hover:bg-charcoal-700 hover:text-offwhite"
      >
        <span aria-hidden className="text-gold">?</span>
        Step-by-step for GoDaddy, Namecheap &amp; more
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Connect your domain, step by step"
        subtitle="Where do you manage your domain?"
        className="sm:max-w-lg"
        scrollResetKey={picked ?? "none"}
      >
        <div
          role="group"
          aria-label="Where you manage your domain"
          className="flex flex-wrap gap-2"
        >
          {REGISTRAR_GUIDES.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={picked === g.id}
              onClick={() => setPicked(g.id)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors duration-150 ease-out ${
                picked === g.id
                  ? "border-gold bg-gold/15 font-semibold text-offwhite"
                  : "border-subtle text-muted hover:text-offwhite"
              }`}
            >
              {g.name}
            </button>
          ))}
        </div>

        <p className="mt-3 text-xs text-muted">
          Pick where your domain&apos;s DNS is managed. That&apos;s usually where you
          bought it — but if you built a website on Wix or Squarespace, or moved
          the domain to Cloudflare, the DNS may live there instead.
        </p>

        {guide && <GuideBody guide={guide} domain={domain} records={records} />}
      </Dialog>
    </>
  );
}

function GuideBody({
  guide,
  domain,
  records,
}: {
  guide: RegistrarGuide;
  domain: string | null;
  records: readonly DnsRecord[];
}) {
  return (
    <div className="mt-5 flex flex-col gap-4">
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-offwhite/90">
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-offwhite">
          What to enter at {guide.name}
        </h3>
        {records.length === 0 ? (
          <p className="rounded-xl border border-subtle px-3 py-2 text-sm text-muted">
            Your three records appear here once you tap Connect — written the way{" "}
            {guide.name} wants them.
          </p>
        ) : (
          // Wide values scroll inside the table rather than wrap, so whoever
          // copies one never grabs a line break.
          <div className="overflow-x-auto rounded-xl border border-subtle">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-subtle text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">{guide.nameLabel}</th>
                  <th className="px-3 py-2">Value</th>
                </tr>
              </thead>
              <tbody className="font-mono text-xs">
                {records.map((r) => {
                  const host = hostFor(guide, r.name, domain);
                  return (
                    <tr key={`${r.type}-${r.name}-${r.value}`} className="border-b border-subtle last:border-0">
                      <td className="px-3 py-2 align-top">{r.type}</td>
                      <td className="px-3 py-2 align-top break-all">
                        {host === "" ? (
                          <span className="font-sans italic text-muted">leave blank</span>
                        ) : (
                          host
                        )}
                      </td>
                      <td className="px-3 py-2 align-top break-all">
                        {r.value}
                        {guide.pointerRowNote && (r.type === "A" || r.type === "CNAME") && (
                          <span className="mt-1 block font-sans text-[11px] text-gold">
                            {guide.pointerRowNote}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gold/30 bg-gold/5 px-3 py-2">
        <h3 className="text-sm font-semibold text-offwhite">Watch out</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-offwhite/90">
          {guide.watchOut.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>

      <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
        {EVERYWHERE.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </div>
  );
}
