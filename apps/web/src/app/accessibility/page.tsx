import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import { A, H2, LegalShell, P, SUPPORT_EMAIL, UL } from "@/components/legal/Legal";

export const metadata: Metadata = {
  title: "Accessibility",
  description: `${APP_NAME}'s accessibility statement: our WCAG 2.1 AA commitment, what we've built, and how to reach us if something isn't working for you.`,
};

/**
 * Public accessibility statement (linked from the marketing footers). An
 * honest, plain-language commitment: the standard we target, what's in place,
 * and a real feedback channel — the three things an ADA statement needs.
 */
export default function AccessibilityPage() {
  return (
    <LegalShell
      title="Accessibility"
      intro={
        <P>
          {APP_NAME} is how customers book appointments, join waitlists, and
          track rewards at the shops we serve — so it has to work for everyone,
          including people who use screen readers, keyboard navigation, voice
          control, or magnification. We design and test toward{" "}
          <A href="https://www.w3.org/TR/WCAG21/">
            WCAG 2.1 Level AA
          </A>{" "}
          across our public pages and booking flows.
        </P>
      }
    >
      <H2>What we do</H2>
      <UL>
        <li>
          Every interactive control — service pickers, time slots, forms,
          toggles — is a real, keyboard-operable element with its state exposed
          to assistive technology.
        </li>
        <li>
          Form errors and confirmations are announced to screen readers, not
          just shown in color.
        </li>
        <li>
          Pages keep a visible keyboard-focus indicator, support pinch-zoom and
          text resizing, and respect your reduced-motion preference.
        </li>
        <li>
          Shops customize their pages&apos; colors; we derive text colors from
          those choices so buttons and labels stay readable.
        </li>
        <li>
          A &ldquo;Skip to content&rdquo; link lets keyboard users bypass
          navigation on every page.
        </li>
      </UL>

      <H2>Known limitations</H2>
      <P>
        Some shop-uploaded content (like photo galleries) depends on what the
        shop provides, and a small number of dashboard charts summarize their
        data in text rather than exposing every point. We review these areas as
        the product evolves.
      </P>

      <H2>Tell us if something isn&apos;t working</H2>
      <P>
        If any part of {APP_NAME} is hard to use with assistive technology —
        booking a time, checking in, using your rewards page — email{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A> with the page
        and what happened. Accessibility reports go to the front of the queue,
        and we&apos;ll work with you to complete whatever you were trying to do
        in the meantime.
      </P>
    </LegalShell>
  );
}
