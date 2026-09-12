import { Router } from "express";
import { z } from "zod";
import { forShop, type LoyaltyTier } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { previewBroadcast, queueBroadcast, type BroadcastBlocker } from "../engines/broadcast.js";
import { broadcastProgress } from "../engines/broadcastWorker.js";
import { SKIP_REASON_LABEL, type SkipReason } from "../engines/broadcastAudience.js";

/**
 * One message from a shop to many of its clients.
 *
 * 🔴 EMAIL OR APP NOTIFICATION. NEVER SMS - a text to a whole client book
 * costs real money per message and would empty a shop's monthly allowance in
 * one tap. The enum has no value for it, so this is not a rule anyone can
 * forget.
 *
 * 🔴 MANAGER-AND-ABOVE, behind the billing wall, and behind the same rate
 * limiter as the rest of the dashboard. A broadcast reaches every client the
 * shop has; it is not something a barber on a chair should be able to do to
 * the owner's list, and it is not something a loop should be able to do at
 * machine speed.
 *
 * The flow is deliberately two steps. A preview says exactly how many people
 * will receive it, who is excluded and why, and what it costs against the
 * month's allowance - and only then is there something to send. Nothing here
 * is ever triggered automatically: the assistant may write a DRAFT, but a
 * person presses send.
 */
export const broadcastsRouter: Router = Router();
broadcastsRouter.use(requireUser, requireShop, requireManager, requireActiveAccess);

/** Mirrors the LoyaltyTier enum. A tier added there must be added here. */
const LOYALTY_TIERS = ["BRONZE", "SILVER", "GOLD"] as const satisfies readonly LoyaltyTier[];

const audienceSchema = z.object({
  channel: z.enum(["email", "push"]),
  // [] = every reachable client. Otherwise only these tiers ("the gold members").
  tiers: z.array(z.enum(LOYALTY_TIERS)).max(LOYALTY_TIERS.length).optional(),
});

/**
 * 🔴 WHAT FITS IS A PROPERTY OF THE CHANNEL, NOT OF THE FORM.
 *
 * One shared 4,000-character limit was wrong in one direction and invisible in
 * the other: an email that long is a newsletter, but a PUSH that long is a
 * notification every phone truncates somewhere around 150-240 characters, so
 * the barber writes four paragraphs, sees them accepted, and his customers
 * receive a sentence and a half with the offer cut off mid-word. A limit that
 * refuses at the keyboard is a worse message than a limit that lies at the
 * lock screen.
 */
export const BODY_LIMITS = { email: 4000, push: 300 } as const;
export const SUBJECT_LIMITS = { email: 120, push: 60 } as const;

const draftSchema = audienceSchema
  .extend({
    // The email subject, or the push notification's title. Required for both:
    // a push with no title is not worth sending either.
    subject: z.string().trim().min(1).max(SUBJECT_LIMITS.email),
    body: z.string().trim().min(1).max(BODY_LIMITS.email),
  })
  .superRefine((v, ctx) => {
    if (v.subject.length > SUBJECT_LIMITS[v.channel]) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: SUBJECT_LIMITS[v.channel],
        type: "string",
        inclusive: true,
        path: ["subject"],
        message: `A notification title has to fit on a lock screen - ${SUBJECT_LIMITS.push} characters or fewer.`,
      });
    }
    if (v.body.length > BODY_LIMITS[v.channel]) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: BODY_LIMITS[v.channel],
        type: "string",
        inclusive: true,
        path: ["body"],
        message: `A notification gets cut off on the phone - keep it to ${BODY_LIMITS.push} characters, or send it as an email instead.`,
      });
    }
  });

/** Turn the engine's refusal into something the compose screen can say. */
function blockerMessage(blocker: BroadcastBlocker): string {
  switch (blocker.kind) {
    case "no_recipients":
      return "Nobody in this group can be reached on that channel yet.";
    case "over_quota":
      return `That's ${blocker.need} emails and you have ${blocker.remaining} left this month. Pick a smaller group, or send it as an app notification instead — those are free.`;
    case "email_not_configured":
      return "Email isn't switched on for this platform yet.";
    case "unsubscribe_not_configured":
      // Deliberately not "something went wrong": a barber can act on the
      // second half of this immediately, and somebody has to be told the first.
      return "Marketing email is switched off on this server until an operator finishes setting it up. App notifications work now — send one of those instead.";
    case "no_postal_address":
      return "Add your shop's street address first — marketing email has to carry it by law. App notifications don't, so you can send one of those right now.";
    case "already_sending":
      return "This one has already been sent.";
    case "not_found":
      return "That message no longer exists.";
  }
}

