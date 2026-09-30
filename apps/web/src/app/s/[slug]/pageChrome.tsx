"use client";

import { motion } from "framer-motion";
import { APP_NAME } from "@chairback/config/constants";
import { DEMO } from "@chairback/config/demo";
import { fadeUp } from "@/components/motion/variants";
import { BackToDashboard } from "@/components/BackToDashboard";
import { CustomerBack } from "@/components/CustomerBack";
import { DemoTour } from "@/components/tour/DemoTour";
import { TextToBook } from "@/components/TextToBook";
import { RequestForm } from "./RequestForm";
import type { Layout, Theme } from "./pageSections";
import type { ShopPageData } from "./page";

/**
 * The parts of the public page every design shares: the corner back buttons,
 * the text-to-book line, the booking call to action and the footer. Moved here
 * unchanged from ShopPageClient, so the classic page renders exactly what it
 * did and the other designs (designs/) can't drift from it.
 */

/** Demo tour + the corner back buttons (barber-only and customer-only). */
export function ShopChrome({
  data,
  preview,
  theme,
  layout,
}: {
  data: ShopPageData;
  preview: boolean;
  theme: Theme;
  layout: Layout;
}) {
  return (
    <>
      {/* Guided client-experience tour — demo tenant only, never the editor
          preview. Step anchors are the data-tour attributes below (keep in
          sync with packages/config/src/demoTour.ts). */}
      {!preview && data.slug === DEMO.SHOP_SLUG && <DemoTour route="shop" />}
      {/* Barber-only "back to dashboard" - shows only when opened from the
          dashboard (?from=dashboard), never for customers, never in the editor
          preview. */}
      {!preview && (
        <BackToDashboard
          fallbackHref="/dashboard/site"
          className="fixed left-4 top-4 z-20 px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur transition-transform duration-200 ease-out hover:scale-[1.03]"
          style={{
            backgroundColor: theme.surface,
            border: `1px solid ${theme.border}`,
            color: theme.text,
            borderRadius: layout.buttonRadius,
          }}
        />
      )}
      {/* Customer "← Back" — in the app WebView this page has no browser
          chrome, so arriving from the rewards page ("More from {shop}") was a
          dead end. Same spot as BackToDashboard; the two never both render
          (CustomerBack hides itself under ?from=dashboard). */}
      {!preview && (
        <CustomerBack
          className="fixed left-4 top-4 z-20 px-3.5 py-2 text-xs font-medium shadow-lg backdrop-blur transition-transform duration-200 ease-out hover:scale-[1.03]"
          style={{
            backgroundColor: theme.surface,
            border: `1px solid ${theme.border}`,
            color: theme.text,
            borderRadius: layout.buttonRadius,
          }}
        />
      )}
    </>
  );
}

/** The AI text line, when the shop has a receptionist a stranger can reach. */
export function TextToBookBlock({
  data,
  accent,
  theme,
  className = "mt-6",
}: {
  data: ShopPageData;
  accent: string;
  theme: Theme;
  className?: string;
}) {
  // The AI text line, above the booking CTA: for a lot of clients texting IS
  // the booking flow, and it answers "are you open Saturday?" which no button
  // on this page can. Renders only when the shop has a reachable receptionist
  // (the API nulls the number otherwise).
  if (!data.receptionistNumber) return null;
  return (
    <motion.div variants={fadeUp} className={className}>
      <TextToBook
        number={data.receptionistNumber}
        shopName={data.name}
        accent={accent}
        muted={theme.muted}
        text={theme.text}
      />
    </motion.div>
  );
}

/**
 * Primary CTA. Native booking and the lead form are mutually exclusive: native
 * is real self-serve booking, so it replaces the request form.
 */
