import Link from "next/link";
import { APP_NAME } from "@chairback/config/constants";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { BrandLockup } from "./BrandMark";

/**
 * The website footer: the homepage, /pricing and every /for/<vertical> page.
 * (The legal pages keep their own short link row: it sits inside the policy
 * text, which is filed with the carriers.)
 *
 * Pricing and the sign-up door are hidden in the iOS app (App Store 3.1.1),
 * the same rule the header and the pricing grid follow.
 */

const LINK =
  "inline-flex min-h-[44px] items-center text-muted transition-colors duration-150 ease-out hover:text-offwhite";

const VERTICALS = [
  ["/for/salons", "Hair salons"],
  ["/for/nails", "Nail studios"],
  ["/for/lashes", "Lash & brow artists"],
  ["/for/spas", "Spas & skincare"],
  ["/for/tattoo", "Tattoo studios"],
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-subtle">
      {/* The help bubble (HelpBubble.tsx) floats over the bottom-right corner
          at every width, so the last line needs room to scroll clear of it
          until the max-w-6xl column stops reaching that corner (xl). */}
      <div className="mx-auto w-full max-w-6xl px-6 pb-28 pt-12 sm:pb-24 xl:pb-8">
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:gap-x-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div className="col-span-2 min-w-0 lg:col-span-1">
            <BrandLockup size="sm" />
            <p className="mt-2 max-w-xs text-sm text-muted">
              Booking, payments and rewards for independent shops.
            </p>
          </div>

          <FooterColumn title="Product">
            <Link href="/#features" className={LINK}>
              Features
            </Link>
            <HideInNativeApp>
              <Link href="/pricing" className={LINK}>
                Pricing
              </Link>
            </HideInNativeApp>
            <Link href="/demo" className={LINK}>
              See the demo
            </Link>
            <HideInNativeApp>
              <Link href="/login" className={LINK}>
                Sign in
              </Link>
            </HideInNativeApp>
          </FooterColumn>

          <FooterColumn title="Built for">
            {VERTICALS.map(([href, label]) => (
              <Link key={href} href={href} className={LINK}>
                {label}
              </Link>
            ))}
          </FooterColumn>

          <FooterColumn title="Help">
            <Link href="/support" className={LINK}>
              Help center
            </Link>
            <a href="mailto:support@getchairback.com" className={LINK}>
              Contact
            </a>
          </FooterColumn>

          <FooterColumn title="Legal">
            <Link href="/terms" className={LINK}>
              Terms
            </Link>
            <Link href="/privacy" className={LINK}>
              Privacy
            </Link>
            <Link href="/sms" className={LINK}>
              SMS Policy
            </Link>
            <Link href="/accessibility" className={LINK}>
              Accessibility
            </Link>
          </FooterColumn>
        </div>

        <div className="mt-10 flex flex-col gap-x-6 gap-y-1 border-t border-subtle pt-5 text-sm text-muted sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <span>
            © {new Date().getFullYear()} {APP_NAME}
          </span>
          <span>
            Made by <span className="font-semibold text-offwhite">ECproductlab</span>
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <nav aria-label={title} className="flex min-w-0 flex-col text-sm">
      <p className="mb-1 font-semibold text-offwhite">{title}</p>
      {children}
    </nav>
  );
}
