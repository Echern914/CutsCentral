import { ACUITY, apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

const env = apiEnv();

export interface SubscribeResult {
  ids: string[];
  /** events that failed to subscribe, with the HTTP status (or 0 on throw) */
  failures: { event: string; status: number; body?: string }[];
}

/**
 * Per-account dynamic webhook subscription for OAuth apps.
 *
 * POST /webhooks with { event, target } per the Dynamic Webhooks API. Events
 * MUST be the dotted names (ACUITY.subscriptionEvents) - bare names ("scheduled")
 * are rejected and create nothing. We point one target per event at the
 * unguessable per-shop URL. The target must be on port 80/443 (Acuity rule).
 *
 * Returns created ids AND failures so the caller can surface a broken sync
 * instead of silently swallowing it (the previous best-effort-only version hid
 * the bare-vs-dotted bug for weeks).
 */
export async function subscribeShopWebhooks(params: {
  accessToken: string;
  webhookSecret: string;
}): Promise<SubscribeResult> {
  const target = `${env.API_BASE_URL}/webhooks/acuity/${params.webhookSecret}`;
  const ids: string[] = [];
  const failures: { event: string; status: number; body?: string }[] = [];

  for (const event of ACUITY.subscriptionEvents) {
    try {
      const res = await fetch(`${ACUITY.apiBase}/webhooks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event, target }),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        logger.warn({ event, status: res.status, body }, "acuity webhook subscription failed");
        failures.push({ event, status: res.status, body });
        continue;
      }
      const data = (await res.json()) as { id?: string | number };
      if (data?.id != null) ids.push(String(data.id));
      else failures.push({ event, status: res.status, body: "no id in response" });
    } catch (err) {
      logger.warn({ event, err }, "acuity webhook subscription error");
      failures.push({ event, status: 0, body: (err as Error).message });
    }
  }
  return { ids, failures };
}
