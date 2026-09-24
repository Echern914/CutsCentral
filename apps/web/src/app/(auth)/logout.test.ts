import { describe, expect, it, vi } from "vitest";

/**
 * Signing out on a shared front-desk device must leave nothing for the next
 * person: not the session, not the shop they were working in, and not a team
 * they were about to ask to join - that one would send a request on the next
 * person's behalf when they set up their business.
 */

const cookieStore = new Map<string, string>([
  ["cb_session", "session-token"],
  ["cb_active_shop", "shop_team"],
  ["cb_team_link", "cmteamshop0001"],
]);
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge === 0) cookieStore.delete(name);
      else cookieStore.set(name, value);
    },
    delete: (name: string) => cookieStore.delete(name),
  }),
  headers: () => new Map([["host", "localhost:3000"]]),
}));
const redirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));

const { logoutAction } = await import("./actions");

describe("signing out", () => {
  it("🔴 forgets the session, the active shop, and the team being joined", async () => {
    await logoutAction();
    expect(cookieStore.has("cb_session")).toBe(false);
    expect(cookieStore.has("cb_active_shop")).toBe(false);
    expect(cookieStore.has("cb_team_link")).toBe(false);
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
