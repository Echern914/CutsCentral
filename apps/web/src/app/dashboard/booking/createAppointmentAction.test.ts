import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * createAppointmentAction against a stubbed fetch: what is SENT, and what of
 * the API's answer survives to the screen.
 *  - the saved booking a retried id already made (`booked`) is kept, so the
 *    form can name it instead of claiming the choice on screen;
 *  - across a deploy (web and API ship separately) an API from before
 *    `operationId` refuses it with 400 and books nothing: the action books the
 *    way this screen used to, rather than New appointment going dead.
 */
vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], get: () => undefined }),
  headers: () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const sentBody = (i: number) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body));

const { createAppointmentAction } = await import("./actions");

const input = {
  staffId: "stf1",
  serviceId: "svc1",
  startsAt: "2026-10-09T15:00:00.000Z",
  clientId: "cl1",
  operationId: "op-1234567890abcdef",
};

beforeEach(() => fetchMock.mockReset());

describe("🔴 a gateway error is not a refusal", () => {
  it("502, 503, 504 and a 500 come back as UNKNOWN (answered: false), a 409 as answered", async () => {
    for (const status of [502, 503, 504, 500]) {
      fetchMock.mockResolvedValueOnce(reply(status, {}));
      expect(await createAppointmentAction(input)).toMatchObject({ ok: false, answered: false });
    }
    fetchMock.mockResolvedValueOnce(reply(409, { error: "slot_taken" }));
    expect(await createAppointmentAction(input)).toMatchObject({ ok: false, answered: true, error: "slot_taken" });
  });

  it("🔴 the server saves the booking, the answer comes back 502, the retry with the same id: exactly ONE booking", async () => {
    // A stand-in for the API's operationId rule: the first copy books and the
    // proxy loses the answer; a copy with an id already used is answered from
    // what that id booked.
    const saved = new Map<string, { id: string; startsAt: string; endsAt: string }>();
    let calls = 0;
    fetchMock.mockImplementation(async (_url?: string, init?: RequestInit) => {
      if (!init?.body) return reply(404, {}); // not the create call
      calls += 1;
      const body = JSON.parse(String(init.body)) as { operationId: string; startsAt: string };
      const prior = saved.get(body.operationId);
      if (prior) return reply(200, { ok: true, ...prior, replayed: true });
      const booking = { id: `appt${saved.size + 1}`, startsAt: body.startsAt, endsAt: "2026-10-09T15:30:00.000Z" };
      saved.set(body.operationId, booking);
      return reply(502, "<html>Bad Gateway</html>");
    });
    const first = await createAppointmentAction(input);
    expect(first).toMatchObject({ ok: false, answered: false });
    const retry = await createAppointmentAction(input);
    expect(retry).toMatchObject({ ok: true, id: "appt1", replayed: true });
    expect(calls).toBe(2);
    expect(saved.size).toBe(1);
  });
});

describe("createAppointmentAction", () => {
  it("passes the saved times and the replay flag through", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { ok: true, id: "a1", startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z", replayed: true }),
    );
    const r = await createAppointmentAction(input);
    expect(r).toMatchObject({ ok: true, id: "a1", startsAt: "2026-10-02T15:00:00.000Z", replayed: true });
  });

  it("🔴 keeps the booking a mismatched retry names", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(409, {
        error: "operation_mismatch",
        reason: "Your earlier tap already booked a different time or service.",
        booked: { id: "old1", startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z", staffId: "x" },
      }),
    );
    const r = await createAppointmentAction(input);
    expect(r).toMatchObject({
      ok: false,
      answered: true,
      error: "operation_mismatch",
      booked: { id: "old1", startsAt: "2026-10-02T15:00:00.000Z", endsAt: "2026-10-02T15:30:00.000Z" },
    });
  });

  it("🔴 an API from before operationId refuses only that: book again WITHOUT it, once", async () => {
    fetchMock
      .mockResolvedValueOnce(
        reply(400, { error: "invalid_input", issues: [{ path: [], message: "Unrecognized key(s) in object: 'operationId'" }] }),
      )
      .mockResolvedValueOnce(reply(201, { ok: true, id: "a2" }));
    const r = await createAppointmentAction(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(1)).not.toHaveProperty("operationId");
    expect(sentBody(1)).toMatchObject({ staffId: "stf1", clientId: "cl1" });
    expect(r).toMatchObject({ ok: true, id: "a2" });
  });

  it("a real validation refusal is never resent", async () => {
    fetchMock.mockResolvedValueOnce(
      reply(400, { error: "invalid_input", issues: [{ path: ["startsAt"], message: "Invalid date" }] }),
    );
    const r = await createAppointmentAction(input);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: false, error: "invalid_input" });
  });
});
