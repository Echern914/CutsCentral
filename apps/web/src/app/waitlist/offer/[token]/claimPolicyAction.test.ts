import { describe, expect, it, vi, beforeEach } from "vitest";

const send = vi.fn();
vi.mock("@/lib/api", () => ({ apiPublicSend: (...args: unknown[]) => send(...args) }));

const { claimOfferAction } = await import("./actions");

/**
 * The claim action's half of "Before you book": the version rides along, and
 * the API's policy refusal comes back AS a policy refusal. A POLICY_CHANGED is
 * a 409, and a 409 otherwise means "that time got taken" - read that way, a
 * client who only needed to tick a new line would be told their spot is gone.
 */

const POLICY = { text: null, checklist: ["On time"], version: "v2v2v2v2v2v2v2v2" };

beforeEach(() => send.mockReset());

describe("claimOfferAction and the policy", () => {
  it("sends the version the client ticked", async () => {
    send.mockResolvedValueOnce({ ok: true, status: 201, data: { ok: true, startsAt: "s", shopSlug: null, pending: false } });
    await claimOfferAction("tok", { email: "a@b.co", policyVersion: "v1v1v1v1v1v1v1v1" });
    expect(send).toHaveBeenCalledWith("POST", "/api/book/offer/tok/claim", {
      email: "a@b.co",
      policyVersion: "v1v1v1v1v1v1v1v1",
    });
  });

  it("🔴 POLICY_CHANGED (a 409) is a policy refusal with the new words, not 'taken'", async () => {
    send.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: "policy_changed", code: "POLICY_CHANGED", policy: POLICY });
    expect(await claimOfferAction("tok", {})).toEqual({ ok: false, reason: "policy", policy: POLICY });
  });

  it("POLICY_NOT_ACCEPTED (a 422) is a policy refusal too", async () => {
    send.mockResolvedValueOnce({ ok: false, status: 422, data: null, error: "policy_not_accepted", code: "POLICY_NOT_ACCEPTED", policy: POLICY });
    expect(await claimOfferAction("tok", {})).toEqual({ ok: false, reason: "policy", policy: POLICY });
  });

  it("a plain 409 is still 'that time got taken'", async () => {
    send.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: "slot_taken", code: "SLOT_UNAVAILABLE" });
    expect(await claimOfferAction("tok", {})).toEqual({ ok: false, reason: "gone" });
  });
});
