import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LOG VISIT ACROSS A DEPLOY. The web (Vercel) and the API (Railway) ship
 * separately, so for a few minutes the new screen can talk to the API it was
 * written before. That API's strict schema refuses the new `requestId` /
 * `separateVisit` with 400 and writes nothing - the action then logs the visit
 * the way this screen always did, rather than leaving Log visit dead. Run
 * against a stubbed fetch, so what is checked is what is actually SENT.
 */
vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], get: () => undefined }),
  headers: () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const sentBody = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body));

const { logVisitAction } = await import("./actions");

beforeEach(() => fetchMock.mockReset());

describe("logVisitAction", () => {
  it("sends the tap's requestId, and reports a replay", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, balance: 3, replayed: true }));
    const r = await logVisitAction("cl1", undefined, undefined, { requestId: "tap-1234567890abcdef" });
    expect(sentBody(0)).toEqual({ requestId: "tap-1234567890abcdef" });
    expect(r).toMatchObject({ ok: true, balance: 3, replayed: true });
  });

  it("🔴 an API from before requestId refuses it: resend WITHOUT the new fields, once", async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply(400, {
          error: "invalid_input",
          issues: [{ path: [], message: "Unrecognized key(s) in object: 'requestId', 'separateVisit'" }],
        }),
      )
      .mockResolvedValueOnce(reply(201, { ok: true, balance: 1 }));
    const r = await logVisitAction("cl1", undefined, "card1", {
      requestId: "tap-1234567890abcdef",
      separateVisit: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1)).toEqual({ cardTypeId: "card1" });
    expect(r).toMatchObject({ ok: true, balance: 1 });
  });

  it("any other refusal is reported as it is - never resent", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(409, { error: "visit_on_books", message: "Already on the books that day: Thu 9:00 AM · Haircut" }),
    );
    const r = await logVisitAction("cl1", undefined, undefined, { requestId: "tap-1234567890abcdef" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, error: "visit_on_books", status: 409 });
    expect(r.message).toContain("Already on the books");
  });
});
