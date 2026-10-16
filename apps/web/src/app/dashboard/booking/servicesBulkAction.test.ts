import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 Saving a pasted menu tells the truth about what the API did. A 400 is the
 * API's own answer - nothing was saved, say so. Only no answer at all (status
 * 0) or a 5xx is unknown, and only then is "tap Add again" the message. The
 * first cut passed the whole result to apiAnswered (which takes a status), so
 * every failure read as "no answer".
 */
const apiSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiSend, apiGet: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createServicesBulkAction } = await import("./actions");
const rows = [{ name: "Taper", durationMin: 45, price: 40 }];

beforeEach(() => apiSend.mockReset());

describe("createServicesBulkAction", () => {
  it("passes back what was made and what was skipped", async () => {
    apiSend.mockResolvedValue({ ok: true, status: 201, data: { created: 1, skipped: ["Beard"] } });
    expect(await createServicesBulkAction(rows)).toEqual({ ok: true, created: 1, skipped: ["Beard"] });
  });

  it("🔴 a refusal (400) is an answer: nothing saved", async () => {
    apiSend.mockResolvedValue({ ok: false, status: 400, error: "invalid_input" });
    expect(await createServicesBulkAction(rows)).toEqual({ ok: false, answered: true });
  });

  it("no answer, or a 5xx, is unknown", async () => {
    for (const status of [0, 502]) {
      apiSend.mockResolvedValue({ ok: false, status });
      expect(await createServicesBulkAction(rows)).toEqual({ ok: false, answered: false });
    }
  });
});
