import { beforeEach, describe, expect, it, vi } from "vitest";
import { AFFILIATE_CLAIM_COOKIE } from "@chairback/config";

/**
 * THE SEAM that makes affiliate attribution survive every sign-in door.
 *
 * Attribution deliberately never enters the OAuth channel: the claim is an
 * HttpOnly cookie on the WEB origin, and what carries it to the API is this
 * server-side client forwarding its own cookies on `POST /api/shops`. Injecting
 * the cookie straight into an API test proves the API reads it; it does NOT
 * prove the web server sends it. This does.
 *
 * If `authHeader()` ever stopped forwarding cookies wholesale, Google, Apple,
 * password and mobile attribution would all break at once and every API-level
 * test would still pass - which is exactly why this seam gets its own test.
 */

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () =>
      [...cookieStore].map(([name, value]) => ({ name, value })),
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: () => new Map(),
}));

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 201,
  json: async () => ({ id: "shop_1" }),
}));
vi.stubGlobal("fetch", fetchMock);

const CLAIM = "eyJwYXlsb2FkIjoxfQ.c2lnbmF0dXJl";

beforeEach(() => {
  cookieStore.clear();
  fetchMock.mockClear();
});

function sentCookieHeader(): string {
  const init = fetchMock.mock.calls[0]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers?.Cookie ?? "";
}

describe("the web -> API seam forwards the affiliate claim", () => {
  it("🔴 includes the HttpOnly claim cookie on the shop-creation request", async () => {
    cookieStore.set("cb_session", "session-token-value");
    cookieStore.set(AFFILIATE_CLAIM_COOKIE, CLAIM);

    const { apiSend } = await import("./api");
    await apiSend("POST", "/api/shops", { name: "Test Shop" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cookie = sentCookieHeader();
    // Both cookies travel: the session authenticates the owner, the claim is
    // what the API locks attribution against.
    expect(cookie).toContain(`${AFFILIATE_CLAIM_COOKIE}=${CLAIM}`);
    expect(cookie).toContain("cb_session=session-token-value");
  });

  it("sends the claim VERBATIM - it is a signature, and any mangling invalidates it", async () => {
    cookieStore.set(AFFILIATE_CLAIM_COOKIE, CLAIM);
    const { apiSend } = await import("./api");
    await apiSend("POST", "/api/shops", {});
    const forwarded = sentCookieHeader()
      .split("; ")
      .find((c) => c.startsWith(`${AFFILIATE_CLAIM_COOKIE}=`));
    expect(forwarded).toBe(`${AFFILIATE_CLAIM_COOKIE}=${CLAIM}`);
  });

  it("sends no Cookie header at all when the browser holds none", async () => {
    const { apiSend } = await import("./api");
    await apiSend("POST", "/api/shops", {});
    expect(sentCookieHeader()).toBe("");
  });

  it("the PUBLIC client never forwards the claim - a public call must not carry it", async () => {
    cookieStore.set(AFFILIATE_CLAIM_COOKIE, CLAIM);
    const { apiPublicSend } = await import("./api");
    await apiPublicSend("POST", "/api/affiliate/claim", { code: "abc123456789" });
    // apiPublicSend deliberately omits authHeader(): the claim endpoint is
    // public and must not receive a visitor's existing claim or session.
    expect(sentCookieHeader()).toBe("");
  });
});
