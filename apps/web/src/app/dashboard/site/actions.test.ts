import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE LINK THE EDITOR TEST CANNOT SEE.
 *
 * `PageEditor.test.tsx` mocks `./actions`, so it proves the editor HANDS the
 * privacy flag to the save - and nothing about whether the flag reaches the
 * API. The action rebuilds the PATCH body from a whitelist (extra keys are
 * dropped on purpose), so a field missing from that list saves as a silent
 * no-op: the switch would flip, "Your page is saved" would show, and the
 * street would stay on Google.
 */
const apiSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiSend, apiGet: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { savePageAction } = await import("./actions");

beforeEach(() => {
  apiSend.mockReset();
  apiSend.mockResolvedValue({ ok: true, data: {} });
});

describe("savePageAction", () => {
  it("🔴 forwards the address privacy flag, both ways", async () => {
    expect(await savePageAction({ addressPrivate: true })).toEqual({ ok: true });
    expect(apiSend).toHaveBeenLastCalledWith("PATCH", "/api/shops/me", { addressPrivate: true });

    await savePageAction({ addressPrivate: false });
    expect(apiSend).toHaveBeenLastCalledWith("PATCH", "/api/shops/me", { addressPrivate: false });
  });

  it("still drops keys that are not page fields", async () => {
    await savePageAction({ addressPrivate: true, bogus: 1 } as never);
    expect(apiSend).toHaveBeenLastCalledWith("PATCH", "/api/shops/me", { addressPrivate: true });
  });
});
