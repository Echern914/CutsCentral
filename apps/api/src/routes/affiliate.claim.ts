import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { captureClaim } from "../services/affiliateAttribution.js";

/**
 * The PUBLIC end of attribution: turn a referral code into a signed claim.
 *
 * Called server-to-server by the web app's /join route, never by a browser
 * (the CSP forbids that anyway). It exists as its own tiny router because the
 * rest of /api/affiliate is behind requireUser/requireShop/requireOwner and a
 * visitor following a referral link has none of those.
 *
 * 🔴 THE RESPONSE IS NEUTRAL. An unknown code, a suspended affiliate, a
 * malformed body and a code belonging to a shop that has since been deleted
 * all produce exactly the same 200 `{ claim: null }`. Nothing here reveals
 * whether an affiliate exists, whether it was suspended, or anything at all
 * about a tenant - and no branch echoes back what the caller sent.
 */
export const affiliateClaimRouter: Router = Router();

/** Dark-launch gate. 404 while the program is off, before anything else runs,
 *  so the surface is indistinguishable from one that was never mounted. */
function requireAffiliateProgram(
  _req: Request,
  res: Response,
  next: () => void,
): void {
  if (!apiEnv().AFFILIATE_PROGRAM_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

affiliateClaimRouter.use(requireAffiliateProgram);

/** Liveness probe for the web /join surface: 200 when the program is live,
 *  404 (from the gate above) when it is dark. Reveals nothing else. */
affiliateClaimRouter.get("/", (_req, res) => {
  res.json({ ok: true });
});

const claimSchema = z
  .object({
    code: z.string().max(64),
    source: z.enum(["link", "explicit_code"]).default("link"),
  })
  .strict();

const NEUTRAL = { claim: null, maxAgeSeconds: 0 } as const;

affiliateClaimRouter.post("/", async (req, res) => {
  const parsed = claimSchema.safeParse(req.body ?? {});
  // Even a malformed body gets the neutral answer: a 400 here would confirm
  // the shape of a surface whose whole job is to say nothing.
  if (!parsed.success) {
    res.json(NEUTRAL);
    return;
  }
  const minted = await captureClaim({
    rawCode: parsed.data.code,
    source: parsed.data.source,
  });
  res.json(minted ?? NEUTRAL);
});
