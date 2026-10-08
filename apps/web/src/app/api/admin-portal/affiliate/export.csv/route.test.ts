import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 THE ADMIN "Export CSV" LINK RESOLVES TO THE WEB ORIGIN, which had no such
 * route - the operator got a 404. This bridge forwards the session cookie to
 * the API's export and hands back the file; the API still decides who may
 * have it.
 */

vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [{ name: "cb_session", value: "s1" }] }),
}));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { GET } = await import("./route");

beforeEach(() => fetchMock.mockReset());

describe("GET /api/admin-portal/affiliate/export.csv", () => {
  it("returns the API's CSV, sent with the visitor's session", async () => {
    fetchMock.mockResolvedValue(
      new Response("code,signups\nABC,3\n", { status: 200, headers: { "content-type": "text/csv" } }),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("code,signups\nABC,3\n");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/admin-portal\/affiliate\/export\.csv$/);
    expect((init as { headers: Record<string, string> }).headers.cookie).toBe("cb_session=s1");
  });

  it("passes a refusal through, never a file", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    expect((await GET()).status).toBe(404);
  });
});
