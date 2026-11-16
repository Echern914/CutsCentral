import Link from "next/link";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { BrandLockup } from "./BrandMark";

/**
 * The website header, shared by the homepage and /pricing.
 *
 * Pricing, Sign in and Start free are hidden in the iOS app (App Store
 * 3.1.1): /signup is a business-registration door. No in-app surface links
 * to these pages, but gating keeps them safe if one ever does.
 */

const NAV =
  "hidden min-h-[44px] items-center px-2 text-[15px] font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite sm:inline-flex";

export function SiteHeader({ signupHref = "/signup" }: { signupHref?: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-subtle bg-charcoal-900/90 backdrop-blur">
      <div className="mx-auto flex min-h-[64px] w-full max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <div className="mr-auto">
          <BrandLockup />
        </div>
        <nav aria-label="Primary" className="flex items-center gap-1 sm:gap-4">
          <Link href="/#features" className={NAV}>
            Features
          </Link>
          <HideInNativeApp>
            <Link href="/pricing" className={NAV}>
              Pricing
            </Link>
          </HideInNativeApp>
          <HideInNativeApp>
            <Link
              href="/login"
              className="inline-flex min-h-[44px] items-center px-2 text-[15px] font-medium text-muted transition-colors duration-150 ease-out hover:text-offwhite"
            >
              Sign in
            </Link>
          </HideInNativeApp>
          <HideInNativeApp>
            <Link
              href={signupHref}
              className="inline-flex min-h-[44px] items-center rounded-xl bg-primary px-4 text-[15px] font-semibold text-on-primary transition-colors duration-150 ease-out hover:bg-primary/90"
            >
              Start free
            </Link>
          </HideInNativeApp>
        </nav>
      </div>
    </header>
  );
}
