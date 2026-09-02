import Link from "next/link";
import { resolveHref, flagsOffFor } from "@chairback/config/features";
import { Card } from "@/components/ui/Card";

/**
 * First-run guidance. A brand-new barber otherwise lands on an all-zero
 * dashboard (0 clients, empty at-risk/leaderboard/charts) that reads as broken.
 * This replaces that confusion with clear next steps. Shown only while the shop
 * has no clients yet.
 */
export function GettingStarted({
  connected,
  hasClients,
  rewardsEnabled = true,
  affiliateProgramEnabled = false,
}: {
  connected: boolean;
  hasClients: boolean;
  rewardsEnabled?: boolean;
  affiliateProgramEnabled?: boolean;
}) {
  if (hasClients) return null;

  // Destinations come from the registry, so this card cannot drift from the
  // readiness engine's CTAs or the More sheet the way it used to.
  const connectHref = resolveHref("onboarding-connect", { role: "OWNER" });
  const clientsHref = resolveHref("clients");
  const rewardsHref = resolveHref("punch-cards", {
    flagsOff: flagsOffFor({ rewardsEnabled, affiliateProgramEnabled }),
  });

  const steps = [
    {
      done: connected,
      title: connected ? "Booking connected" : "Connect your booking calendar",
      body: connected
        ? "Your appointments will sync automatically as clients book."
        : "Link Acuity or Square so clients and visits import automatically - or set up ChairBack's own booking page.",
      href: connected ? undefined : (connectHref ?? undefined),
      cta: "Connect booking",
    },
    {
      done: false,
      title: "Add a client or import history",
      body: connected
        ? "No appointments yet? Add a walk-in by hand to start a punch card."
        : "Import your client list (CSV from Booksy, Fresha, Vagaro…) or add a walk-in by hand now.",
      href: clientsHref ?? undefined,
      cta: "Go to Clients",
    },
    // Rewards are opt-in - a booking-only shop has no rewards step to do, and
    // the registry is what knows that (the `rewardsEnabled` flag on the entry),
    // rather than this card testing the prop for itself.
    ...(rewardsHref
      ? [
          {
            done: false,
            title: "Set up your rewards",
            body: "Decide how many visits earn a reward, and clients see it on their card.",
            href: rewardsHref,
            cta: "Build rewards",
          },
        ]
      : []),
  ];

  return (
    <Card className="mb-6 p-6">
      <h2 className="font-display text-xl tracking-tight text-offwhite">
        Welcome, let&apos;s get your shop set up
      </h2>
      <p className="mt-1 text-sm text-muted">
        {rewardsEnabled
          ? "Your dashboard fills in as clients book and earn rewards. Three quick steps:"
          : "Your dashboard fills in as clients book. Two quick steps:"}
      </p>
      <ol className="mt-5 flex flex-col gap-4">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                s.done
                  ? "bg-emerald-soft/15 text-emerald-soft"
                  : "bg-gold/15 text-gold"
              }`}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-offwhite">{s.title}</p>
              <p className="mt-0.5 text-xs text-muted">{s.body}</p>
            </div>
            {s.href && !s.done && (
              <Link
                href={s.href}
                className="shrink-0 self-center rounded-full border border-subtle px-3 py-1.5 text-xs text-offwhite transition-colors duration-150 ease-out hover:bg-charcoal-700"
              >
                {s.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
