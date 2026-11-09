import { Prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { ExternalBlockError, HeldSlotError, OverlapError } from "../engines/bookingWrite.js";
import { isMirrorNotConfigured, mirrorNotConfiguredSource } from "../engines/mirrorNotConfigured.js";
import { blockSentence, describeBlocks, describeOverlap, holdSentence } from "../services/appointmentOverride.js";

/** A status and JSON, nothing else: all a refusal needs from the response. */
interface RefusalRes {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Answer a shop-side booking the guard refused. True when it answered; false
 * when the error is not a refusal and is the caller's to handle.
 *
 * One answer for New appointment and the back-to-back run, because the form
 * reads both the same way: what is in the way, and whether a yes can move it.
 */
export async function answerBookingRefusal(
  res: RefusalRes,
  err: unknown,
  ctx: { shopId: string; timezone: string; overlapConfirmation?: string | null },
): Promise<boolean> {
  // The one refusal that must be SHOWN, not just returned: which block, when,
  // and why - so the barber decides with the facts, then confirms.
  if (err instanceof ExternalBlockError) {
    res.status(409).json({
      error: "external_block",
      code: "SLOT_UNAVAILABLE",
      confirmable: true,
      reason: blockSentence(err.blocks, ctx.timezone),
      blocks: describeBlocks(err.blocks),
      confirmation: err.confirmation,
    });
    return true;
  }
  // A customer's live hold is in the way: somebody is paying for or
  // confirming this exact time. Said plainly, with when it ends - and never
  // confirmable, so there is no "Book anyway" to offer.
  if (err instanceof HeldSlotError) {
    res.status(409).json({
      error: "slot_taken",
      code: "HELD",
      confirmable: false,
      reason: holdSentence(err.heldUntil, ctx.timezone),
    });
    return true;
  }
  // Over other bookings / visits / his own specials: not a dead end. Name
  // each one and hand back the confirmation that lets him book over exactly
  // these - the "Book anyway" under the list, and the question its second
  // tap answers (`message`).
  if (err instanceof OverlapError) {
    const described = await describeOverlap(ctx.shopId, err.rows, ctx.timezone, err.bufferOnly);
    res.status(409).json({
      error: "slot_taken",
      code: "OVERLAP",
      confirmable: true,
      ...(err.bufferOnly ? { bufferOnly: true } : {}),
      reason: described.reason,
      conflicts: described.lines,
      message: described.question,
      confirmation: err.confirmation,
    });
    return true;
  }
  const msg = (err as Error).message;
  if (msg === "slot_taken") {
    res.status(409).json({ error: "slot_taken" });
    return true;
  }
  if (msg === "client_not_found") {
    res.status(404).json({ error: "client_not_found" });
    return true;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    // A forced booking cleared every overlap check and still hit the one
    // rule that has no override: two live bookings cannot START at the same
    // minute on one chair. Say that, not "already booked".
    res.status(409).json({ error: ctx.overlapConfirmation ? "same_start" : "slot_taken" });
    return true;
  }
  // ENFORCING with a chair the mirror cannot protect. Same refusal the
  // public booking page gives, for the same reason: confirming a booking
  // the external calendar still shows as free is precisely what the mirror
  // exists to prevent. Previously this fell through to a 500, which told
  // the barber nothing and read as the product being broken.
  if (isMirrorNotConfigured(err)) {
    logger.error(
      { shopId: ctx.shopId, staffId: err.staffId, mirror: mirrorNotConfiguredSource(err) },
      "mirror: ENFORCE with an unmapped chair - dashboard create refused",
    );
    res.status(409).json({ error: "slot_unavailable_external" });
    return true;
  }
  return false;
}
