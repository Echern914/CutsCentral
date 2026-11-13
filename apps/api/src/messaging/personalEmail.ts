import { createTransport } from "nodemailer";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

/**
 * Notes that go out from the founder's own Gmail mailbox, over Gmail SMTP.
 *
 * Why not sendEmail() (Resend): Resend sends only from a domain verified in
 * it, and a From of @gmail.com that did not come through Gmail fails DMARC and
 * lands in spam or nowhere. Going through Gmail itself means the note sits in
 * that mailbox's Sent folder and a reply threads under it, exactly like one
 * typed by hand - which is the point of a personal note.
 *
 * Same gates as sendEmail(), in the same order:
 *  - GMAIL_SMTP_USER or GMAIL_SMTP_APP_PASSWORD unset: a logged no-op, and
 *    personalEmailEnabled() is false so callers create no state for it.
 *  - DRY_RUN=true: suppressed, like every other send path.
 *
 * Plain text only, no HTML and no logo: it should look like what it is.
 *
 * Gmail caps a consumer mailbox at about 500 recipients a day. The only caller
 * today sends a handful a day; anything bulk belongs on sendEmail().
 */

export interface PersonalEmailInput {
  to: string;
  subject: string;
  text: string;
  /** The display name on the From line. */
  fromName: string;
  /** Ids only - never an address or a name (they are logged). */
  meta: Record<string, unknown>;
}

export interface PersonalEmailResult {
  status: "sent" | "dry_run" | "skipped";
}

export type PersonalEmailFn = (input: PersonalEmailInput) => Promise<PersonalEmailResult>;

let testSend: PersonalEmailFn | undefined;

/** True when the mailbox is configured (or a test sender is injected). */
export function personalEmailEnabled(): boolean {
  if (testSend) return true;
  const env = apiEnv();
  return Boolean(env.GMAIL_SMTP_USER && env.GMAIL_SMTP_APP_PASSWORD);
}

/**
 * WILL a send actually leave right now? A caller that records "sent" before
 * dispatching (the check-in sweep) must not spend its once-per-shop mark on a
 * note DRY_RUN is about to swallow. Same branch order as sendPersonalEmail.
 */
export function personalEmailDispatchMode(): "live" | "dry_run" | "unconfigured" {
  if (testSend) return "live";
  if (!personalEmailEnabled()) return "unconfigured";
  return apiEnv().DRY_RUN ? "dry_run" : "live";
}

/**
 * Send one personal note. Never throws on the disabled/dry-run paths; a real
 * SMTP failure DOES throw, so the caller decides.
 */
export async function sendPersonalEmail(input: PersonalEmailInput): Promise<PersonalEmailResult> {
  if (testSend) return testSend(input);

  const env = apiEnv();
  // 🔴 Nothing person-shaped in a log line: `to` is an owner's address and the
  // body carries their name. The meta ids are all an operator needs.
  if (!personalEmailEnabled()) {
    logger.info(
      { ...input.meta, reason: "personal_email_unconfigured" },
      "personal email disabled (GMAIL_SMTP_USER/GMAIL_SMTP_APP_PASSWORD unset); skipping send",
    );
    return { status: "skipped" };
  }
  if (env.DRY_RUN) {
    logger.info({ ...input.meta, reason: "dry_run" }, "[dry-run] suppressed personal email send");
    return { status: "dry_run" };
  }

  const user = env.GMAIL_SMTP_USER!;
  const transport = createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    // Google shows an app password as four groups of four with spaces; the
    // spaces are not part of it.
    auth: { user, pass: env.GMAIL_SMTP_APP_PASSWORD!.replace(/\s+/g, "") },
    // Bounded: a hung connection must not hold the sweep's lease for minutes.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({
      from: { name: input.fromName, address: user },
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
  } finally {
    transport.close();
  }
  logger.info({ ...input.meta }, "personal email sent");
  return { status: "sent" };
}

/** Test seam: inject a fake sender. Takes precedence over env and DRY_RUN. */
export function __setPersonalEmailForTests(fn: PersonalEmailFn | undefined): void {
  testSend = fn;
}
