import twilio from "twilio";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { platformSwitch } from "../services/platformSwitches.js";
import type { MessageProvider, SendMessageInput, SendMessageResult } from "./provider.js";

const env = apiEnv();

/**
 * Twilio SMS provider. Sends from the shared platform number unless the caller
 * passes a per-shop `from` (Shop.twilioNumber) - shops with their own line get
 * deterministic inbound routing and a local sender their clients recognize.
 */
export class TwilioMessageProvider implements MessageProvider {
  readonly channel = "SMS" as const;
  private client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const msg = await this.client.messages.create({
      to: input.to,
      from: input.from ?? env.TWILIO_FROM_NUMBER,
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

/**
 * Is texting switched on at all? The admin portal's Texting switch, and until
 * anyone has used it the `SMS_ENABLED` default (read fresh, so a test can flip
 * it with __resetEnvCacheForTests()).
 *
 * 🔴 CHECK THIS BEFORE ANYTHING IS SPENT, not by catching a failed send. A send
 * that fails is written down as FAILED and tried again - the 24h reminder
 * every 20 minutes until the appointment starts, a sign-in code until its
 * attempts run out - and quotas, cooldowns and "we texted you" screens have
 * all been used up by then. Every path that texts asks this first and skips,
 * or answers "texting is off", or sends the email/app version instead.
 */
export function smsEnabled(): boolean {
  // The admin portal's switch wins once anyone has used it; until then the
  // environment default applies (services/platformSwitches.ts).
  return platformSwitch("sms") ?? apiEnv().SMS_ENABLED;
}

/** What a button that can only text says while texting is off. */
export const TEXTING_OFF_MESSAGE = "Texting is turned off right now, so nothing was sent.";

/** What a send throws while texting is off. See SmsDisabledProvider. */
export class SmsDisabledError extends Error {
  readonly code = "sms_disabled";
  constructor() {
    super("texting is turned off (SMS_ENABLED=false)");
    this.name = "SmsDisabledError";
  }
}

/**
 * The provider while texting is off: every send is REFUSED, never faked.
 *
 * Only a backstop - each path is meant to have checked smsEnabled() first. A
 * send that reaches here throws, so the path records a failure rather than a
 * success: faking success the way DRY_RUN does would mark reminders as sent,
 * use up the daily cap and the monthly quota, and show "Nudge sent" for a text
 * nobody received.
 */
export class SmsDisabledProvider implements MessageProvider {
  readonly channel = "SMS" as const;
  async send(input: SendMessageInput): Promise<SendMessageResult> {
    logger.warn({ to: input.to }, "SMS send refused: texting is turned off");
    throw new SmsDisabledError();
  }
}

let provider: MessageProvider | undefined;
let testProvider: MessageProvider | undefined;

/**
 * Factory. Texting switched off beats everything, an injected test fake
 * included, so a suite can prove a path sends nothing while it is off.
 * Otherwise an explicitly injected test provider wins (so suites can assert
 * real-send behavior against a fake), then the Noop provider whenever DRY_RUN
 * is on, so no caller can accidentally send a real text while simulated - the
 * switch lives here, once, instead of in every route. Twilio otherwise.
 *
 * Never throws: several callers build the provider outside any try.
 */
export function getMessageProvider(): MessageProvider {
  if (!smsEnabled()) return new SmsDisabledProvider();
  if (testProvider) return testProvider;
  if (env.DRY_RUN) return new NoopMessageProvider();
  if (!provider) provider = new TwilioMessageProvider();
  return provider;
}

/**
 * Whether a REAL SMS transport exists, INDEPENDENT of DRY_RUN.
 *
 * Mirrors emailEnabled() / pushEnabled(): "is this channel configured at all?",
 * which is a different question from "would a send go out right now" (that also
 * needs DRY_RUN off). Readiness needs the two separated so it can say WHICH of
 * the two is missing instead of collapsing both into "unreachable".
 *
 * Reads apiEnv() fresh rather than the module-load `env` above, so a test that
 * flips the vars and calls __resetEnvCacheForTests() is reflected here.
 */
export function smsConfigured(): boolean {
  // Switched off is "no text channel" for readiness, whatever creds exist.
  if (!smsEnabled()) return false;
  if (testProvider) return true;
  const e = apiEnv();
  return Boolean(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM_NUMBER);
}

/** Test seam: inject a fake provider (beats DRY_RUN, never texting switched off). */
export function __setMessageProviderForTests(p: MessageProvider | undefined): void {
  testProvider = p;
}
