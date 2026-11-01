// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The iOS app's billing button lands here in Safari with a one-time code, and
 * the barber arrives on the plan cards ALREADY SIGNED IN, in the shop the app
 * was showing - the website has no Apple sign-in, so asking an Apple-ID barber
 * to sign in was a dead end (2026-11-01).
 */
vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => undefined }),
  headers: () => new Headers(),
}));

const { GET } = await import("./route");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
afterEach(() => fetchMock.mockReset());

function landing(code?: string): NextRequest {
  const url = new URL("https://getchairback.com/auth/billing/landing");
  if (code) url.searchParams.set("code", code);
  return new NextRequest(url, { headers: { host: "getchairback.com" } });
}

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

const setCookies = (res: Response) => res.headers.getSetCookie().join("\n");

describe("/auth/billing/landing", () => {
  it("🔴 a good code: signed in, in the app's shop, on the plan cards", async () => {
    answer(200, { token: "TOKEN", shopId: "shop_team" });
    const res = await GET(landing("CODE.sig"));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).hash).toBe(
      "/dashboard/billing#plans",
    );
    const cookies = setCookies(res);
    expect(cookies).toMatch(/cb_session=TOKEN/);
    expect(cookies).toMatch(/cb_active_shop=shop_team/);
    expect(cookies).toMatch(/HttpOnly/i);

    // Exchanged server-to-server with the code from the URL.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/auth\/billing\/exchange$/);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ code: "CODE.sig" });
  });

  it("no shop handed back: signed in, and the active-shop choice is left alone", async () => {
    answer(200, { token: "TOKEN", shopId: null });
    const res = await GET(landing("CODE.sig"));
    expect(setCookies(res)).toMatch(/cb_session=TOKEN/);
    expect(setCookies(res)).not.toMatch(/cb_active_shop/);
  });

  it.each([
    ["an expired or used code", () => answer(401, { error: "invalid_code" }), "CODE.sig"],
    ["no code at all", () => {}, undefined],
  ])("%s: no dead end - the plan cards, where the sign-in gate takes over; no session set", async (_l, setup, code) => {
    setup();
    const res = await GET(landing(code));
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname + to.hash).toBe("/dashboard/billing#plans");
    expect(setCookies(res)).not.toMatch(/cb_session=/);
  });
});
