import twilio from "twilio";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
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

/**
 * DRY_RUN kill switch (global). When DRY_RUN=true, getMessageProvider() returns
 * this instead of the Twilio client, so EVERY send path - the sweep, blasts, and
 * the manual/bulk nudge buttons that have no dry-run accounting of their own -
 * simulates instead of texting. Constructing Twilio is also skipped, so dry-run
 * works even before real Twilio creds are set. The returned sid is marked so a
 * simulated send is distinguishable in the Nudge ledger.
 */
export class NoopMessageProvider implements MessageProvider {
  readonly channel = "SMS" as const;
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    logger.info({ to: input.to }, "[dry-run] suppressed SMS send");
    return { sid: "DRYRUN", status: "dry_run" };
  }
}

let provider: MessageProvider | undefined;
let testProvider: MessageProvider | undefined;

/**
 * Factory. An explicitly injected test provider always wins (so suites can
 * assert real-send behavior against a fake). Otherwise the Noop provider is
 * returned whenever DRY_RUN is on, so no caller can accidentally send a real
 * text while simulated - the switch lives here, once, instead of in every
 * route. Twilio otherwise.
 */
export function getMessageProvider(): MessageProvider {
  if (testProvider) return testProvider;
  if (env.DRY_RUN) return new NoopMessageProvider();
  if (!provider) provider = new TwilioMessageProvider();
  return provider;
}

/** Test seam: inject a fake provider (takes precedence over DRY_RUN). */
export function __setMessageProviderForTests(p: MessageProvider | undefined): void {
  testProvider = p;
}
