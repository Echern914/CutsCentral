import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { recordEmailSent } from "../services/emailDelivery.js";

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

/**
 * WHICH MAILSTREAM a message belongs to. Deliberately explicit at every call
 * site rather than inferred, because the two carry different obligations:
 *
 *  - "transactional": the customer asked for this by doing something (booking,
 *    cancelling, resetting a password). No unsubscribe header - these are not
 *    promotional, and adding one both invites opt-out from mail people NEED
 *    and misclassifies the stream to mailbox providers.
 *  - "lifecycle": trial reminders and other upsell-adjacent mail to SHOP
 *    OWNERS. These look promotional to a filter, so they carry one-click
 *    unsubscribe (Gmail/Yahoo bulk-sender rules) and should not share
 *    reputation with password resets any longer than necessary.
 *
 * Today both streams leave from the same verified domain; the split is what
 * makes moving lifecycle mail to its own subdomain a config change rather
 * than a refactor.
 */
export type MailStream = "transactional" | "lifecycle";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * The SHOP's name, for the From display name only - never the address.
   * "Drick's Barbershop via ChairBack <hello@getchairback.com>" keeps the
   * authenticated, DKIM-aligned domain while letting the customer recognise
   * who is writing. A customer who booked at Drick's has no relationship with
   * "ChairBack", and an unrecognised sender is a spam vote.
   */
  fromName?: string;
  /**
   * Where a human reply should land - normally the shop's own address. The
   * body still never invites a reply (the manage button is the only route we
   * advertise), but when someone replies anyway it must reach the barber
   * rather than a platform inbox nobody reads. A deliverable reply path is
   * also an engagement signal that unrepliable senders do not get.
   */
  replyTo?: string;
  /** Defaults to "transactional" - the safe classification. */
  stream?: MailStream;
  /** Correlation only. Never a token, address, or body fragment. */
  meta?: { shopId?: string; appointmentId?: string; kind?: string };
}

export interface SendEmailResult {
  /** Resend message id, or a sentinel ("DISABLED" | "DRYRUN") for suppressed sends. */
  id: string;
  status: "sent" | "skipped" | "dry_run";
}

/**
 * Split "Display Name <addr@host>" into its parts. EMAIL_FROM is operator
 * supplied and may be either shape; the ADDRESS is the half that must never
 * change, because it is what SPF/DKIM/DMARC authenticate.
 */
export function parseFrom(raw: string): { name: string | null; address: string } {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(raw);
  if (!m) return { name: null, address: raw.trim() };
  const name = m[1]!.replace(/^"|"$/g, "").trim();
  return { name: name.length > 0 ? name : null, address: m[2]!.trim() };
}

/**
 * The From header for one message. The shop's name leads (that is who the
 * customer thinks they are hearing from) and "via ChairBack" follows, which
 * is the honest construction mailbox providers expect when one platform
 * sends on behalf of many businesses - and it keeps the address, and
 * therefore the alignment, untouched.
 *
 * Quotes and control characters are stripped: a shop name is user input, and
 * From is a header.
 */
export function buildFrom(rawFrom: string, shopName?: string): string {
  const { name, address } = parseFrom(rawFrom);
  const platform = name ?? "ChairBack";
  const clean = shopName
    ?.replace(/[\r\n"<>,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return rawFrom;
  const display = `${clean.slice(0, 60)} via ${platform}`;
  return `"${display}" <${address}>`;
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

  const stream: MailStream = input.stream ?? "transactional";
  // 🔴 One-click unsubscribe belongs on LIFECYCLE mail only. Gmail/Yahoo bulk
  // rules want it on anything promotional, and its absence there is a spam
  // vote - but putting it on a booking confirmation or a password reset
  // invites opt-out from mail the customer actually needs, and tells the
  // filter this stream is marketing. So the header follows the stream.
  const headers =
    stream === "lifecycle"
      ? {
          "List-Unsubscribe": `<${env.APP_BASE_URL.replace(/\/$/, "")}/unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : undefined;

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: buildFrom(env.EMAIL_FROM!, input.fromName),
      to: [input.to],
      subject: input.subject,
      text: input.text,
      // Always send BOTH parts when HTML exists, and always as a real
      // document: a bare <div> with no <html>/<head>/charset scores badly and
      // renders unpredictably. See wrapEmailHtml.
      ...(input.html ? { html: wrapEmailHtml(input.html, input.subject) } : {}),
      ...(input.replyTo ? { reply_to: [input.replyTo] } : {}),
      ...(headers ? { headers } : {}),
    }),
  });
  if (!res.ok) {
    // Body is Resend's error JSON - useful for debugging (unverified domain,
    // bad key), bounded so a weird response can't flood the log line.
    const body = await res.text().catch(() => "");
    throw new Error(`resend_send_failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  // 🔴 The recipient address is NOT logged. It was, and it is PII that buys
  // nothing: the provider message id is what correlates a send to a delivery
  // event, and the meta ids say which shop/appointment it belonged to.
  logger.info(
    { id: data.id, subject: input.subject, stream, ...input.meta },
    "email sent",
  );
  // Record the send so a later delivery/bounce/complaint event has something
  // to attach to. Fire-and-forget: a ledger write must never fail a message
  // that has already left.
  if (data.id) recordEmailSent(data.id, input);
  return { id: data.id ?? "unknown", status: "sent" };
}

/**
 * Wrap a body fragment in a real HTML document.
 *
 * Every HTML template in this repo is a bare `<div>`. Mailbox filters treat a
 * fragment with no doctype, no charset and no title as malformed, and clients
 * guess the encoding - which mangles the curly quotes and non-breaking spaces
 * these templates use. Doing it HERE rather than in each template means a new
 * template cannot forget.
 *
 * The preheader is the grey line Gmail shows beside the subject; without one
 * it scrapes the first visible text, which is usually a shop name repeated
 * from the subject.
 */
export function wrapEmailHtml(fragment: string, subject: string): string {
  if (/<html[\s>]/i.test(fragment)) return fragment; // already a document
  const preheader = subject.replace(/[<>&]/g, " ").slice(0, 120);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${preheader}</title>
</head>
<body style="margin:0;padding:0;background:#f6f6f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<div style="max-width:560px;margin:0 auto;padding:24px 16px;">
${fragment}
</div>
</body>
</html>`;
}

/**
 * Test seam: inject a fake sender (captures instead of POSTing). Takes
 * precedence over env/DRY_RUN and makes emailEnabled() true, mirroring
 * __setMessageProviderForTests in twilio.ts.
 */
export function __setSendEmailForTests(fn: SendEmailFn | undefined): void {
  testSend = fn;
}
