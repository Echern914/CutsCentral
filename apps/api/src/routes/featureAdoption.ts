import { Router } from "express";
import {
  ADOPTION_FEATURES,
  type FeatureAdoptionResponse,
} from "@chairback/config";
import { hasPremiumAccess } from "../billing/entitlements.js";
import { getFeatureAdoptionTotals, shopFeatureUsage } from "../engines/featureAdoption.js";

/**
 * GET /api/insights/feature-adoption - "What other shops use".
 *
 * Mounted under insightsRouter, so it inherits that router's gates: a
 * signed-in OWNER/MANAGER of a shop with active access. Deliberately NOT
 * behind requirePremiumAccess: a Starter shop seeing that most shops use a
 * Premium feature is the point.
 *
 * Per row: the platform percentage (cached, see engines/featureAdoption.ts),
 * whether THIS shop uses it, whether THIS shop's plan includes it, and where
 * to turn it on. Below the privacy floor: `{ features: [] }` and the card
 * draws nothing.
 */
export const featureAdoptionRouter: Router = Router();

featureAdoptionRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const totals = await getFeatureAdoptionTotals();
  if (!totals) {
    const empty: FeatureAdoptionResponse = { features: [] };
    res.json(empty);
    return;
  }
  const usage = await shopFeatureUsage(shop.id);
  // The same Premium question Insights' own scope asks (insightsScopeFor).
  const premium = hasPremiumAccess(shop);
  const body: FeatureAdoptionResponse = {
    features: ADOPTION_FEATURES.map((f) => ({
      id: f.id,
      label: f.label,
      href: f.href,
      pct: totals.pct[f.id],
      youUseIt: usage[f.id],
      inYourPlan: f.gate === "all" || premium,
    })),
  };
  res.json(body);
});
