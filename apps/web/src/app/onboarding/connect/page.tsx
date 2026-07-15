import { APP_NAME } from "@chairback/config/constants";
import { API_BASE, apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";

// Distinct document title per route (WCAG 2.4.2) via the root %s template.
export const metadata = { title: "Connect your booking" };

interface ShopStatus {
  connected: boolean;
}

export default async function ConnectPage() {
  const [shopRes, squareRes] = await Promise.all([
    apiGet<ShopStatus>("/api/shops/me"),
    // Square is optional/dark until configured; treat any non-ok as unavailable.
    apiGet<{ available: boolean }>("/api/square/oauth/status"),
  ]);
  const connected = shopRes.data?.connected ?? false;
  const squareAvailable = Boolean(squareRes.data?.available);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <p className="text-center text-xs uppercase tracking-[0.2em] text-muted">
        Step 2 of 3
      </p>
      <h1 className="mb-2 mt-2 text-center font-display text-3xl tracking-tight">
        Connect your booking
      </h1>
      <p className="mb-6 text-center text-sm text-muted">
        Link the system you already use and {APP_NAME} auto-tracks every visit,
        so loyalty and rebooking just happen. Pick one - you can switch anytime.
      </p>
      <Card className="flex flex-col items-center gap-3 p-8">
        {connected ? (
          <>
            <p className="text-emerald-soft">Booking connected</p>
            <LinkButton href="/onboarding/done" className="w-full">
              Continue
            </LinkButton>
          </>
        ) : (
          <>
            {/* Each hits the API OAuth start, which redirects to the provider's consent. */}
            <LinkButton href={`${API_BASE}/api/acuity/oauth/start`} className="w-full">
              Connect Acuity
            </LinkButton>
            {squareAvailable && (
              <a
                href={`${API_BASE}/api/square/oauth/start`}
                className="inline-flex w-full items-center justify-center rounded-full border border-subtle px-6 py-3 text-sm font-semibold text-offwhite transition-all duration-150 ease-out hover:border-subtle-strong hover:bg-charcoal-700"
              >
                Connect Square
              </a>
            )}
            <a
              href="/dashboard/booking"
              className="text-xs text-muted hover:underline"
            >
              Use {APP_NAME}&apos;s own booking, or your own link
            </a>
            <a
              href="/onboarding/done"
              className="text-xs text-muted hover:underline"
            >
              Not connecting now? Skip and log visits with one tap instead
            </a>
            <p className="text-center text-[11px] leading-relaxed text-muted">
              On Booksy, Fresha, Vagaro, or pen &amp; paper? Everything still
              works: import your client list as a CSV (Clients → Import), then
              tap “Log visit” after each appointment. You can connect a booking
              system later in Settings.
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
