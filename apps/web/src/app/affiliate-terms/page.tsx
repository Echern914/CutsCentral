import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import {
  AFFILIATE_POLICY,
  AFFILIATE_TERMS_VERSION,
  bpsToPercent,
  commissionPeriodPhrase,
  formatUsdCents,
  ordinal,
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

/** The day the commission terms (v2) were published. The owner moves it.
 *  Not exported: a Next page file may only export what Next expects. */
const AFFILIATE_TERMS_EFFECTIVE_DATE = "October 26, 2026";

/**
 * The versioned text an affiliate accepts when they sign up. Every number
 * here is read from the policy object the engine enforces
 * (AFFILIATE_POLICY.commission for the money), so this page can never promise
 * a rate, a window or a hold the code does not keep. The version is the one
 * the API refuses anything older than; v1 stays readable at /affiliate-terms/v1.
 *
 * 🔴 RATES AND DOLLARS ARE WEB-ONLY (App Store Guideline 3.1.1): inside the
 * iOS app they sit in HideInNativeApp, and ShowInNativeApp says where to read
 * them - the same pattern the billing page uses.
 */
export default function AffiliateTermsPage() {
  const p = AFFILIATE_POLICY;
  const c = p.commission;
  const q = p.qualification.qualifyingInvoices;
  const period = commissionPeriodPhrase(c.months);
  return (
    <LegalShell
      title="Affiliate Program Terms"
      effectiveDate={AFFILIATE_TERMS_EFFECTIVE_DATE}
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
        account through that link and pays for its plan, you earn a commission on what it
        pays for its {period}. There is no cap on how many businesses you bring in.
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

      <H2>3. What you earn</H2>
      <UL>
        <li>
          You earn a commission on every payment a referred business makes for its base{" "}
          {APP_NAME} plan during its <Strong>first {c.months} months</Strong>, counted from
          its first paid invoice. Payments after that earn nothing.
        </li>
        <li data-testid="terms-rates">
          <HideInNativeApp>
            The commission is <Strong>{bpsToPercent(c.cashBps)}%</Strong> of what the
            business actually paid for its base plan if you take it as cash, or{" "}
            <Strong>{bpsToPercent(c.creditBps)}%</Strong> if you take it as {APP_NAME} bill
            credit.
          </HideInNativeApp>
          <ShowInNativeApp>
            The commission is a percentage of what the business actually paid for its base
            plan, and it is higher if you take it as {APP_NAME} bill credit than as cash.
            The rates are part of these terms: read them at getchairback.com/affiliate-terms
            in your web browser.
          </ShowInNativeApp>
        </li>
        <li>
          You choose cash or credit. Credit is the default until you choose cash. Each
          commission keeps the choice you had when its payment was made; changing your
          choice later applies only to payments after the change.
        </li>
        <li>
          Only the base plan counts. Tax, add-ons (such as the receptionist add-on),
          text-message usage, processing fees, one-time purchases, discounts and coupons,
          and account balance credits are excluded. Commissions are rounded down to the
          cent.
        </li>
        <li>Duplicate or replayed payments never earn twice.</li>
      </UL>

      <H2>4. When a commission becomes payable</H2>
      <UL>
        <li>
          Each commission is held for <Strong>{c.holdDays} days</Strong> after the payment
          it came from.
        </li>
        <li>
          Nothing becomes payable until the referred business has made at least its{" "}
          <Strong>{ordinal(q)} payment</Strong> for its base plan, not refunded, disputed or
          credited back. A business that pays once and leaves earns you nothing.
        </li>
      </UL>

      <H2>5. Payouts</H2>
      <UL>
        <li>
          Cash is paid through Stripe. To receive cash you connect a Stripe account, and
          Stripe collects your tax information and issues tax forms (such as a 1099) where
          the law requires them. Until you have chosen cash and connected an account, your
          commissions are earned as credit.
        </li>
        <li data-testid="terms-minimum">
          <HideInNativeApp>
            Cash is paid once your payable cash comes to at least{" "}
            <Strong>{formatUsdCents(c.minimumCashPayoutCents)}</Strong>. Anything less
            rolls over to the next payout.
          </HideInNativeApp>
          <ShowInNativeApp>
            Cash is paid once your payable cash reaches a minimum; anything less rolls over
            to the next payout. The minimum is shown in these terms on the web.
          </ShowInNativeApp>
        </li>
        <li>
          Credit is applied to your future {APP_NAME} invoices automatically. Commission
          you take as credit stays credit: it is not transferable and cannot be exchanged
          for cash. If you stop subscribing, unused credit has nothing to apply to.
        </li>
        <li>
          We may hold commissions or payouts for review if your account is suspended or we
          see signs of fraud or abuse. Held is not lost: a person reviews it.
        </li>
      </UL>

      <H2>6. Reversals</H2>
      <P>
        If a payment that earned a commission is refunded (in full or in part), disputed,
        or credited back, that commission is reversed. If it was already paid out or
        applied, we deduct it from your future payouts or credits. Your card is never
        charged.
      </P>

      <H2>7. Earlier month-off credits</H2>
      <P>
        Month-off credits you earned under an earlier version of these terms are honoured.
        They keep the rules of the version you accepted (
        <A href="/affiliate-terms/v1">version v1</A>) and are applied to a future{" "}
        {APP_NAME} invoice automatically.
      </P>

      <H2>8. Telling people you are an affiliate</H2>
      <P>
        Wherever you share your link, say plainly that you are a {APP_NAME} affiliate and
        earn a commission when someone signs up through it. Every template we give you
        carries that line; keep it in. Do not describe {APP_NAME} in ways that are untrue,
        do not run paid ads on our name, and do not send unsolicited messages.
      </P>

      <H2>9. Suspension</H2>
      <P>
        We may pause your link for a terms issue, suspected abuse, or a review. A paused
        link earns no new attribution. Your history, your existing referrals, your
        commissions and your earned credits are kept, though commissions may be held for
        review while your link is paused.
      </P>

      <H2>10. Changes</H2>
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
