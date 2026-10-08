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
