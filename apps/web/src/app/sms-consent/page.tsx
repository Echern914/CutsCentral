import type { Metadata } from "next";
import { APP_NAME } from "@chairback/config/constants";
import {
  A,
  H2,
  LegalShell,
  Notice,
  P,
  Strong,
  SUPPORT_EMAIL,
  UL,
} from "@/components/legal/Legal";

export const metadata: Metadata = {
  title: `SMS Consent (Opt-In) — ${APP_NAME}`,
  description: `How ${APP_NAME} collects express written consent before sending text messages, including the exact opt-in language and checkbox clients see.`,
};

/**
 * Public proof-of-consent page for A2P 10DLC campaign vetting. Carriers/TCR
 * require a publicly reachable URL that SHOWS the opt-in mechanism (an
 * unchecked checkbox + disclosure). The checkbox below is a visible, disabled
 * facsimile of what a client sees at the point of collection - it documents
 * the consent flow, it does not itself collect consent.
 */
export default function SmsConsentPage() {
  return (
    <LegalShell
      title="SMS Consent (Opt-In)"
      intro={
        <P>
          This page documents how clients give consent to receive text messages
          sent through {APP_NAME} on behalf of the barbershop or salon they
          visit. We require <Strong>express opt-in</Strong> before any client
          receives a text. Below is the exact consent language and checkbox a
          client sees at the point of collection.
        </P>
      }
    >
      <H2>Where consent is collected</H2>
      <P>
        A client opts in when they give their mobile number to their shop and
        affirmatively agree to receive texts — for example when booking an
        appointment or enrolling in the shop’s rewards program. The opt-in
        checkbox is <Strong>unchecked by default</Strong> and the client must
        check it themselves. Consent to receive texts is never a condition of
        booking an appointment or buying any product or service.
      </P>

      <H2>The opt-in a client sees</H2>
      <P>
        This is a visual sample of the consent control as it appears at the
        point of collection (shown disabled here — this page documents the flow
        and does not collect consent):
      </P>
      <div className="mt-4 rounded-xl border border-subtle bg-charcoal-700 p-5">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            disabled
            aria-label="Sample SMS consent checkbox (unchecked by default)"
            className="mt-1 h-5 w-5 shrink-0 rounded border-subtle bg-charcoal-900 accent-gold"
          />
          <span className="text-sm leading-relaxed text-offwhite/90">
            Text me appointment confirmations, reminders, and rewards updates
            from <Strong>[Shop Name]</Strong> sent via {APP_NAME} (a few messages
            per visit). Msg &amp; data rates may apply. Reply <Strong>HELP</Strong>{" "}
            for help, <Strong>STOP</Strong> to opt out. Consent is not a condition
            of purchase. See our <A href="/sms">SMS Terms</A> and{" "}
            <A href="/privacy">Privacy Policy</A>.
          </span>
        </label>
      </div>
      <P>
        <em>
          [Shop Name] is replaced with the actual name of the barbershop or
          salon collecting consent.
        </em>
      </P>

      <H2>What clients receive after opting in</H2>
      <UL>
        <li>
          <Strong>Appointment rebooking reminders</Strong> when it’s time to
          book their next visit.
        </li>
        <li>
          <Strong>Loyalty and rewards updates</Strong> — punches earned, rewards
          ready to redeem.
        </li>
        <li>
          <Strong>Occasional promotional offers</Strong> from their shop.
        </li>
      </UL>
      <P>
        Message frequency varies based on visit history and the shop’s settings
        — typically a few messages per month at most.
      </P>

      <H2>Sample messages</H2>
      <Notice>
        <P>
          <Strong>Reminder:</Strong> Hi Jordan, it’s been a few weeks since your
          last cut at Drick Cuttin Up. Ready to book your next one? [booking
          link] Reply STOP to opt out.
        </P>
        <P>
          <Strong>Rewards:</Strong> Nice — you’ve earned a free cut at Drick
          Cuttin Up! Show this text on your next visit. Reply STOP to opt out.
        </P>
      </Notice>

      <H2>How to opt out</H2>
      <P>
        Reply <Strong>STOP</Strong> to any message to stop receiving texts (you
        may also reply STOPALL, UNSUBSCRIBE, CANCEL, END, or QUIT). Opt-outs are
        honored immediately and platform-wide for that mobile number. Reply{" "}
        <Strong>START</Strong> to opt back in. Reply <Strong>HELP</Strong> for
        help, or email{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
      </P>

      <H2>Privacy</H2>
      <Notice>
        Mobile phone numbers and SMS opt-in data and consent are never sold,
        rented, or shared with third parties for their own marketing. Opt-in
        data is shared only with the vendor that delivers the messages on our
        behalf, and only to deliver them. See our{" "}
        <A href="/privacy">Privacy Policy</A>.
      </Notice>
    </LegalShell>
  );
}
