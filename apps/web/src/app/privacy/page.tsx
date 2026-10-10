import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import {
  A,
  H2,
  H3,
  LEGAL_ENTITY,
  LegalShell,
  Notice,
  P,
  PRIVACY_TERMS_EFFECTIVE_DATE,
  PRIVACY_TERMS_UPDATED_DATE,
  Strong,
  SUPPORT_EMAIL,
  UL,
} from "@/components/legal/Legal";

export const metadata: Metadata = {
  title: `Privacy Policy — ${APP_NAME}`,
  description: `How ${APP_NAME} collects, uses, and protects personal information.`,
};

export default function PrivacyPage() {
  return (
    <LegalShell
      title="Privacy Policy"
      effectiveDate={PRIVACY_TERMS_EFFECTIVE_DATE}
      updatedDate={PRIVACY_TERMS_UPDATED_DATE}
      intro={
        <P>
          This Privacy Policy explains how {LEGAL_ENTITY} (“{APP_NAME}”, “we”,
          “us”) collects, uses, and shares personal information when you use our
          websites, dashboards, public shop and booking pages, rewards pages,
          the {APP_NAME} mobile app, text-message and email programs, and
          related services (the “Service”). It is incorporated into our{" "}
          <A href="/terms">Terms of Service</A>.
        </P>
      }
    >
      <H2>1. The two hats we wear</H2>
      <P>
        {APP_NAME} is used by barbershops, salons, and similar personal-care
        businesses (“<Strong>Shops</Strong>”) to take bookings and payments and
        to run loyalty and rebooking programs for their clients (“
        <Strong>Clients</Strong>”). We handle personal information in two
        distinct roles:
      </P>
      <UL>
        <li>
          <Strong>For Shop accounts, Client app accounts, and our own
          websites</Strong>, we decide how data is used — we act as the data
          controller / business.
        </li>
        <li>
          <Strong>For Client Data</Strong> (information about a Shop’s clients —
          names, phone numbers, emails, bookings, visit history, punch
          balances, notes), we process it <em>on behalf of the Shop</em> as a
          service provider / processor. The Shop decides why and how that data
          is used; we follow the Shop’s instructions as expressed through the
          Service.
        </li>
      </UL>
      <Notice>
        If you are a Shop&apos;s client and want your information corrected or
        deleted, the fastest path is to contact that shop directly, or use
        “Delete my data” on the shop’s page. You can also email us at{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A> and we will
        assist or forward your request to your shop.
      </Notice>

      <H2>2. Information we collect</H2>
      <H3>From Shop owners and their team</H3>
      <UL>
        <li>
          <Strong>Account data:</Strong> your name, email address, and a
          password (stored only as a salted hash — we cannot read it). If you
          sign in with Google or Apple, we receive your name, email, and that
          account’s identifier instead of a password.
        </li>
        <li>
          <Strong>Shop profile data:</Strong> shop name, booking link, timezone,
          logo, photos, bio, hours, services and prices, booking policies,
          social handles, themes, reward and promotion configuration, and
          message templates.
        </li>
        <li>
          <Strong>Billing and payout data:</Strong> your subscription is billed
          by Stripe, and payments from your clients are paid out through your
          own Stripe account. We receive your plan, subscription and payout
          status from Stripe; we do not receive or store full card or bank
          account numbers.
        </li>
        <li>
          <Strong>Scheduling integration data:</Strong> if you connect Acuity
          Scheduling or Square, we store encrypted access tokens and sync
          appointment and client records from that account.
        </li>
      </UL>
      <H3>About Clients (on behalf of their Shop)</H3>
      <UL>
        <li>
          Name, phone number, email address, and an optional Instagram handle
          (from the Shop’s scheduling system, entered by the Shop, or entered by
          the Client when booking).
        </li>
        <li>
          Bookings and visit history: dates, times, status, services, add-ons,
          prices (including any price changes and who made them), answers to
          the Shop’s own booking questions, which version of the Shop’s booking
          policy the Client agreed to, waitlist requests, and, for a group
          booking, the names the booker gives for the people in the party.
        </li>
        <li>
          <Strong>Payments:</Strong> when a Client pays a deposit, pays ahead,
          saves a card, leaves a tip, or pays a balance by card after a visit, the card is
          handled by Stripe. We receive the amount, status, card brand and last
          four digits, and refunds — never the full card number. A card is
          saved only when the Client chooses to save it.
        </li>
        <li>
          Loyalty activity: punches earned and redeemed, reward redemptions,
          promotion usage, and visit-cadence estimates derived from visit
          history.
        </li>
        <li>
          Messaging records: the content, time, and delivery status of texts,
          emails, and app notifications sent on the Shop’s behalf, and opt-in
          and opt-out status.
        </li>
        <li>Private notes the Shop records about a client.</li>
      </UL>
      <H3>From Clients who use the {APP_NAME} app</H3>
      <UL>
        <li>
          <Strong>App account:</Strong> the phone number or email address you
          confirm with a one-time code, and the name you give. Your account is
          linked to a Shop’s record of you only when the contact you confirmed
          matches that record unambiguously, or when the Shop gives you your
          own link.
        </li>
        <li>
          <Strong>App data:</Strong> the shops you save or join, your waitlist
          requests, and a notification token for your device if you allow
          notifications.
        </li>
      </UL>
      <H3>Automatically</H3>
      <UL>
        <li>
          <Strong>Log data:</Strong> IP address, browser type, pages requested,
          and timestamps, used for security, rate limiting, and debugging.
        </li>
        <li>
          <Strong>Error reports:</Strong> when something breaks, a report of
          the error is sent to our error-monitoring provider, with personal
          details removed where we can.
        </li>
        <li>
          <Strong>Cookies and on-device storage:</Strong> we use a small number
          of first-party cookies that make the Service work — a signed,
          httpOnly session cookie that keeps Shop accounts signed in, and
          short-lived cookies for sign-in and invitation steps. Booking pages
          can remember a Client’s contact details and the policy versions they
          agreed to <em>in that browser only</em>, so they don’t retype them;
          “Not you?” clears it. The app keeps its session in the device’s
          secure storage.
        </li>
        <li>
          <Strong>Site analytics:</Strong> we use Vercel Web Analytics to count
          page views in aggregate. It does not use cookies or build a profile
          of you.{" "}
          <Strong>
            We do not use advertising cookies or third-party tracking pixels.
          </Strong>
        </li>
      </UL>

      <H2>3. How we use information</H2>
      <UL>
        <li>Provide, operate, secure, and improve the Service.</li>
        <li>
          Take and manage bookings, sync visits from scheduling providers,
          compute punch balances, and render rewards, booking, and public
          pages.
        </li>
        <li>
          Process payments the Client agrees to — deposits, pay-ahead
          bookings, tips, card-on-file charges under the Shop’s policy the
          Client accepted, and refunds — through Stripe.
        </li>
        <li>
          Send booking confirmations, reminders, receipts, and account emails;
          send app notifications and Apple Wallet pass updates the Client
          turned on; and send texts and promotions that Shops initiate or
          configure, enforcing opt-ins and opt-outs and keeping delivery
          records.
        </li>
        <li>
          Offer openings to Clients who joined a Shop’s waitlist or asked to
          hear about them.
        </li>
        <li>
          Communicate with Shop owners about their account, billing, and
          important Service changes.
        </li>
        <li>
          Detect, prevent, and respond to fraud, abuse, and security incidents.
        </li>
        <li>Comply with legal obligations.</li>
      </UL>

      <H2>4. Text messaging data — no marketing use, ever</H2>
      <Notice>
        No mobile information will be shared with third parties or affiliates
        for marketing or promotional purposes. Mobile phone numbers and SMS
        opt-in data and consent are never sold, rented, or shared with any
        third party for their own marketing. Text-messaging originator opt-in
        data and consent will not be shared with any third parties, except with
        vendors that help us deliver messages (such as our SMS provider), and
        only for that purpose.
      </Notice>
      <P>
        Clients can opt out of texts at any time by replying STOP, and can get
        help by replying HELP or emailing{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>. Opt-outs are
        enforced platform-wide for the opted-out phone number. See the{" "}
        <A href="/sms">SMS Messaging Policy</A>.
      </P>
      <P>
        Promotional emails are sent only to Clients who agreed to receive
        them, and each one carries an unsubscribe link. Emails about a booking
        you made (confirmations, changes, receipts) are not promotional. App
        notifications can be turned off in your phone’s settings at any time.
      </P>

      <H2>5. How we share information</H2>
      <P>
        <Strong>We do not sell personal information</Strong>, and we do not
        share it for cross-context behavioral advertising. We share information
        only with:
      </P>
      <UL>
        <li>
          <Strong>Service providers (subprocessors)</Strong> that host and run
          the Service under contractual confidentiality obligations — currently:
          Supabase (database hosting), Vercel (web hosting and aggregate site
          analytics), Railway (API hosting), Stripe (subscription billing,
          payments, and payouts), Twilio (SMS delivery), Resend
          (email delivery), Expo (delivering app notifications), Apple
          (Apple Wallet passes, app notifications, and Sign in with Apple),
          Google (only if you sign in with Google), Sentry (error monitoring),
          Squarespace / Acuity Scheduling and Square (scheduling data sync,
          only for Shops that connect them), and Anthropic (AI model
          processing — only for Shops that enable the AI receptionist, whose
          client text-message conversations are processed to generate
          replies).
        </li>
        <li>
          <Strong>AI tools a Shop connects:</Strong> a Shop can connect an AI
          assistant of its own choosing to its {APP_NAME} account (for example
          through our MCP connector). When it does, that assistant can read the
          parts of the Shop’s account the Shop allowed when connecting it,
          which can include Client Data, at the Shop’s direction and under that
          provider’s own terms. The
          assistant built into the {APP_NAME} dashboard answers from our help
          content and does not send your data to an AI provider.
        </li>
        <li>
          <Strong>The Shop you patronize:</Strong> if you are a Client, your
          information is visible to your shop — that is the point of the
          Service. A Shop sees your app account’s details only for shops you
          joined or that hold a matching record of you.
        </li>
        <li>
          <Strong>Legal and safety:</Strong> when required by law, subpoena, or
          to protect the rights, safety, or property of {APP_NAME}, our users,
          or the public.
        </li>
        <li>
          <Strong>Business transfers:</Strong> in connection with a merger,
          acquisition, financing, or sale of assets, subject to this Policy.
        </li>
      </UL>

      <H2>6. Security</H2>
      <P>
        We use safeguards appropriate to the data we handle, including TLS
        encryption in transit, encryption of scheduling-provider access tokens
        at rest (AES-256-GCM), password hashing with argon2id, signed httpOnly
        session cookies, per-tenant database isolation enforced at both the
        application and database (row-level security) layers, rate limiting,
        and removal of personal details from our logs. Card numbers are
        entered into Stripe’s own secure forms and never reach our
        servers. No method of transmission or storage is 100% secure, so we
        cannot guarantee absolute security. If we learn of a breach affecting
        your personal information, we will notify affected parties as required
        by law.
      </P>

      <H2>7. Data retention and deletion</H2>
      <UL>
        <li>
          Shop account data and Client Data are retained while the Shop’s
          account is active.
        </li>
        <li>
          When a Shop closes its account (or asks us to), we delete the Shop’s
          data, including its Client Data, within a reasonable period, except
          where we must retain records to comply with law, resolve disputes, or
          enforce agreements (for example, opt-out records are kept so opt-outs
          stay honored, and payment records are kept as tax and accounting law
          requires).
        </li>
        <li>
          Shops can delete individual client records from their dashboard.
          Clients can erase a shop’s record of them with “Delete my data” on
          that shop’s page, or request deletion through the shop or via{" "}
          <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
        </li>
        <li>
          Clients can delete their {APP_NAME} app account at any time from the
          app’s Profile screen. That removes the account, its links to shops,
          its devices, and its pending sign-in codes. Each shop’s own record of
          the Client stays with that shop and can be erased as described above.
        </li>
      </UL>

      <H2>8. Your rights and choices</H2>
      <P>
        Depending on where you live, you may have rights to access, correct,
        delete, or receive a copy of your personal information, and to opt out
        of certain processing. State privacy laws (such as the California
        Consumer Privacy Act and similar laws in other states, including
        Delaware) may grant some or all of these rights. We honor valid
        requests regardless of where you live:
      </P>
      <UL>
        <li>
          <Strong>Shop owners:</Strong> you can view and edit most of your data
          in the dashboard, and can request an export or deletion at{" "}
          <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
        </li>
        <li>
          <Strong>Clients:</Strong> because we process a shop’s records of you
          on that shop’s behalf, we may refer your request to your shop, or
          fulfill it with their direction. Your {APP_NAME} app account is ours
          to answer for directly. We will never discriminate against you for
          exercising your rights.
        </li>
        <li>
          <Strong>Messages:</Strong> reply STOP to any text, use the
          unsubscribe link in any promotional email, or turn off notifications
          in your phone’s settings.
        </li>
        <li>
          <Strong>Authentication of requests:</Strong> we may need to verify
          your identity before acting on a request, and you may use an
          authorized agent where the law allows.
        </li>
      </UL>

      <H2>9. Children</H2>
      <P>
        The Service is not directed to children under 13, and we do not
        knowingly collect personal information from children under 13. If you
        believe a child’s information has been provided to us, contact{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A> and we will
        delete it.
      </P>

      <H2>10. Where data is processed</H2>
      <P>
        The Service is operated from the United States and intended for U.S.
        businesses and their clients. If you access it from elsewhere, you
        understand your information will be processed in the United States.
      </P>

      <H2>11. Changes to this Policy</H2>
      <P>
        We may update this Policy from time to time. If a change is material,
        we will give notice (for example by email to Shop owners or a notice in
        the dashboard) before it takes effect. The dates above show when this
        Policy was last updated and when that version takes effect.
      </P>

      <H2>12. Contact us</H2>
      <P>
        Privacy questions or requests:{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
      </P>
    </LegalShell>
  );
}
