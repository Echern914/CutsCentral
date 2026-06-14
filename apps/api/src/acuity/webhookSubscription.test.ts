import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeShopWebhooks } from "./webhookSubscription.js";

/**
 * Guards the bug that left every shop with 0 webhook subscriptions: the Dynamic
 * Webhooks API requires DOTTED event names ("appointment.scheduled"); bare names
 * ("scheduled") are silently rejected. These tests assert we send dotted names
 * and that failures are surfaced (not swallowed).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("subscribeShopWebhooks", () => {
  it("POSTs DOTTED event names and a per-shop target, returning ids", async () => {
    const seen: { event: string; target: string }[] = [];
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { event: string; target: string };
        seen.push(body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: ++n }),
        } as Response;
      }),
    );

    const { ids, failures } = await subscribeShopWebhooks({
      accessToken: "tok",
      webhookSecret: "secret123",
    });

    // One subscription per dotted event.
    expect(seen.map((s) => s.event).sort()).toEqual([
      "appointment.canceled",
      "appointment.changed",
      "appointment.rescheduled",
      "appointment.scheduled",
    ]);
    // Every event must be dotted - the exact bug we're guarding.
    expect(seen.every((s) => s.event.startsWith("appointment."))).toBe(true);
    // Target points at the per-shop unguessable webhook URL.
    expect(seen.every((s) => s.target.endsWith("/webhooks/acuity/secret123"))).toBe(true);
    expect(ids).toHaveLength(4);
    expect(failures).toHaveLength(0);
  });

  it("surfaces failures instead of swallowing them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => "Bad event name",
      }) as unknown as Response),
    );

    const { ids, failures } = await subscribeShopWebhooks({
      accessToken: "tok",
      webhookSecret: "secret123",
    });

    expect(ids).toHaveLength(0);
    expect(failures).toHaveLength(4);
    expect(failures[0]?.status).toBe(400);
  });
});
