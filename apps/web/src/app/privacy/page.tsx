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
      intro={
        <P>
          This Privacy Policy explains how {LEGAL_ENTITY} (“{APP_NAME}”, “we”,
          “us”) collects, uses, and shares personal information when you use our
          websites, dashboards, public shop pages, rewards pages, text-message
          programs, and related services (the “Service”). It is incorporated
          into our <A href="/terms">Terms of Service</A>.
        </P>
      }
    >
      <H2>1. The two hats we wear</H2>
      <P>
        {APP_NAME} is used by barbershops, salons, and similar personal-care
        businesses (“<Strong>Shops</Strong>”) to run
        loyalty and rebooking programs for their clients (“
        <Strong>Clients</Strong>”). We handle personal information in two
        distinct roles:
      </P>
      <UL>
        <li>
          <Strong>For Shop accounts and our own websites</Strong>, we decide how
          data is used — we act as the data controller / business.
        </li>
        <li>
          <Strong>For Client Data</Strong> (information about a Shop’s clients —
          names, phone numbers, emails, visit history, punch balances, notes),
          we process it <em>on behalf of the Shop</em> as a service provider /
          processor. The Shop decides why and how that data is used; we follow
          the Shop’s instructions as expressed through the Service.
        </li>
      </UL>
      <Notice>
        If you are a Shop&apos;s client and want your information corrected or
        deleted, the fastest path is to contact that shop directly. You
        can also email us at{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A> and we will
        assist or forward your request to your shop.
      </Notice>

      <H2>2. Information we collect</H2>
      <H3>From Shop owners</H3>
      <UL>
        <li>
          <Strong>Account data:</Strong> your name, email address, and a
          password (stored only as a salted hash — we cannot read it). If you
          sign in with Google, we receive your name, email, and Google account
          identifier instead of a password.
        </li>
        <li>
          <Strong>Shop profile data:</Strong> shop name, booking link, timezone,
          logo, photos, bio, hours, social handles, themes, reward and
          promotion configuration, and SMS templates.
        </li>
        <li>
          <Strong>Scheduling integration data:</Strong> if you connect Acuity
          Scheduling, we store encrypted access tokens and sync appointment and
          client records from your Acuity account.
        </li>
      </UL>
      <H3>About Clients (on behalf of their Shop)</H3>
      <UL>
        <li>
          Name, phone number, and email address (from the Shop’s scheduling
          system or entered by the Shop).
        </li>
        <li>
          Appointment and visit history: dates, status, service names, and
          prices.
        </li>
        <li>
          Loyalty activity: punches earned and redeemed, reward redemptions,
          promotion usage, and visit-cadence estimates derived from visit
          history.
        </li>
        <li>
          Messaging records: the content, time, and delivery status of texts
          sent on the Shop’s behalf, and opt-out status.
        </li>
        <li>Private notes the Shop records about a client.</li>
      </UL>
      <H3>Automatically</H3>
      <UL>
        <li>
          <Strong>Log data:</Strong> IP address, browser type, pages requested,
          and timestamps, used for security, rate limiting, and debugging.
        </li>
        <li>
          <Strong>Cookies:</Strong> we use a single signed, httpOnly session
          cookie to keep Shop owners logged in.{" "}
          <Strong>
            We do not use advertising cookies or third-party tracking pixels.
          </Strong>
        </li>
      </UL>

      <H2>3. How we use information</H2>
      <UL>
        <li>Provide, operate, secure, and improve the Service.</li>
        <li>
          Sync visits from scheduling providers, compute punch balances, and
          render rewards and public pages.
        </li>
        <li>
          Send text messages that Shops initiate or configure (rebooking
          nudges, promotion blasts), enforce opt-outs, and keep delivery
          records.
        </li>
        <li>
          Communicate with Shop owners about their account and important
          Service changes.
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
          Supabase (database hosting), Vercel (web hosting), Railway (API
          hosting), Twilio (SMS delivery), Squarespace / Acuity Scheduling
          (scheduling data sync, only for Shops that connect it), Anthropic
          (AI model processing — only for Shops that enable the AI
          receptionist, whose client text-message conversations are processed
          to generate replies), and Google (only if you sign in with Google).
        </li>
        <li>
          <Strong>The Shop you patronize:</Strong> if you are a Client, your
          information is visible to your barbershop — that is the point of the
          Service.
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
        application and database (row-level security) layers, and rate
        limiting. No method of transmission or storage is 100% secure, so we
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
          stay honored).
        </li>
        <li>
          Shops can delete individual client records from their dashboard;
          Clients can request deletion through their Shop or via{" "}
          <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
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
          <Strong>Clients:</Strong> because we process your data on your
          barbershop’s behalf, we may refer your request to your shop, or
          fulfill it with their direction. We will never discriminate against
          you for exercising your rights.
        </li>
        <li>
          <Strong>Texts:</Strong> reply STOP to any message to stop receiving
          texts.
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
        the dashboard) before it takes effect. The “Effective date” above shows
        when this Policy was last revised.
      </P>

      <H2>12. Contact us</H2>
      <P>
        Privacy questions or requests:{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
      </P>
    </LegalShell>
  );
}
