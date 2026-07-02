import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Transactional email seam (Resend over plain fetch - deliberately NO SDK
 * dependency; it's one POST). Mirrors the optional-env pattern of
 * billing/stripe.ts and the DRY_RUN kill switch of messaging/twilio.ts:
 *
 *  - With RESEND_API_KEY or EMAIL_FROM unset, emailEnabled() is false and
 *    sendEmail() is a logged no-op - the pre-email behavior CI/tests/prod run
 *    with today. Setting both flips email on without a code change.
 *  - DRY_RUN=true (the global send kill switch) suppresses real sends the same
 *    way it suppresses SMS, so flipping email env vars on while the platform is
 *    still dark can never surprise-send.
 *
 * Callers that DEPEND on delivery (forgot-password issuing a token, the trial
 * reminder advancing a stage) must gate on emailEnabled() first, so no
 * user-visible state is created for a message that was never going to leave.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  /** Resend message id, or a sentinel ("DISABLED" | "DRYRUN") for suppressed sends. */
  id: string;
  status: "sent" | "skipped" | "dry_run";
}

type SendEmailFn = (input: SendEmailInput) => Promise<SendEmailResult>;

let testSend: SendEmailFn | undefined;

/**
 * True when transactional email is configured. An injected test sender counts
 * as "configured" (it always wins in sendEmail, same as twilio's testProvider),
 * so suites can exercise the enabled paths without real env vars.
 */
export function emailEnabled(): boolean {
  if (testSend) return true;
  const env = apiEnv();
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

/**
 * Send one transactional email. Never throws on the disabled/dry-run paths;
 * a real Resend failure DOES throw so callers can decide (log vs surface).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (testSend) return testSend(input);

  const env = apiEnv();
  if (!emailEnabled()) {
    logger.info(
      { to: input.to, subject: input.subject },
      "email disabled (RESEND_API_KEY/EMAIL_FROM unset); skipping send",
    );
    return { id: "DISABLED", status: "skipped" };
  }
  if (env.DRY_RUN) {
    logger.info({ to: input.to, subject: input.subject }, "[dry-run] suppressed email send");
    return { id: "DRYRUN", status: "dry_run" };
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    }),
  });
  if (!res.ok) {
    // Body is Resend's error JSON - useful for debugging (unverified domain,
    // bad key), bounded so a weird response can't flood the log line.
    const body = await res.text().catch(() => "");
    throw new Error(`resend_send_failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  logger.info({ to: input.to, subject: input.subject, id: data.id }, "email sent");
  return { id: data.id ?? "unknown", status: "sent" };
}

/**
 * Test seam: inject a fake sender (captures instead of POSTing). Takes
 * precedence over env/DRY_RUN and makes emailEnabled() true, mirroring
 * __setMessageProviderForTests in twilio.ts.
 */
export function __setSendEmailForTests(fn: SendEmailFn | undefined): void {
  testSend = fn;
}
