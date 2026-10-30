import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import {
  AFFILIATE_POLICY,
  AFFILIATE_TERMS_VERSION,
  formatCreditUsd,
} from "@chairback/config/affiliateProgram";
import { HideInNativeApp } from "@/components/HideInNativeApp";
import { ShowInNativeApp } from "@/components/ShowInNativeApp";
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

/**
 * A credit amount: the figure on the web, words inside the native app. The
 * Affiliates tab links here from inside the iOS app, and App Store Guideline
 * 3.1.1 keeps dollar figures out of the app's WebView.
 */
function Amount({ cents }: { cents: number }) {
  return (
    <>
      <HideInNativeApp>
        <Strong>{formatCreditUsd(cents)}</Strong>
      </HideInNativeApp>
      <ShowInNativeApp>the amount shown on our website</ShowInNativeApp>
    </>
  );
}

/**
 * The versioned text an affiliate accepts when they sign up. Every number
 * here is read from the policy object the engine enforces, so this page can
 * never promise a window, a hold or an amount the code does not keep. The
 * version is the one the API refuses anything older than.
 *
 * v2 (2026-10-30): rewards become account credit by default - a sign-up
 * credit on a referred business's first paid invoice, then a monthly credit
 * for each later one - with a month off per business as the alternative.
 * Rewards earned under v1 are honoured under v1's rules (section 10).
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
        account through that link and goes on to pay for the service, you earn rewards
        toward your own {APP_NAME} subscription. Every reward is {APP_NAME} account
        credit. It is never cash.
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

      <H2>3. Choosing how you are rewarded</H2>
      <P>
        Your account has one reward style: <Strong>account credit</Strong> (the default,
        section 4) or <Strong>a month off per business</Strong> (section 5). You can switch
        from your Affiliates tab at any time. A switch applies only to rewards earned after
        it; a reward already earned keeps the style it was earned under.
      </P>

      <H2>4. Account credit</H2>
      <UL>
        <li>
          When a referred business pays its <Strong>first</Strong> successful, non-zero
          invoice for its base {APP_NAME} subscription, you earn a sign-up credit of{" "}
          <Amount cents={p.dollarCredit.signupCents} />. Creating an account, a free trial,
          or a zero-amount invoice earns nothing.
        </li>
        <li>
          For <Strong>every later</Strong> successful, non-zero base-subscription invoice
          that business pays, you earn a monthly credit of{" "}
          <Amount cents={p.dollarCredit.monthlyCents} />, for as long as it keeps paying.
          When it stops paying, the monthly credit stops.
        </li>
        <li>
          Each invoice earns at most once. A retried, replayed or duplicated payment never
          earns twice.
        </li>
        <li>
          Each credit becomes available <Strong>{hold} days</Strong> after the payment that
          earned it, and comes off your future {APP_NAME} invoices automatically.
        </li>
        <li>
          Account credit does not expire. If you have no active paid {APP_NAME}{" "}
          subscription, it waits until you do.
        </li>
        <li>
          More than {p.review.rollingYearQualifiedThreshold} new businesses in a rolling
          year puts further sign-up credits on hold for a review. Held is not lost.
        </li>
      </UL>

      <H2>5. A month off per business</H2>
      <UL>
        <li>
          A referred business qualifies after{" "}
          <Strong>{p.qualification.qualifyingInvoices} successful, non-zero payments</Strong>{" "}
          of its base subscription. Distinct invoices count; a retried or replayed payment
          does not count twice. One business earns one month off, once.
        </li>
        <li>
          The month off becomes available <Strong>{hold} days</Strong> after that second
          payment. It is worth one month of your own base subscription at that time, and it
          is applied to a future {APP_NAME} invoice automatically. It covers the base
          subscription only: the receptionist add-on, tax, text-message usage, processing
          fees and one-time purchases are excluded.
        </li>
        <li>
          An available month off expires{" "}
          <Strong>{p.reward.expiryMonthsAfterAvailable} months</Strong> after it becomes
          available if it has not been applied.
        </li>
        <li>
          More than {p.review.rollingYearQualifiedThreshold} qualified referrals in a rolling
          year puts further months on hold for a review. Held is not lost.
        </li>
      </UL>

      <H2>6. What a reward is not</H2>
      <P>
        Rewards are {APP_NAME} account credit only. They are never paid out as cash, have
        no cash value, are not transferable, and cannot be refunded, sold or exchanged.
        They can only reduce what you owe {APP_NAME}.
      </P>

      <H2>7. Reversals</H2>
      <P>
        If the payment that earned a reward is refunded, disputed (a chargeback), or
        credited back before the reward is applied, that reward is reversed. Your card is
        never charged for a reversal; if the reward had already been applied, we may reduce
        rewards you earn later by the same amount.
      </P>

      <H2>8. Telling people you are an affiliate</H2>
      <P>
        Wherever you share your link, say plainly that you are a {APP_NAME} affiliate and
        earn credit when someone signs up through it. Every template we give you carries
        that line; keep it in. Do not describe {APP_NAME} in ways that are untrue, do not
        run paid ads on our name, and do not send unsolicited messages.
      </P>

      <H2>9. Suspension</H2>
      <P>
        We may pause your link for a terms issue, suspected abuse, or a review. A paused
        link earns no new attribution. Your history, your existing referrals and your
        earned rewards are kept.
      </P>

      <H2>10. Changes, and ending the program</H2>
      <P>
        {APP_NAME} may change the program, its rewards or these terms, or end the program,
        going forward at any time. These terms are versioned: if they change, you will be
        asked to accept the new version before anything new applies to you. Rewards you
        earned before a change, or before the program ends, are honoured under the version
        you had accepted when you earned them. That includes rewards earned under version
        v1, which keep v1&rsquo;s rules.
      </P>

      <Notice>
        Questions about the program go to <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
      </Notice>
    </LegalShell>
  );
}
