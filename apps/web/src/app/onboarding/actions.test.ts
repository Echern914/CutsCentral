import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A barber who opened a shop's team link with no business sets one up to
 * join. The request goes out the moment the business exists - every way
 * through onboarding passes createShopAction, while its last screen can be
 * skipped - and a failed request never costs them the business.
 */

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined),
    set: vi.fn(),
    delete: (name: string) => cookieStore.delete(name),
  }),
  headers: () => new Map(),
}));
const apiSend = vi.fn();
vi.mock("@/lib/api", () => ({ apiSend: (...a: unknown[]) => apiSend(...a) }));
vi.mock("@/lib/activeShopCookie", () => ({ clearActiveShopCookie: vi.fn() }));
vi.mock("@/lib/mobileReturn", () => ({ mintAppReturnUrl: async () => null }));
const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

const { createShopAction } = await import("./actions");

function form() {
  const f = new FormData();
  f.set("smsAttested", "on");
  f.set("name", "Mike Fades");
  f.set("industry", "barber");
  return f;
}
const created = { ok: true, status: 201, data: { id: "shop_1" } };

beforeEach(() => {
  cookieStore.clear();
  apiSend.mockReset();
  redirect.mockReset();
});

describe("creating a business from a team link", () => {
  it("🔴 sends the join request as soon as the business exists", async () => {
    cookieStore.set("cb_team_link", "cmteamshop0001");
    apiSend.mockResolvedValue(created);
    await createShopAction({}, form());
    expect(apiSend.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["POST", "/api/shops"],
      ["POST", "/api/teams/join"],
    ]);
    expect(apiSend.mock.calls[1]![2]).toEqual({ team: "cmteamshop0001" });
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });

  it("🔴 a failed request never blocks the business: onboarding carries on", async () => {
    cookieStore.set("cb_team_link", "cmteamshop0001");
    apiSend.mockResolvedValueOnce(created).mockResolvedValueOnce({ ok: false, status: 0, error: "network_error" });
    await createShopAction({}, form());
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });

  it("no team link (or a malformed one): no request", async () => {
    apiSend.mockResolvedValue(created);
    await createShopAction({}, form());
    cookieStore.set("cb_team_link", "../../api/evil");
    await createShopAction({}, form());
    expect(apiSend.mock.calls.every((c) => c[1] === "/api/shops")).toBe(true);
  });

  it("the business wasn't created: no request", async () => {
    cookieStore.set("cb_team_link", "cmteamshop0001");
    apiSend.mockResolvedValue({ ok: false, status: 400, error: "invalid_input" });
    const res = await createShopAction({}, form());
    expect(res.error).toBeTruthy();
    expect(apiSend).toHaveBeenCalledTimes(1);
  });
});
