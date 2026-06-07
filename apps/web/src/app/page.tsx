import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";
import { LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-xs uppercase tracking-[0.25em] text-gold">{APP_NAME}</p>
      <h1 className="mt-4 max-w-2xl font-display text-5xl leading-tight tracking-tight sm:text-6xl">
        Keep your chair full.
      </h1>
      <p className="mt-5 max-w-xl text-lg text-muted">
        Automated loyalty punch cards and smart rebooking texts for barbershops,
        built on top of your Acuity scheduling. No paper cards, no manual
        follow-up.
      </p>

      <div className="mt-8 flex items-center gap-4">
        <LinkButton href="/signup">Get started</LinkButton>
        <Link
          href="/login"
          className="rounded-full border border-subtle px-6 py-3 text-sm font-medium text-offwhite hover:bg-charcoal-700"
        >
          Sign in
        </Link>
      </div>

      {/* Rewards-card preview */}
      <Card className="mt-16 w-full max-w-sm p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          Drick&apos;s Barbershop
        </p>
        <div className="mt-3 font-display text-6xl text-gold leading-none">
          7<span className="text-2xl text-muted">/10</span>
        </div>
        <p className="mt-2 text-sm text-muted">3 more cuts to your Free Cut</p>
        <div className="mt-5 grid grid-cols-5 gap-2">
          {Array.from({ length: 10 }, (_, i) => (
            <div
              key={i}
              className={
                i < 7
                  ? "aspect-square rounded-full bg-gold"
                  : "aspect-square rounded-full border border-subtle bg-charcoal-700"
              }
            />
          ))}
        </div>
      </Card>

      <p className="mt-10 text-xs text-muted">Built for barbers.</p>
    </main>
  );
}
