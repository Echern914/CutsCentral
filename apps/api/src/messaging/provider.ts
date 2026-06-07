import type { MessageChannel } from "@chairback/db";

export interface SendMessageInput {
  to: string; // E.164
  body: string;
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
