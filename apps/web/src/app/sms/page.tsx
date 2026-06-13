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
  title: `SMS Messaging Policy — ${APP_NAME}`,
  description: `Program terms for text messages sent through ${APP_NAME}.`,
};

export default function SmsPolicyPage() {
  return (
    <LegalShell
      title="SMS Messaging Policy"
      intro={
        <P>
          {APP_NAME} sends text messages on behalf of participating barbershops,
          salons, and similar shops — things like rebooking reminders,
          loyalty/rewards updates, and
          promotional offers from the shop you visit. These program terms apply
          to anyone who receives those messages.
        </P>
      }
    >
      <H2>Program description</H2>
      <UL>
        <li>
          <Strong>Who is texting you:</Strong> messages are sent through the{" "}
          {APP_NAME} platform on behalf of your shop. The shop’s name
          appears in the message body.
        </li>
        <li>
          <Strong>What you’ll receive:</Strong> appointment rebooking
          reminders, rewards and punch-card updates, and occasional promotional
          offers from your shop.
        </li>
        <li>
          <Strong>Message frequency varies</Strong> based on your visit history
          and your shop’s settings. Typically a few messages per month at most.
        </li>
        <li>
          <Strong>Message and data rates may apply</Strong> according to your
          mobile plan.
        </li>
      </UL>

      <H2>How you opt in</H2>
      <P>
        You receive messages only if you provided your mobile number to your
        shop and agreed to receive texts from them — for example when
        booking an appointment or signing up for the shop’s rewards program.
        Consent to receive texts is not a condition of purchasing any goods or
        services.
      </P>

      <H2>How to opt out</H2>
      <Notice>
        Reply <Strong>STOP</Strong> to any message to stop receiving texts.
        You may also reply STOPALL, UNSUBSCRIBE, CANCEL, END, or QUIT. After
        you opt out, you will not receive further messages unless you opt back
        in by replying <Strong>START</Strong>. You can also ask your shop
        to opt you out at any time.
      </Notice>

      <H2>Help</H2>
      <P>
        Reply <Strong>HELP</Strong> to any message, contact your shop
        directly, or email{" "}
        <A href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</A>.
      </P>

      <H2>Carriers</H2>
      <P>
        Wireless carriers are not liable for delayed or undelivered messages.
        Message delivery is subject to effective transmission by your mobile
        carrier and is not guaranteed.
      </P>

      <H2>Privacy</H2>
      <P>
        Your mobile number and opt-in information are used only to deliver
        these messages and are never sold or shared with third parties for
        their marketing. See our <A href="/privacy">Privacy Policy</A>.
      </P>
    </LegalShell>
  );
}