export function PrimaryCta({
  data,
  preview,
  theme,
  layout,
  accent,
  bookHref,
  hasBooking,
  showRequestForm,
  className = "mt-6",
}: {
  data: ShopPageData;
  preview: boolean;
  theme: Theme;
  layout: Layout;
  accent: string;
  bookHref: string | null;
  hasBooking: boolean;
  showRequestForm: boolean;
  className?: string;
}) {
  return (
    <motion.div variants={fadeUp} className={className} data-tour="book-cta">
      {showRequestForm ? (
        <>
          <RequestForm
            slug={data.slug}
            shopName={data.name}
            accent={accent}
            preview={preview}
            theme={{
              surface: theme.surface,
              border: theme.border,
              muted: theme.muted,
              scheme: theme.scheme,
              radius: layout.radius,
              buttonRadius: layout.buttonRadius,
            }}
          />
          {/* The "or book online" shortcut only makes sense with a real link. */}
          {hasBooking && (
            <a
              href={preview ? undefined : bookHref ?? undefined}
              onClick={preview ? (e) => e.preventDefault() : undefined}
              className="mt-3 block text-center text-xs underline-offset-2 hover:underline"
              style={{ color: theme.muted }}
            >
              Or book online instantly →
            </a>
          )}
        </>
      ) : hasBooking ? (
        <a
          href={preview ? undefined : bookHref ?? undefined}
          onClick={preview ? (e) => e.preventDefault() : undefined}
          className="block w-full py-3.5 text-center text-sm font-semibold transition-transform duration-200 ease-out hover:scale-[1.01]"
          style={{
            backgroundColor: accent,
            color: theme.scheme === "light" ? "#FFFFFF" : "#101012",
            boxShadow: `0 8px 30px -10px ${accent}AA`,
            borderRadius: layout.buttonRadius,
          }}
        >
          Book an appointment
        </a>
      ) : null}
    </motion.div>
  );
}

/**
 * Bottom CTA + footer. Flex column so the pill and the powered-by line stack +
 * center reliably — as inline-block siblings they crowded onto one line when
 * both fit.
 */
export function ShopFooter({
  data,
  preview,
  inApp,
  theme,
  layout,
  accent,
  bookHref,
  hasBooking,
  rewardsHref,
}: {
  data: ShopPageData;
  preview: boolean;
  /** useIsNativeApp: null until known, which reads as "not in the app". */
  inApp: boolean | null;
  theme: Theme;
  layout: Layout;
  accent: string;
  bookHref: string | null;
  hasBooking: boolean;
  rewardsHref?: string;
}) {
  return (
    <motion.footer variants={fadeUp} className="mt-10 flex flex-col items-center gap-6 text-center">
      {hasBooking && (
        <a
          href={preview ? undefined : bookHref ?? undefined}
          onClick={preview ? (e) => e.preventDefault() : undefined}
          className="px-8 py-3 text-sm font-semibold"
          style={{ border: `1px solid ${accent}`, color: accent, borderRadius: layout.buttonRadius }}
        >
          Book with {data.name}
        </a>
      )}
      {/* The rewards-recovery door, only when this visitor DIDN'T arrive
          through their rewards link (token-holders get "Your rewards"
          above) and isn't inside the app (where their rewards session
          already exists). Preview keeps it inert like every footer link.
          /my-rewards is shop-agnostic - the link says nothing about who
          this customer is anywhere else. */}
      {!rewardsHref && !inApp && (
        <a
          href={preview ? undefined : "/my-rewards"}
          onClick={preview ? (e) => e.preventDefault() : undefined}
          className="text-[11px] underline-offset-2 hover:underline"
          style={{ color: theme.muted }}
        >
          Lost your rewards link? Find my rewards
        </a>
      )}
      {/* Growth loop: every shop page quietly markets the platform. Inside
          the iOS app it must be INERT text - the marketing site it links to
          leads to business signup, which is forbidden in-app (3.1.1). The
          site-editor preview keeps the full (already inert) link so the
          barber sees exactly what browser visitors see, even when editing
          from inside the app. */}
      {inApp && !preview ? (
        <span className="text-[11px]" style={{ color: theme.muted }}>
          Powered by {APP_NAME}
        </span>
      ) : (
        <a
          href={preview ? undefined : `/?ref=${encodeURIComponent(data.slug)}`}
          onClick={preview ? (e) => e.preventDefault() : undefined}
          className="text-[11px] underline-offset-2 hover:underline"
          style={{ color: theme.muted }}
        >
          Powered by {APP_NAME}, loyalty for your shop
        </a>
      )}
    </motion.footer>
  );
}
