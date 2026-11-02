import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import {
  AFFILIATE_POLICY,
  AFFILIATE_TERMS_VERSION,
  formatCreditUsd,
} from "@chairback/config/affiliateProgram";
import {
  A,
  H2,
  LEGAL_ENTITY,
  LegalShell,
  Notice,
  P,
  Strong,
  SUPPORT_EMAIL,
  UL,
} from "@/components/legal/Legal";

export const metadata: Metadata = {
  title: `Affiliate Program Terms — ${APP_NAME}`,
  description: `The terms of the ${APP_NAME} affiliate program.`,
  robots: { index: false },
};

/** An amount, shown the same on the web and inside the app: what an
 *  affiliate gets paid is not something anyone buys in the app. */
function Amount({ cents }: { cents: number }) {
  return <Strong>{formatCreditUsd(cents)}</Strong>;
}

/**
 * The versioned text an affiliate accepts when they sign up. Every number
 * here is read from the policy object the engine enforces, so this page can
 * never promise a window, a hold or an amount the code does not keep. The
 * version is the one the API refuses anything older than.
 *
 * NEVER EDIT A VERSION IN PLACE: copy it to ./v<N>/page.tsx first, then
 * write the new one here.
 *
 * v3 (2026-11-02): one reward for everyone - get paid a sign-up amount on a
 * referred business's first paid invoice, then a monthly amount for each
 * later one, paid for now as account credit. The month-off choice is gone;
 * a month off already earned is honoured (section 5). v2 is at ./v2.
 */
export default function AffiliateTermsPage() {
  const p = AFFILIATE_POLICY;
  const hold = p.qualification.holdDaysAfterSecond;
  return (
    <LegalShell
      title="Affiliate Program Terms"
      intro={
        <P>
          These terms (version <Strong>{AFFILIATE_TERMS_VERSION}</Strong>) govern the{" "}
          {APP_NAME} affiliate program run by {LEGAL_ENTITY}. They sit alongside our{" "}
          <A href="/terms">Terms of Service</A> and <A href="/privacy">Privacy Policy</A>.
          By signing up you accept them as written on the day you sign up.
        </P>
      }
    >
      <H2>1. What the program is</H2>
      <P>
        You get a personal link. When a business you send to {APP_NAME} creates an
        account through that link and goes on to pay for the service, you get paid through
        the {APP_NAME} affiliate program (section 3). Under this version you are paid as{" "}
        {APP_NAME} account credit on your own {APP_NAME} bill (section 4).
      </P>

      <H2>2. Your link, and who counts as yours</H2>
      <UL>
        <li>
          A business is attributed to you when it creates its {APP_NAME} account within{" "}
          <Strong>{p.attribution.windowDays} days</Strong> of opening your link, or after
          typing your code during sign-up. A code typed at sign-up beats a link.
        </li>
        <li>
          Attribution locks the moment the business is created. After that, only{" "}
          {APP_NAME} may change it, within {p.attribution.adminCorrectionWindowDays} days,
          for a written reason we keep on record.
        </li>
        <li>
          A business belongs to at most one affiliate. If it already has a referrer under
          our earlier referral program, that program keeps it.
        </li>
        <li>You cannot refer yourself, your own shop, or an account you control.</li>
      </UL>

      <H2>3. What you get paid</H2>
      <UL>
        <li>
          When a referred business pays its <Strong>first</Strong> successful, non-zero
          invoice for its base {APP_NAME} subscription, you earn a sign-up payment of{" "}
          <Amount cents={p.dollarCredit.signupCents} />. Creating an account, a free trial,
          or a zero-amount invoice earns nothing.
        </li>
        <li>
          For <Strong>every later</Strong> successful, non-zero base-subscription invoice
          that business pays, you earn a monthly payment of{" "}
          <Amount cents={p.dollarCredit.monthlyCents} />, for as long as it keeps paying.
          When it stops paying, the monthly payment stops.
        </li>
        <li>There is no cap on how many businesses you bring on.</li>
        <li>
          Each invoice earns at most once. A retried, replayed or duplicated payment never
          earns twice.
        </li>
        <li>
          More than {p.review.rollingYearQualifiedThreshold} new businesses in a rolling
          year puts further sign-up payments on hold for a review. Held is not lost.
        </li>
      </UL>

      <H2>4. How you are paid</H2>
      <UL>
        <li>
          Each payment becomes yours <Strong>{hold} days</Strong> after the invoice that
          earned it.
        </li>
        <li>
          Under this version it is paid as {APP_NAME} account credit, which comes off your
          future {APP_NAME} invoices automatically. It does not expire. If you have no active
          paid {APP_NAME} subscription, it waits until you do.
        </li>
        <li>
          Account credit is not transferable and cannot be sold or exchanged, and it is not
          paid out as cash under this version. If we add another way to be paid, these terms
          will move to a new version that says so.
        </li>
      </UL>

      <H2>5. Months off earned before this version</H2>
      <P>
        Earlier versions offered a month off per business instead. A month off you had
        already earned when this version took effect is honoured under the version you
        earned it under: it is applied to a future {APP_NAME} invoice automatically, and an
        available month off expires{" "}
        <Strong>{p.reward.expiryMonthsAfterAvailable} months</Strong> after it became
        available if it has not been applied. From this version on, every business you
        bring on earns the payments in section 3.
      </P>

      <H2>6. Your own bill</H2>
      <P>
        Being an affiliate does not change what your own {APP_NAME} plan costs or what it
        includes. Account credit only reduces what you owe {APP_NAME}.
      </P>

      <H2>7. Reversals</H2>
      <P>
        If the invoice that earned a payment is refunded, disputed (a chargeback), or
        credited back before that payment is applied, it is reversed. Your card is never
        charged for a reversal; if it had already been applied, we may reduce payments you
        earn later by the same amount.
      </P>

      <H2>8. Telling people you are an affiliate</H2>
      <P>
        Wherever you share your link, say plainly that you are a {APP_NAME} affiliate and
        get paid when someone signs up through it. Every template we give you carries
        that line; keep it in. Do not describe {APP_NAME} in ways that are untrue, do not
        run paid ads on our name, and do not send unsolicited messages.
      </P>

      <H2>9. Suspension</H2>
      <P>
        We may pause your link for a terms issue, suspected abuse, or a review. A paused
        link earns no new attribution. Your history, your existing referrals and what you
        have already earned are kept.
      </P>

      <H2>10. Changes, and ending the program</H2>
      <P>
        {APP_NAME} may change the program, what it pays or these terms, or end the program,
        going forward at any time. These terms are versioned, and each earlier version stays
        readable (<A href="/affiliate-terms/v2">version v2</A>). Anything you earned before a
        change, or before the program ends, is honoured under the version in force when you
        earned it.
      </P>

      <Notice>
        Questions about the program go to <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
      </Notice>
    </LegalShell>
  );
}
