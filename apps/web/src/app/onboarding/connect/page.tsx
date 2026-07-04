import { APP_NAME } from "@chairback/config/constants";
import { API_BASE, apiGet } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { LinkButton } from "@/components/ui/Button";

interface ShopStatus {
  connected: boolean;
}

export default async function ConnectPage() {
  const [shopRes, squareRes, gcalRes] = await Promise.all([
    apiGet<ShopStatus>("/api/shops/me"),
    // Square + Google Calendar are optional/dark until configured; treat any
    // non-ok as unavailable.
    apiGet<{ available: boolean }>("/api/square/oauth/status"),
    apiGet<{ available: boolean }>("/api/gcal/oauth/status"),
  ]);
  const connected = shopRes.data?.connected ?? false;
  const squareAvailable = Boolean(squareRes.data?.available);
  const gcalAvailable = Boolean(gcalRes.data?.available);

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
            {gcalAvailable && (
              <a
                href={`${API_BASE}/api/gcal/oauth/start`}
                className="inline-flex w-full items-center justify-center rounded-full border border-subtle px-6 py-3 text-sm font-semibold text-offwhite transition-all duration-150 ease-out hover:border-subtle-strong hover:bg-charcoal-700"
              >
                Connect Google Calendar
                <span className="ml-1.5 text-xs font-normal text-muted">
                  Booksy, GlossGenius…
                </span>
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
              {gcalAvailable ? (
                <>
                  On Booksy, GlossGenius, or Vagaro? Turn on their Google
                  Calendar sync, then Connect Google Calendar above and visits
                  track automatically. On Fresha or pen &amp; paper? Import your
                  client list as a CSV (Clients → Import) and tap “Log visit”
                  after each appointment.
                </>
              ) : (
                <>
                  On Booksy, Fresha, Vagaro, or pen &amp; paper? Everything still
                  works: import your client list as a CSV (Clients → Import), then
                  tap “Log visit” after each appointment. You can connect a booking
                  system later in Settings.
                </>
              )}
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
