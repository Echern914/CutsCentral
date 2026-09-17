import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE LINK IN THE CHAIN THE COMPONENT TEST CANNOT SEE.
 *
 * `WalkInConflictWarning.test.tsx` mocks `./actions`, so it proves the warning
 * RENDERS when a conflict arrives — and nothing at all about whether a conflict
 * ever arrives. Falsification showed exactly that: gutting the real action's
 * return to `{ ok: true }` left every component test green.
 *
 * 🔴 THAT IS THE ORIGINAL BUG'S SHAPE. `done()` discards the response body and
 * returns `{ok}`, which is how a recorded-but-conflicting receipt reached the
 * barber as a plain success. This file is the assertion that the server's
 * answer survives the trip, so the two halves together cover the whole path.
 */
const apiSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiSend, apiGet: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { recordWalkInAction } = await import("./actions");

beforeEach(() => apiSend.mockReset());

describe("recordWalkInAction preserves what the server said", () => {
  it("🔴 carries the conflict through instead of flattening it to {ok}", async () => {
    apiSend.mockResolvedValue({
      ok: true,
      data: { ok: true, id: "appt-9", conflict: { withAppointmentIds: ["other-1"] } },
    });
    const res = await recordWalkInAction({ amount: 30 });
    expect(res.ok).toBe(true);
    expect(res).toHaveProperty("conflict");
    expect(res.ok && res.conflict?.withAppointmentIds).toEqual(["other-1"]);
  });

  it("reports a clean receipt as clean — no phantom conflict", async () => {
    apiSend.mockResolvedValue({ ok: true, data: { ok: true, id: "appt-9" } });
    const res = await recordWalkInAction({ amount: 30 });
    expect(res.ok).toBe(true);
    expect(res.ok && res.conflict).toBeUndefined();
  });

  it("carries a conflict that names nothing — a visit or a block", async () => {
    // An empty id list still means a collision; flattening it to "no conflict"
    // would under-report the case the external calendar makes likeliest.
    apiSend.mockResolvedValue({
      ok: true,
      data: { ok: true, id: "a", conflict: { withAppointmentIds: [] } },
    });
    const res = await recordWalkInAction({ amount: 30 });
    expect(res.ok && res.conflict?.withAppointmentIds).toEqual([]);
  });

  it("passes the operation id straight through to the API", async () => {
    apiSend.mockResolvedValue({ ok: true, data: { ok: true, id: "a" } });
    await recordWalkInAction({ amount: 30, operationId: "op-abc123xyz" });
    expect(apiSend).toHaveBeenCalledWith(
      "POST",
      "/api/booking/appointments/walk-in",
      expect.objectContaining({ operationId: "op-abc123xyz" }),
    );
  });

  it("surfaces a failure rather than inventing success", async () => {
    apiSend.mockResolvedValue({ ok: false, error: "staff_required" });
    const res = await recordWalkInAction({ amount: 30 });
    expect(res).toEqual({ ok: false, error: "staff_required" });
  });
});
