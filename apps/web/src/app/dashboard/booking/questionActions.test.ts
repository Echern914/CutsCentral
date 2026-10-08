import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 The booking-question actions tell the truth about what the API did:
 * create hands back the REAL id (so the card can edit or remove what it just
 * added), and a DELETE that removed nothing (200 { ok: false }) is not a
 * removal - it used to read "Removed." over a question still on the form.
 */

const apiSend = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiSend, apiGet: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createBookingQuestionAction, deleteBookingQuestionAction } = await import("./actions");

beforeEach(() => apiSend.mockReset());

describe("booking question actions", () => {
  it("create returns the id the API made", async () => {
    apiSend.mockResolvedValue({ ok: true, status: 201, data: { id: "q_real_1" } });
    const res = await createBookingQuestionAction({ label: "Gate code", kind: "text", required: false } as never);
    expect(res).toMatchObject({ ok: true, id: "q_real_1" });
  });

  it("🔴 a delete that removed nothing is not ok", async () => {
    apiSend.mockResolvedValue({ ok: true, status: 200, data: { ok: false } });
    expect((await deleteBookingQuestionAction("pending-123")).ok).toBe(false);
  });

  it("a real delete is ok", async () => {
    apiSend.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    expect((await deleteBookingQuestionAction("q_real_1")).ok).toBe(true);
  });
});
