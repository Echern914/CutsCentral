import type { MessageChannel } from "@chairback/db";

export interface SendMessageInput {
  to: string; // E.164
  body: string;
  // E.164 sender override - a shop's OWN number (Shop.twilioNumber). Omitted =
  // the shared platform number. Any number used here must be attached to the
  // verified A2P campaign's messaging service or carriers will filter it.
  from?: string;
}

export interface SendMessageResult {
  sid: string;
  status: string;
}

/**
 * Channel-agnostic message sender. Twilio (SMS) today; email/other channels can
 * implement this later without touching the nudge engine.
 */
export interface MessageProvider {
  readonly channel: MessageChannel;
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
