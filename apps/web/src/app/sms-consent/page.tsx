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
        A client opts in on their shop&rsquo;s public booking page at{" "}
        <Strong>getchairback.com/book/&lt;shop&gt;</Strong>. In the{" "}
        <Strong>&ldquo;Your details&rdquo;</Strong> step — the same screen where
        the client types their name and mobile number to finish booking — the
        consent checkbox below appears directly beneath the phone-number field.
        The checkbox is <Strong>unchecked by default</Strong> and the client
        must check it themselves; the timestamp and source of consent are
        stored. Consent to receive texts is never a condition of booking an
        appointment or buying any product or service — the booking completes
        either way.
      </P>

      <H2>The opt-in a client sees</H2>
      <P>
        This is the exact consent control as it appears at the point of
        collection (shown disabled here — this page documents the flow and does
        not collect consent):
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
            from <Strong>[Shop Name]</Strong> via {APP_NAME} (a few messages per
            visit). Msg &amp; data rates may apply. Reply <Strong>HELP</Strong>{" "}
            for help, <Strong>STOP</Strong> to opt out. Consent is not a condition
            of purchase. See our <A href="/sms">SMS Terms</A> and{" "}
            <A href="/privacy">Privacy Policy</A>.
          </span>
        </label>
      </div>
      <P>
        <em>
          [Shop Name] is replaced with the actual name of the barbershop or
          salon collecting consent — every message a client receives names that
          same shop.
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
          <Strong>Booking confirmation:</Strong> Hi Marcus, your Haircut at
          Drick&rsquo;s Barbershop with Drick is booked for Sat, Jun 28 at 2:30
          PM. Need to change it? https://getchairback.com/book/manage/abc123
          Reply STOP to opt out.
        </P>
        <P>
          <Strong>Appointment reminder:</Strong> Reminder, Marcus: your Haircut
          at Drick&rsquo;s Barbershop is Sat, Jun 28 at 2:30 PM. See you then!
          Manage: https://getchairback.com/book/manage/abc123 Reply STOP to opt
          out.
        </P>
        <P>
          <Strong>Rewards earned:</Strong> Hey Marcus, you just earned 2 punches
          at Drick&rsquo;s Barbershop! You&rsquo;re at 6 punches. See your
          rewards: https://getchairback.com/r/abc123 Reply STOP to opt out.
        </P>
        <P>
          <Strong>Reward redeemed:</Strong> Hey Marcus, you just redeemed a Free
          Haircut at Drick&rsquo;s Barbershop! Enjoy. You have 2 punches left.
          Your rewards: https://getchairback.com/r/abc123 Reply STOP to opt out.
        </P>
        <P>
          <Strong>Rebooking reminder:</Strong> Hey Marcus, it&rsquo;s been a
          while since your last cut at Drick&rsquo;s Barbershop! Book your next
          one: https://getchairback.com/book/dricks &bull; Your rewards:
          https://getchairback.com/r/abc123 Reply STOP to opt out.
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
