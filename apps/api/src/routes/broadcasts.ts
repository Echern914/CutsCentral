import { Router } from "express";
import { z } from "zod";
import { forShop, type LoyaltyTier } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { logger } from "../logger.js";
import { claimForSending, previewBroadcast, sendBroadcast } from "../engines/broadcast.js";
import { SKIP_REASON_LABEL, type SkipReason } from "../engines/broadcastAudience.js";

/**
 * One message from a shop to many of its clients.
 *
 * 🔴 EMAIL OR APP NOTIFICATION. NEVER SMS - a text to a whole client book
 * costs real money per message and would empty a shop's monthly allowance in
 * one tap. The enum has no value for it, so this is not a rule anyone can
 * forget.
 *
 * 🔴 MANAGER-AND-ABOVE, and behind the billing wall. A broadcast reaches every
 * client the shop has; it is not something a barber on a chair should be able
 * to do to the owner's list.
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

const draftSchema = audienceSchema.extend({
  // The email subject, or the push notification's title. Required for both:
  // a push with no title is not worth sending either.
  subject: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4000),
});

/** Turn the engine's refusal into something the compose screen can say. */
function blockerMessage(
  blocker: NonNullable<Awaited<ReturnType<typeof previewBroadcast>>["blocker"]>,
): string {
  switch (blocker.kind) {
    case "no_recipients":
      return "Nobody in this group can be reached on that channel yet.";
    case "over_quota":
      return `That's ${blocker.need} emails and you have ${blocker.remaining} left this month. Pick a smaller group, or send it as an app notification instead — those are free.`;
    case "email_not_configured":
      return "Email isn't switched on for this platform yet.";
    case "no_postal_address":
      return "Add your shop's street address first — marketing email has to carry it by law. App notifications don't, so you can send one of those right now.";
    case "already_sending":
      return "This one has already been sent.";
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

// GET /api/broadcasts - what this shop has sent, newest first.
broadcastsRouter.get("/", async (req, res) => {
  const broadcasts = await forShop(req.shop!.id).broadcast.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ broadcasts });
});

// POST /api/broadcasts - write a draft. Sends nothing.
broadcastsRouter.post("/", async (req, res) => {
  const parsed = draftSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
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
 * POST /api/broadcasts/:id/send - actually send it.
 *
 * 🔴 ANSWERS 202 AND KEEPS WORKING. A shop with 2,700 emailable clients cannot
 * be mailed inside one HTTP request - the request would time out somewhere in
 * the middle, and the caller would have no idea how far it got. The audience
 * is frozen into rows first (so the count in this response is real), the work
 * continues after the response, and progress is readable from the list above.
 * The per-recipient unique index means none of that can mail anybody twice.
 */
broadcastsRouter.post("/:id/send", async (req, res) => {
  const shopId = req.shop!.id;
  const id = String(req.params.id);
  const broadcast = (await forShop(shopId).broadcast.findFirst({
    where: { id },
    select: { id: true, channel: true, audienceTiers: true, status: true },
  })) as unknown as {
    id: string;
    channel: "email" | "push";
    audienceTiers: LoyaltyTier[];
    status: string;
  } | null;
  if (!broadcast) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (broadcast.status !== "DRAFT") {
    res.status(409).json({ error: "already_sent", message: blockerMessage({ kind: "already_sending" }) });
    return;
  }

  // Refuse BEFORE anything is written or sent, with the reason and the
  // numbers - never a half-sent blast the barber cannot undo or resume.
  const preview = await previewBroadcast({
    shopId,
    channel: broadcast.channel,
    tiers: broadcast.audienceTiers,
  });
  if (preview.blocker) {
    res.status(409).json({
      error: preview.blocker.kind,
      message: blockerMessage(preview.blocker),
      ...(preview.blocker.kind === "over_quota"
        ? { need: preview.blocker.need, remaining: preview.blocker.remaining }
        : {}),
    });
    return;
  }

  // 🔴 CLAIM BEFORE ANSWERING. Two taps in the same second both reach here;
  // only the one that moves the row out of DRAFT gets the 202, and the other
  // is told plainly rather than handed a cheerful receipt for work it is not
  // doing. Taking the mutex in the background instead would mean both callers
  // saw success and only the logs knew otherwise.
  if (!(await claimForSending(shopId, id))) {
    res.status(409).json({ error: "already_sent", message: blockerMessage({ kind: "already_sending" }) });
    return;
  }

  res.status(202).json({ ok: true, recipients: preview.reachable });
  void sendBroadcast({ shopId, broadcastId: id }).catch((err: unknown) =>
    logger.error({ err, shopId, broadcastId: id }, "broadcast send failed"),
  );
});
