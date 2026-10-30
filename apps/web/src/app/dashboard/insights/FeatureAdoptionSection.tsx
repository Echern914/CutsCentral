import type { FeatureAdoptionResponse } from "@chairback/config/featureAdoption";
import { apiGet } from "@/lib/api";
import { FeatureAdoptionCard } from "./FeatureAdoptionCard";

/**
 * Server-side loader for the "What other shops use" card, kept out of
 * InsightsClient so the card mounts with one line on the page. Any failure,
 * and an empty answer (the API's privacy floor), draws nothing.
 */
export async function FeatureAdoptionSection() {
  // apiGet never throws: a request that never completed is `ok: false`.
  const res = await apiGet<FeatureAdoptionResponse>("/api/insights/feature-adoption");
  const features = res.ok ? (res.data?.features ?? []) : [];
  if (features.length === 0) return null;
  return (
    <div className="mt-6">
      <FeatureAdoptionCard features={features} />
    </div>
  );
}
