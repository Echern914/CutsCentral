import { ACUITY, apiEnv } from "@chairback/config";
import { logger } from "../logger.js";

const env = apiEnv();

/**
 * Per-account dynamic webhook subscription for OAuth apps.
 *
 * [VERIFY LIVE] The exact Dynamic Webhooks endpoint/payload is under-documented
 * publicly. Based on Acuity's docs the shape is POST /webhooks with { event,
 * target }. We subscribe one target per shop pointing at the unguessable
 * per-shop URL. If the call fails we log and continue (the barber can retry from
 * the dashboard) - connection itself still succeeds.
 *
 * Returns the created subscription ids (best-effort).
 */
export async function subscribeShopWebhooks(params: {
  accessToken: string;
  webhookSecret: string;
}): Promise<string[]> {
  const target = `${env.API_BASE_URL}/webhooks/acuity/${params.webhookSecret}`;
  const ids: string[] = [];

  for (const event of ACUITY.actions) {
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
        logger.warn(
          { event, status: res.status },
          "acuity webhook subscription failed (verify-live endpoint)",
        );
        continue;
      }
      const data = (await res.json()) as { id?: string | number };
      if (data?.id != null) ids.push(String(data.id));
    } catch (err) {
      logger.warn({ event, err }, "acuity webhook subscription error");
    }
  }
  return ids;
}
