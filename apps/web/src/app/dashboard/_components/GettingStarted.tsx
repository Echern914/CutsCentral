import Link from "next/link";
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
}: {
  connected: boolean;
  hasClients: boolean;
}) {
  if (hasClients) return null;

  const steps = [
    {
      done: connected,
      title: connected ? "Acuity connected" : "Connect your booking calendar",
      body: connected
        ? "Your appointments will sync automatically as clients book."
        : "Link Acuity so your clients and visits import automatically.",
      href: connected ? undefined : "/onboarding/connect",
      cta: "Connect Acuity",
    },
    {
      done: false,
      title: "Add a client or import history",
      body: connected
        ? "No appointments yet? Add a walk-in by hand to start a punch card."
        : "Once connected, your history imports. Or add a walk-in by hand now.",
      href: "/dashboard/clients",
      cta: "Go to Clients",
    },
    {
      done: false,
      title: "Set up your rewards",
      body: "Decide how many visits earn a reward, and clients see it on their card.",
      href: "/dashboard/rewards",
      cta: "Build rewards",
    },
  ];

  return (
    <Card className="mb-6 p-6">
      <h2 className="font-display text-xl tracking-tight text-offwhite">
        Welcome, let&apos;s get your shop set up
      </h2>
      <p className="mt-1 text-sm text-muted">
        Your dashboard fills in as clients book and earn rewards. Three quick steps:
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
