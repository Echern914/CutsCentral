import twilio from "twilio";
import { apiEnv } from "@chairback/config";
import type { MessageProvider, SendMessageInput, SendMessageResult } from "./provider.js";

const env = apiEnv();

/**
 * Twilio SMS provider using the single shared platform number. The shop name is
 * carried in the message body (set by the nudge template), not via a per-shop
 * number - that's a future seam.
 */
export class TwilioMessageProvider implements MessageProvider {
  readonly channel = "SMS" as const;
  private client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const msg = await this.client.messages.create({
      to: input.to,
      from: env.TWILIO_FROM_NUMBER,
      body: input.body,
    });
    return { sid: msg.sid, status: msg.status };
  }
}

let provider: MessageProvider | undefined;

/** Factory - Twilio today. */
export function getMessageProvider(): MessageProvider {
  if (!provider) provider = new TwilioMessageProvider();
  return provider;
}

/** Test seam: inject a fake provider. */
export function __setMessageProviderForTests(p: MessageProvider | undefined): void {
  provider = p;
}
