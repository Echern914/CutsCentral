import Link from "next/link";
import { getVocabulary } from "@/lib/vocab";
import { resolveHref, type SeatRole, flagsOffFor } from "@chairback/config/features";
import { getMe } from "@/lib/me";
import { featureLocks, getBillingSummary } from "@/lib/billing";
import { Card, CardHeader } from "@/components/ui/Card";
import { AskField } from "./AskField";
import { ConnectionPanel } from "./ConnectionPanel";
import { getConnections } from "./connections.server";
import {
  ctaAwayFrom,
  getReadiness,
  nextStep,
  problems,
  type ReadinessItemWire,
} from "./readiness";

/**
 * ChairBack Assistant.
 *
 * WHAT THIS IS. The one screen that answers "what do I do now" — what is
 * blocking the shop, what the next setup step is, and where anything lives.
 *
 * 🔴 IT WORKS WITH NOTHING CONNECTED, AND COSTS NOTHING TO RUN. Every number on
 * this page is DERIVED from data ChairBack already holds: the readiness engine
 * computes the problems, the help corpus answers the questions, and the feature
 * registry supplies the destinations. No model is called, no token is spent,
 * and there is no ChairBack-funded AI anywhere behind it.
 *
 * The plan is that a barber connects their OWN ChatGPT or Claude account over
 * MCP for the personal questions this page can only point at ("who should I
 * rebook?"). That is a later PR. Until it lands this page says so plainly
 * rather than advertising a connection that does not exist yet — the tab has to
 * be worth opening on its own, or the AI is load-bearing, which is exactly what
 * we are avoiding.
 *
 * NOT BEHIND THE PAYWALL, for the same reason /api/readiness isn't: a lapsed
 * shop needs this page most. Everything it reads either has no gate or fails
 * silently.
 */
