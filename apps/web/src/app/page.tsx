import { APP_NAME } from "@chairback/config/constants";
import { Landing } from "@/components/marketing/Landing";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";

export default function LandingPage() {
  return (
    <>
      {/* The marketing site is not part of the iOS app experience: its nav,
          hero, and pricing all funnel to business signup, which must not be
          reachable in-app (App Store Guideline 3.1.1). If a stray link ever
          lands the app shell here, show a neutral brand card instead. */}
      <HideInNativeApp>
        <Landing />
      </HideInNativeApp>
      <ShowInNativeApp>
        <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col items-center justify-center px-6 text-center">
          <p className="text-xs uppercase tracking-[0.25em] text-gold">{APP_NAME}</p>
          <p className="mt-4 text-sm text-muted">
            Loyalty and rebooking for independent shops. Use the role picker in
            the app to open your dashboard or your rewards card.
          </p>
        </main>
      </ShowInNativeApp>
    </>
  );
}
