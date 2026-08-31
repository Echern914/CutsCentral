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
 * 🔴 BOUNDED, AND DELIBERATELY FAR SHORTER THAN THE OUTBOX CLAIM TTL (5 min).
 *
 * An unbounded fetch can outlive its own claim: the row becomes claimable
 * again, a second worker picks it up, and now two requests for the same
 * message are in flight - the one case the provider's Idempotency-Key may not
 * save us from, because a hung connection can still be accepted after the
 * duplicate has gone. Twenty seconds is generous for a JSON POST and leaves an
 * order of magnitude of headroom before the claim ages out.
 *
 * A timeout aborts with a DOMException rather than a ResendSendError, so it is
 * classified as AMBIGUOUS - which is correct: a request we stopped waiting for
 * may well have been accepted.
 */
export const RESEND_TIMEOUT_MS = 20_000;

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

/**
 * A provider rejection, carrying the HTTP status and NOTHING else. Callers
 * classify from `status`; nobody can log a payload they were never given.
 */
export class ResendSendError extends Error {
  constructor(readonly status: number) {
    super(`resend_send_failed_${status}`);
    this.name = "ResendSendError";
  }
  /** Fixed classification for a ledger row or a log line. */
  get classification(): "auth" | "domain" | "rate_limited" | "provider_error" {
    if (this.status === 401 || this.status === 403) return "auth";
    if (this.status === 422) return "domain";
    if (this.status === 429) return "rate_limited";
    return "provider_error";
  }
}

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
  /**
   * Resend's Idempotency-Key. When two attempts carry the same key the
   * PROVIDER collapses them, which is what makes retrying an ambiguous send
   * safe: we no longer have to guess whether the first attempt landed.
   * Resend honours the key for 24h - see PROVIDER_IDEMPOTENCY_WINDOW_MS.
   */
  idempotencyKey?: string;
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
 * WILL a send actually reach a provider right now?
 *
 * The single source of truth for sendEmail's own branch order, so a caller
 * that must decide BEFORE dispatching (the outbox worker, which may not spend
 * a provider attempt on a message that is never going to leave) cannot drift
 * from what sendEmail would really do. An injected test sender counts as
 * "live" for exactly the reason it does inside sendEmail: it is the dispatch.
 */
export function emailDispatchMode(): "live" | "dry_run" | "unconfigured" {
  if (testSend) return "live";
  if (!emailEnabled()) return "unconfigured";
  return apiEnv().DRY_RUN ? "dry_run" : "live";
}

/**
 * Send one transactional email. Never throws on the disabled/dry-run paths;
 * a real Resend failure DOES throw so callers can decide (log vs surface).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (testSend) return testSend(input);

  const env = apiEnv();
  // 🔴 NOTHING PERSON-SHAPED IN A LOG LINE - on any path, including the ones
  // that send nothing. `to` is the customer's address and `subject` carries
  // their name, their service and their shop. The meta ids say which booking
  // this was; that is all an operator needs and all we may keep.
  if (!emailEnabled()) {
    logger.info(
      { ...input.meta, reason: "email_unconfigured" },
      "email disabled (RESEND_API_KEY/EMAIL_FROM unset); skipping send",
    );
    return { id: "DISABLED", status: "skipped" };
  }
  if (env.DRY_RUN) {
    logger.info({ ...input.meta, reason: "dry_run" }, "[dry-run] suppressed email send");
    return { id: "DRYRUN", status: "dry_run" };
  }

  const stream: MailStream = input.stream ?? "transactional";
  // 🔴 NO List-Unsubscribe HEADER IS SENT, deliberately.
  //
  // An earlier cut advertised <APP_BASE_URL>/unsubscribe on lifecycle mail.
  // That route does not exist, and a header pointing at a 404 is worse than
  // no header at all: mailbox providers follow it, and a one-click
  // unsubscribe that fails is a stronger negative signal than its absence.
  //
  // Nor is the right fix simply to build the route here. ChairBack sends NO
  // marketing email - promotions are SMS-only (routes/promotions.ts). What
  // the "lifecycle" stream actually carries is trial and AI-trial reminders
  // to SHOP OWNERS about the state of their own account, which are account
  // notices rather than promotions. Letting an owner one-click their way out
  // of "your trial ends tomorrow" has a billing consequence that belongs to
  // Eric, not to a deliverability patch.
  //
  // The STREAM stays, because it is still what separates owner lifecycle mail
  // from customer transactional mail for reputation purposes and what a
  // future dedicated subdomain (or a real unsubscribe) would key off.

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
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
    }),
  });
  if (!res.ok) {
    // 🔴 THE STATUS CODE ONLY. Resend's error body echoes the request it
    // rejected - recipient, subject, and the rendered HTML - and this Error
    // travels into logs, Sentry and (via callers) provider-error columns.
    // A hostile or merely verbose provider must not be able to smuggle the
    // message back out through an exception string. The status is enough to
    // separate "unverified domain" (403) from "bad key" (401) from "rate
    // limited" (429), which is all the classification anyone acts on.
    await res.text().catch(() => "");
    throw new ResendSendError(res.status);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  // 🔴 The recipient address is NOT logged. It was, and it is PII that buys
  // nothing: the provider message id is what correlates a send to a delivery
  // event, and the meta ids say which shop/appointment it belonged to.
  logger.info({ id: data.id, stream, ...input.meta }, "email sent");
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
