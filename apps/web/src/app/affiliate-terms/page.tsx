import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import { AFFILIATE_POLICY, AFFILIATE_TERMS_VERSION } from "@chairback/config/affiliateProgram";
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
 * The versioned text an affiliate accepts when they sign up. Every number
 * here is read from the policy object the engine enforces, so this page can
 * never promise a window or a hold the code does not keep. The version is the
 * one the API refuses anything older than.
 */
export default function AffiliateTermsPage() {
  const p = AFFILIATE_POLICY;
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
        account through that link and goes on to pay for the service, you earn a credit
        toward your own {APP_NAME} subscription. One business earns one credit, once.
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

      <H2>3. Earning a month off</H2>
      <UL>
        <li>
          A referred business qualifies after{" "}
          <Strong>{p.qualification.qualifyingInvoices} successful, non-zero payments</Strong>{" "}
          of its base subscription. Distinct invoices count; a retried or replayed payment
          does not count twice.
        </li>
        <li>
          Your credit becomes available <Strong>{p.qualification.holdDaysAfterSecond} days</Strong>{" "}
          after that second payment. It is worth one month of your own base subscription
          at that time, and it is applied to a future {APP_NAME} invoice automatically.
        </li>
        <li>
          An available credit expires{" "}
          <Strong>{p.reward.expiryMonthsAfterAvailable} months</Strong> after it becomes
          available if it has not been applied.
        </li>
        <li>
          More than {p.review.rollingYearQualifiedThreshold} qualified referrals in a rolling
          year puts further credits on hold for a review. Held is not lost.
        </li>
      </UL>

      <H2>4. What a credit is not</H2>
      <P>
        Credits are never cash, are not transferable, cannot be refunded, and apply only
        to your base subscription. The receptionist add-on, tax, text-message usage,
        processing fees and one-time purchases are excluded. If you stop subscribing, an
        unused credit has nothing to apply to.
      </P>

      <H2>5. Reversals</H2>
      <P>
        If a referred business&rsquo;s qualifying payment is refunded, disputed, or credited
        back before your credit is applied, the credit is reversed. If that happens after
        it was applied, we record an adjustment against future credits. Your card is never
        charged.
      </P>

      <H2>6. Telling people you are an affiliate</H2>
      <P>
        Wherever you share your link, say plainly that you are a {APP_NAME} affiliate and
        earn a credit when someone signs up through it. Every template we give you carries
        that line; keep it in. Do not describe {APP_NAME} in ways that are untrue, do not
        run paid ads on our name, and do not send unsolicited messages.
      </P>

      <H2>7. Suspension</H2>
      <P>
        We may pause your link for a terms issue, suspected abuse, or a review. A paused
        link earns no new attribution. Your history, your existing referrals and your
        earned credits are kept.
      </P>

      <H2>8. Changes</H2>
      <P>
        These terms are versioned. If they change, you will be asked to accept the new
        version before anything new applies to you; what you already earned stays under
        the version you accepted.
      </P>

      <Notice>
        Questions about the program go to <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
      </Notice>
    </LegalShell>
  );
}