export default async function AssistantPage() {
  const vocab = await getVocabulary();
  const me = await getMe();
  const role: SeatRole = (me.data?.shopRole ?? "OWNER") as SeatRole;
  const rewardsEnabled = me.data?.rewardsEnabled ?? true;
  const affiliateProgramEnabled = me.data?.affiliateProgramEnabled ?? false;
  const barberOnly = role === "BARBER";
  // Employee seats 403 on /api/billing, so they never ask (see lib/billing).
  const locks = barberOnly ? undefined : featureLocks(await getBillingSummary());

  // 🔴 Fetched in parallel and independently. If the MCP surface is down,
  // getConnections resolves to null and only the panel degrades - readiness,
  // help and navigation are untouched.
  const [readiness, connections] = await Promise.all([getReadiness(), getConnections()]);
  const step = nextStep(readiness, vocab.stationNoun);
  // Continue-setup already leads with the next item, so it is dropped from the
  // problem list rather than printed twice.
  const current = problems(readiness, step?.item.id);
  // This page's own route, so no card can offer a button back to it.
  const ownHref = resolveHref("assistant", { role }) ?? "/dashboard/assistant";

  const shopName = me.data?.activeShopName ?? me.data?.shops?.[0]?.name ?? "your shop";
  const stepCta = step ? ctaAwayFrom(step.item, ownHref) : undefined;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6">
        <h1 className="font-display text-3xl tracking-tight">ChairBack Assistant</h1>
        <p className="mt-1 text-sm text-muted">
          Answers about {shopName}, and the fastest way to whatever you need.
        </p>

        {/* The connector panel. Data is fetched server-side and may be null;
            the panel renders an honest "couldn't check" line rather than
            taking the page down with it. */}
        <ConnectionPanel
          data={connections}
          shopName={shopName}
          roleLabel={roleLabel(role, vocab.stationNoun)}
        />

      </header>

      <AskField role={role} rewardsEnabled={rewardsEnabled} affiliateProgramEnabled={affiliateProgramEnabled} />

      {step && (
        <Card className="mb-6">
          <CardHeader
            title="Continue setup"
            subtitle={`${step.milestoneTitle} · ${step.complete} of ${step.total} done`}
          />
          <div className="px-5 py-4">
            <p className="text-sm font-medium text-offwhite">{step.item.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{step.item.why}</p>
            {stepCta ? (
              <Link
                href={stepCta.href}
                className="mt-3 inline-flex items-center rounded-full bg-gold px-4 py-2 text-sm font-semibold text-charcoal transition-colors duration-150 ease-out hover:bg-gold-muted"
              >
                {stepCta.label} →
              </Link>
            ) : (
              <Handover item={step.item} role={role} />
            )}
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader
          title="Needs your attention"
          subtitle={
            current.length === 0
              ? "Nothing is blocking you right now"
              : `${current.length} thing${current.length === 1 ? "" : "s"} to sort out`
          }
        />
        {current.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">
            {readiness === null
              ? "Couldn’t read your shop’s status just now. Everything else on this page still works."
              : "You’re all clear. Anything that needs you will show up here."}
          </p>
        ) : (
          <ul className="divide-y divide-subtle">
            {current.map((p) => (
              <ProblemRow key={p.id} item={p} ownHref={ownHref} role={role} />
            ))}
          </ul>
        )}
      </Card>

      <QuickActions role={role} rewardsEnabled={rewardsEnabled} affiliateProgramEnabled={affiliateProgramEnabled} premiumAiLocked={locks?.premiumAi ?? false} />
    </main>
  );
}

function roleLabel(role: SeatRole, stationNoun: string): string {
  return role === "BARBER" ? `your ${stationNoun}` : role === "MANAGER" ? "manager" : "owner";
}

/**
 * One problem: what it is, why it matters, and the button that fixes it.
 *
 * `blocksLaunch` is the ONLY thing that earns red. Everything else is gold —
 * an ordinary "this wants you" colour. A page where every row is red teaches
 * the barber that red means nothing.
 */
/**
 * What to say when an item has no button.
 *
 * 🔴 There are THREE reasons a CTA is absent and they are not the same
 * sentence. Telling an owner "your manager has to finish this" when the truth
 * is "nobody in your shop can, this is switched off on the deployment" is a
 * dead end dressed as an instruction — and it is what this page did before the
 * render pass caught it.
 *
 *  - the registry withheld the destination from THIS seat -> name who can;
 *  - the item never had one (a deployment-level fact like message sending
 *    being off) -> say nothing; the evidence line above already explains it;
 *  - we dropped a link back to this very page -> say nothing.
 */
function Handover({
  item,
  role,
  className = "mt-3",
}: {
  item: ReadinessItemWire;
  role: SeatRole;
  className?: string;
}) {
  const RANK = { barber: 0, manager: 1, owner: 2 } as const;
  const SEAT = { BARBER: 0, MANAGER: 1, OWNER: 2 } as const;
  const outOfReach = SEAT[role] < RANK[item.role];
  if (!outOfReach) return null;
  return (
    <p className={`${className} text-xs text-muted`}>
      {item.role === "owner"
        ? "Whoever owns the shop account has to finish this one."
        : "Your shop’s manager has to finish this one."}
    </p>
  );
}

function ProblemRow({
  item,
  ownHref,
  role,
}: {
  item: ReadinessItemWire;
  ownHref: string;
  role: SeatRole;
}) {
  const urgent = item.blocksLaunch;
  const cta = ctaAwayFrom(item, ownHref);
  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${urgent ? "bg-danger-soft" : "bg-gold"}`}
          aria-hidden
        />
        {/* 🔴 min-w-0: without it this flex item refuses to shrink below its
            content and a long chair name pushes the whole row past the
            viewport. */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-offwhite">{item.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">{item.why}</p>
          <p className="mt-1 text-xs text-muted">{item.evidence}</p>
          {cta ? (
            <Link
              href={cta.href}
              className="mt-2.5 inline-flex items-center rounded-full border border-gold/40 px-3.5 py-1.5 text-xs font-semibold text-gold transition-colors duration-150 ease-out hover:bg-gold/10"
            >
              {cta.label} →
            </Link>
          ) : (
            <Handover item={item} role={role} className="mt-2.5" />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The things a barber opens the app to do. Every destination is RESOLVED from
 * the registry against this seat, so a tile that would 403 simply isn't drawn —
 * there is no local list of routes here to drift.
 */
function QuickActions({
  role,
  rewardsEnabled,
  affiliateProgramEnabled,
  premiumAiLocked,
}: {
  role: SeatRole;
  rewardsEnabled: boolean;
  affiliateProgramEnabled: boolean;
  premiumAiLocked: boolean;
}) {
  const ctx = {
    role,
    flagsOff: flagsOffFor({ rewardsEnabled, affiliateProgramEnabled }),
    // A locked premium feature still LISTS (its page explains the lock); only
    // the receptionist inbox is hidden when the add-on was never bought, since
    // for that shop it is a permanently empty room.
    hasPremiumAi: !premiumAiLocked,
  };
  const tiles: { featureId: string; label: string }[] = [
    { featureId: "appointments", label: "Today’s schedule" },
    { featureId: "waitlist", label: "Open waitlist" },
    { featureId: "requests", label: "Booking requests" },
    { featureId: "staff", label: "Block time" },
    { featureId: "rebook-nudges", label: "Find overdue clients" },
    { featureId: "integrations", label: "Check integrations" },
    { featureId: "mini-site", label: "Preview booking page" },
    { featureId: "insights", label: "How’s business?" },
  ];
  const resolved = tiles
    .map((t) => ({ ...t, href: resolveHref(t.featureId, { ...ctx, flagsOff: [...ctx.flagsOff] }) }))
    .filter((t): t is typeof t & { href: string } => t.href !== null);

  if (resolved.length === 0) return null;

  return (
    <Card>
      <CardHeader title="Quick actions" subtitle="The usual jobs, one tap away" />
      <div className="grid grid-cols-2 gap-2.5 px-5 py-4 sm:grid-cols-3">
        {resolved.map((t) => (
          <Link
            key={t.featureId}
            href={t.href}
            // min-h-16 keeps every tile well past the 44px touch floor.
            className="flex min-h-16 items-center justify-center rounded-2xl border border-subtle bg-charcoal-800 px-3 py-3 text-center text-xs font-medium text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
          >
            {t.label}
          </Link>
        ))}
      </div>
    </Card>
  );
}
