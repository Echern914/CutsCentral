import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 A CHECKOUT REFUSAL CARRIES THE ANSWER, AND THE ACTION MUST KEEP IT.
 *
 * The checkout routes answer an uncertain charge with a non-2xx status AND a
 * body that says what happened: 409 `result: "ambiguous"` ("do not collect
 * again"), 409 `requires_action`, 402 `declined`, 409 `amount_not_authorized`
 * with the real `dueCents`. The API client kept a body only for a 2xx, so all
 * of it arrived as `{ ok: false, error: "http_409" }` - which the screen worded
 * as "Nothing was charged". These run the real actions against a stubbed fetch,
 * because a test that mocks the action already returning `result` cannot see
 * the body being dropped.
 */

vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], get: () => undefined }),
  headers: () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

const { chargeSavedCardAction, recordCashCheckoutAction, startTapToPayAction } = await import("./actions");

beforeEach(() => fetchMock.mockReset());

const ATTEMPT = { id: "att_1", state: "ambiguous", method: "saved_card", amountCents: 4500 };

describe("the checkout actions keep a refusal's body", () => {
  it("🔴 409 ambiguous arrives as ambiguous, with the attempt and the warning", async () => {
    answer(409, {
      result: "ambiguous",
      attempt: ATTEMPT,
      message: "We could not confirm whether that card was charged. Do not collect again.",
    });
    const res = await chargeSavedCardAction("appt_1", { amountCents: 4500, requestId: "req_123456789012" });
    expect(res.ok).toBe(false);
    expect(res.result).toBe("ambiguous");
    expect(res.attempt?.state).toBe("ambiguous");
    expect(res.message).toMatch(/Do not collect again/);
  });

  it("402 declined arrives as declined", async () => {
    answer(402, { result: "declined", attempt: { ...ATTEMPT, state: "failed" }, reason: "card_declined" });
    const res = await chargeSavedCardAction("appt_1", { amountCents: 4500, requestId: "req_123456789012" });
    expect(res.result).toBe("declined");
  });

  it("409 amount_not_authorized keeps the real balance", async () => {
    answer(409, { error: "amount_not_authorized", dueCents: 5000 });
    const res = await recordCashCheckoutAction("appt_1", {
      amountCents: 4500,
      method: "cash",
      requestId: "req_123456789012",
      confirmed: true,
    });
    expect(res.error).toBe("amount_not_authorized");
    expect(res.dueCents).toBe(5000);
  });

  it("a Tap to Pay refusal keeps the attempt that blocks it", async () => {
    answer(409, { error: "collection_in_progress", liveAttempt: ATTEMPT });
    const res = await startTapToPayAction("appt_1", { amountCents: 4500, requestId: "req_123456789012" });
    expect(res.error).toBe("collection_in_progress");
    expect(res.liveAttempt?.id).toBe("att_1");
  });

  it("a success still reads as one", async () => {
    answer(200, { result: "paid", amountCents: 4500, attempt: { ...ATTEMPT, state: "succeeded" } });
    const res = await chargeSavedCardAction("appt_1", { amountCents: 4500, requestId: "req_123456789012" });
    expect(res.ok).toBe(true);
    expect(res.result).toBe("paid");
  });
});
