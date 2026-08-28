import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { toE164 } from "../acuity/clientKey.js";
import { recoveryReadLimiter, recoverySmsLimiter } from "../middleware/rateLimit.js";
import {
  listRecoveryShops,
  requestRecoveryChallenge,
  selectRecoveryShop,
  verifyRecoveryChallenge,
} from "../services/rewardsRecovery.js";

/**
 * Rewards recovery over HTTP: enter phone -> verify -> choose business ->
 * open rewards. The customer-side answer to "I lost the text with my link".
 *
 * THE CONSTANCY CONTRACT. Until verification succeeds, every response is
 * independent of what the platform knows: challenge answers `{ok:true}` for
 * known, unknown, single-shop and multi-shop numbers alike (and for numbers
 * that failed a ceiling - the SMS simply does not arrive), and every verify
 * failure is one `{verified:false}`. Nothing before the proof reveals whether
 * the phone exists, how many shops match, which ones, whether rewards exist,
 * whether any row opted out, or whether the customer is active. Absence of a
 * shop from the post-verification chooser is equally silent.
 *
 * CONSENT. The challenge SMS is customer-initiated transactional verification
 * of a number the customer just typed - the walk-in kiosk precedent, which
 * sends its OTP with no stored-consent check for the same reason. Shop-level
 * consent rules govern SHOP-initiated sends and nothing here is one; no
 * shop-specific message of any kind is sent by this flow.
 *
 * Tokens and proofs travel in POST bodies only - never in a URL - so no
 * logRedaction entry is needed for these paths.
 */
export const rewardsRecoveryRouter: Router = Router();

const ok = (res: Response): void => {
  res.json({ ok: true });
};

function callerIp(req: Request): string {
  return req.ip ?? "unknown";
}

const phoneSchema = z.object({ phone: z.string().min(1).max(40) }).strict();

rewardsRecoveryRouter.post("/challenge", recoverySmsLimiter, async (req, res) => {
  const parsed = phoneSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const phone = toE164(parsed.data.phone);
  // An unparseable number gets the same ok as everything else: its SMS simply
  // never arrives, exactly like a number we've never heard of.
  if (!phone) {
    ok(res);
    return;
  }

  // Everything - eligibility, cooldown, budgets, the send itself - is the
  // shared service's; this route only answers. The send is fire-and-forget
  // inside the service, so the ok below leaves before any provider work on
  // EVERY path, and no outcome (including "this phone is unknown to us") is
  // logged or echoed from here.
  await requestRecoveryChallenge({ phone, ip: callerIp(req), now: new Date() });
  ok(res);
});

const verifySchema = z
  .object({ phone: z.string().min(1).max(40), code: z.string().min(1).max(12) })
  .strict();

rewardsRecoveryRouter.post("/verify", recoverySmsLimiter, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const phone = toE164(parsed.data.phone);
  if (!phone) {
    res.json({ verified: false });
    return;
  }
  const outcome = await verifyRecoveryChallenge({
    phone,
    code: parsed.data.code,
    now: new Date(),
  });
  res.json(outcome);
});

const proofSchema = z.object({ proof: z.string().min(20).max(512) }).strict();

rewardsRecoveryRouter.post("/shops", recoveryReadLimiter, async (req, res) => {
  const parsed = proofSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const shops = await listRecoveryShops({ proof: parsed.data.proof, now: new Date() });
  // Bad, expired, consumed and never-issued proofs are one refusal.
  if (!shops) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ shops });
});

const selectSchema = z
  .object({ proof: z.string().min(20).max(512), selectionId: z.string().min(1).max(64) })
  .strict();

rewardsRecoveryRouter.post("/select", recoveryReadLimiter, async (req, res) => {
  const parsed = selectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const outcome = await selectRecoveryShop({
    proof: parsed.data.proof,
    selectionId: parsed.data.selectionId,
    now: new Date(),
  });
  if (!outcome.ok) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true, url: outcome.rewardsUrl });
});
