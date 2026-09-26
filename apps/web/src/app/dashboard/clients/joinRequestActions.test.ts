import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's Accept, relayed. The API now refuses (409 needs_connecting) to
 * report a customer it could not add; this action must turn that into words
 * the owner can act on - never into success, which is what made an accepted
 * customer silently vanish.
 */

const apiSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiSend: (...a: unknown[]) => apiSend(...a) }));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

const { answerJoinRequestAction } = await import("./joinRequestActions");

beforeEach(() => {
  apiSend.mockReset();
  revalidatePath.mockReset();
});

describe("answerJoinRequestAction", () => {
  it("an accept that added the customer is a success, and refreshes the page", async () => {
    apiSend.mockResolvedValue({ ok: true, status: 200, data: { ok: true, status: "joined" } });
    expect(await answerJoinRequestAction("req_1", "accept")).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/clients");
  });

  it("🔴 an accept that could NOT add them is not a success - it says why and what fixes it", async () => {
    apiSend.mockResolvedValue({ ok: false, status: 409, data: null, error: "needs_connecting" });
    const r = await answerJoinRequestAction("req_1", "accept");
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expect(error).toMatch(/not added yet/i);
    expect(error).toMatch(/already on your client list/i);
    expect(error).toMatch(/merge/i);
    expect(error).toMatch(/rewards link/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an already-answered request and any other failure keep their existing wording", async () => {
    apiSend.mockResolvedValue({ ok: false, status: 404, data: null, error: "not_found" });
    expect(await answerJoinRequestAction("req_1", "accept")).toEqual({
      ok: false,
      error: "That request was already answered.",
    });
    apiSend.mockResolvedValue({ ok: false, status: 500, data: null, error: "internal" });
    expect(await answerJoinRequestAction("req_1", "decline")).toEqual({
      ok: false,
      error: "Couldn't save that. Try again.",
    });
  });
});