// POST /api/broadcasts/preview - who would get this, and what it costs.
broadcastsRouter.post("/preview", async (req, res) => {
  const parsed = audienceSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const preview = await previewBroadcast({
    shopId: req.shop!.id,
    channel: parsed.data.channel,
    tiers: parsed.data.tiers ?? [],
  });
  res.json({
    reachable: preview.reachable,
    considered: preview.considered,
    emailsRemaining: preview.emailsRemaining,
    limits: { subject: SUBJECT_LIMITS[parsed.data.channel], body: BODY_LIMITS[parsed.data.channel] },
    skipped: preview.skipped.map((s) => ({
      reason: s.reason,
      count: s.count,
      label: SKIP_REASON_LABEL[s.reason as SkipReason],
    })),
    blocker: preview.blocker
      ? { kind: preview.blocker.kind, message: blockerMessage(preview.blocker) }
      : null,
  });
});

/**
 * GET /api/broadcasts - what this shop has sent, newest first, with LIVE
 * progress.
 *
 * 🔴 THE PROGRESS COMES FROM THE RECIPIENT ROWS, not from the counters on the
 * broadcast. Those are written when a blast FINISHES, so reading them mid-send
 * would show 0 of 412 for several minutes and look exactly like a feature that
 * had silently stopped - which is how a barber presses send a second time.
 */
broadcastsRouter.get("/", async (req, res) => {
  const shopId = req.shop!.id;
  const rows = (await forShop(shopId).broadcast.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true,
      channel: true,
      audienceTiers: true,
      subject: true,
      body: true,
      status: true,
      recipientCount: true,
      sentCount: true,
      failedCount: true,
      skippedCount: true,
      queuedAt: true,
      sentAt: true,
      createdAt: true,
    },
  })) as unknown as {
    id: string;
    status: string;
    recipientCount: number;
    sentCount: number;
    failedCount: number;
    skippedCount: number;
  }[];

  // Only the ones still moving need a live count; a finished blast's frozen
  // numbers are the answer and re-deriving them would be work for nothing.
  const inFlight = rows.filter((b) => b.status === "QUEUED" || b.status === "SENDING");
  const progress = await broadcastProgress(shopId, inFlight.map((b) => b.id));

  res.json({
    broadcasts: rows.map((b) => {
      const live = progress.get(b.id);
      return {
        ...b,
        sentCount: live ? live.sent : b.sentCount,
        failedCount: live ? live.failed : b.failedCount,
        skippedCount: live ? live.skipped : b.skippedCount,
        pendingCount: live ? live.pending : 0,
      };
    }),
  });
});

// POST /api/broadcasts - write a draft. Sends nothing.
broadcastsRouter.post("/", async (req, res) => {
  const parsed = draftSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_input",
      // The first issue is already worded for a person on the length rules
      // above; the compose screen shows it rather than "invalid input".
      message: parsed.error.issues[0]?.message,
      issues: parsed.error.issues,
    });
    return;
  }
  const d = parsed.data;
  const broadcast = await forShop(req.shop!.id).broadcast.create({
    data: {
      createdByUserId: req.userId!,
      channel: d.channel,
      audienceTiers: d.tiers ?? [],
      subject: d.subject,
      body: d.body,
      status: "DRAFT",
    },
  });
  res.status(201).json({ id: (broadcast as { id: string }).id });
});

/**
 * POST /api/broadcasts/:id/send - commit to it.
 *
 * 🔴 THE 202 MEANS QUEUED, AND SAYS SO. Everything that makes the promise real
 * happens BEFORE the response and inside one transaction: the audience is
 * frozen into rows, the month's allowance is reserved against a locked row,
 * and the broadcast moves DRAFT -> QUEUED. So the number returned here is a
 * row count, not a forecast, and it cannot disagree with what gets delivered.
 *
 * Nothing is sent in this process. The earlier cut kept working after the
 * response in a floating promise, which meant a deploy - or any restart - in
 * the following seconds stranded the blast in SENDING with nothing to resume
 * it. A worker with a lease drains the frozen rows instead, so the request
 * dying is a delay of at most a minute rather than a silent, permanent halt.
 */
broadcastsRouter.post("/:id/send", async (req, res) => {
  const shopId = req.shop!.id;
  const id = String(req.params.id);

  // Refuse BEFORE anything is written, with the reason and the numbers - the
  // authoritative versions of these checks are taken again under the lock
  // inside queueBroadcast, but a 409 that arrives without having touched
  // anything is cheaper and reads better than one that rolled back.
  const outcome = await queueBroadcast({ shopId, broadcastId: id });
  if (!outcome.ok) {
    const blocker = outcome.blocker;
    if (blocker.kind === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(409).json({
      error: blocker.kind === "already_sending" ? "already_sent" : blocker.kind,
      message: blockerMessage(blocker),
      ...(blocker.kind === "over_quota"
        ? { need: blocker.need, remaining: blocker.remaining }
        : {}),
    });
    return;
  }

  res.status(202).json({
    ok: true,
    status: "QUEUED",
    recipients: outcome.recipients,
    skipped: outcome.skipped,
  });
});
