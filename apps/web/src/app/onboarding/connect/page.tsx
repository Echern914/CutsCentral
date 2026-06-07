import { APP_NAME } from "@chairback/config/constants";
import { API_BASE, apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";

interface ShopStatus {
  connected: boolean;
}

export default async function ConnectPage() {
  const res = await apiGet<ShopStatus>("/api/shops/me");
  const connected = res.data?.connected ?? false;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <p className="text-center text-xs uppercase tracking-[0.2em] text-muted">
        Step 2 of 3
      </p>
      <h1 className="mb-2 mt-2 text-center font-display text-3xl tracking-tight">
        Connect Acuity
      </h1>
      <p className="mb-6 text-center text-sm text-muted">
        Authorize {APP_NAME} to read your appointments. We&apos;ll auto-track
        every visit and start your loyalty engine.
      </p>
      <Card className="flex flex-col items-center gap-4 p-8">
        {connected ? (
          <>
            <p className="text-emerald-soft">Acuity connected</p>
            <LinkButton href="/onboarding/done" className="w-full">
              Continue
            </LinkButton>
          </>
        ) : (
          <>
            {/* Hits the API OAuth start, which redirects to Acuity consent. */}
            <LinkButton href={`${API_BASE}/api/acuity/oauth/start`} className="w-full">
              Connect Acuity
            </LinkButton>
            <a
              href="/onboarding/done"
              className="text-xs text-muted hover:underline"
            >
              Skip for now
            </a>
          </>
        )}
      </Card>
    </main>
  );
}
