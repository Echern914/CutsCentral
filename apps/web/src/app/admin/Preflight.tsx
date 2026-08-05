import { Card } from "@/components/ui/Card";

/**
 * Launch readiness. Mirrors GET /api/admin-portal/preflight - see
 * apps/api/src/ops/preflight.ts for why this exists: every integration is
 * behind an optional env seam, so an unconfigured prod box looks healthy right
 * up until a real shop's texts go nowhere.
 */
export interface PreflightCheck {
  key: string;
  label: string;
  ok: boolean;
  severity: "blocker" | "warn" | "info";
  detail: string;
  impact?: string;
  fix?: string;
}

export interface Preflight {
  dryRun: boolean;
  blockers: number;
  warnings: number;
  checks: PreflightCheck[];
}

// Status dot + its text label. The label is what makes this readable without
// colour (WCAG 1.4.1) - the dot is decoration, never the sole signal.
function Status({ check }: { check: PreflightCheck }) {
  const { ok, severity } = check;
  const tone = ok
    ? { dot: "bg-emerald-400", text: "text-emerald-300", word: "Ready" }
    : severity === "blocker"
      ? { dot: "bg-red-400", text: "text-red-300", word: "Blocker" }
      : severity === "warn"
        ? { dot: "bg-amber-400", text: "text-amber-300", word: "Warning" }
        : { dot: "bg-charcoal-500", text: "text-muted", word: "Off" };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${tone.text}`}>
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${tone.dot}`} />
      {tone.word}
    </span>
  );
}

export function PreflightSection({ p }: { p: Preflight }) {
  const headline =
    p.blockers > 0
      ? `${p.blockers} blocker${p.blockers === 1 ? "" : "s"} — do not onboard a paying shop yet`
      : p.warnings > 0
        ? `No blockers · ${p.warnings} warning${p.warnings === 1 ? "" : "s"}`
        : "Everything configured";

  return (
    <section aria-labelledby="preflight-heading">
      <h2 id="preflight-heading" className="mb-1 mt-10 font-display text-lg">
        Launch readiness
      </h2>
      <p
        className={`mb-3 text-sm ${
          p.blockers > 0 ? "text-red-300" : p.warnings > 0 ? "text-amber-300" : "text-emerald-300"
        }`}
      >
        {headline}
      </p>

      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-subtle/60">
          {p.checks.map((c) => (
            <li key={c.key} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-offwhite">{c.label}</p>
                <p className="text-xs text-muted">{c.detail}</p>
                {!c.ok && c.impact && (
                  <p className="mt-1 text-xs text-muted">{c.impact}</p>
                )}
                {!c.ok && c.fix && (
                  <p className="mt-1 font-mono text-xs text-gold/90">{c.fix}</p>
                )}
              </div>
              <Status check={c} />
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
