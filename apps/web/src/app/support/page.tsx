import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import {
  A,
  H2,
  H3,
  LegalShell,
  Notice,
  P,
  Strong,
  SUPPORT_EMAIL,
  UL,
} from "@/components/legal/Legal";

export const metadata: Metadata = {
  title: `Support — ${APP_NAME}`,
  description: `Get help with ${APP_NAME} — contact support, FAQs, and account management.`,
};

export default function SupportPage() {
  return (
    <LegalShell
      title="Support"
      hideDate
      intro={
        <P>
          We&apos;re here to help. Whether you run a shop on {APP_NAME} or you&apos;re
          a client tracking your rewards, reach a real person — someone reads
          every message.
        </P>
      }
    >
      <H2>Contact us</H2>
      <P>
        Email <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>. This is our
        single support channel for shop owners, their clients, and general
        questions. Include your shop name (or the shop you visit) so we can find
        your account quickly.
      </P>
      <P>
        We typically reply within 1–2 business days.
      </P>

      <H2>Account &amp; data</H2>
      <P>
        You can delete your account and its data from within {APP_NAME} at any
        time — no email required.
      </P>
      <UL>
        <li>
          <Strong>Shop owners &amp; managers:</Strong> open your{" "}
          <A href="/dashboard">dashboard</A>, scroll to the{" "}
          <Strong>Account</Strong> section, and choose{" "}
          <Strong>Delete account</Strong>. This permanently removes your login,
          every shop you own, and all of its clients, visits, punches, and
          nudges, and cancels any active subscription. It cannot be undone.
        </li>
        <li>
          <Strong>Clients (rewards users):</Strong> open your rewards page (the
          link your shop texted you) and use <Strong>Delete my data</Strong> to
          remove your rewards profile and history. You can also ask your shop to
          remove you, or email us and we&apos;ll take care of it.
        </li>
      </UL>
      <Notice>
        Prefer we handle it? Email{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A> from the address
        on your account and we&apos;ll delete it for you. See our{" "}
        <A href="/privacy">Privacy Policy</A> for what we store and how long we
        keep it.
      </Notice>

      <H2>Frequently asked questions</H2>

      <H3>How do I stop text messages?</H3>
      <P>
        Reply <Strong>STOP</Strong> to any message to opt out immediately. See
        our <A href="/sms">SMS Policy</A> for details.
      </P>

      <H3>I&apos;m a client — how do I fix my rewards balance?</H3>
      <P>
        Your shop manages your punches and rewards. Contact the shop directly
        and they can adjust your balance from their dashboard.
      </P>

      <H3>How do I connect my scheduling or point of sale?</H3>
      <P>
        In your dashboard you can connect supported booking and calendar tools
        so visits sync automatically. If you don&apos;t see your provider, email
        us and we&apos;ll help.
      </P>

      <H3>How do I manage my subscription?</H3>
      <P>
        Subscriptions are managed on the web in your{" "}
        <A href="/dashboard">dashboard</A> billing settings, where you can
        upgrade, update your card, or cancel at any time.
      </P>

      <H3>How do I delete my account or data?</H3>
      <P>
        See <Strong>Account &amp; data</Strong> above — both shop owners and
        clients can delete everything from within {APP_NAME}.
      </P>
    </LegalShell>
  );
}
