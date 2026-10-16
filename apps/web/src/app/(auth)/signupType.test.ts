import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signing up from a business type's page (/for/barbers -> /signup?type=barber)
 * already says what kind of business it is: setup pre-picks it rather than
 * asking again. Only a real type id is passed on, and only to setup itself -
 * an invitation's `next` still wins.
 */
vi.mock("next/headers", () => ({
  cookies: () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: () => new Map(),
}));
vi.mock("@/lib/api", () => ({ API_BASE: "http://api.test", clientIpHeaders: () => ({}) }));
vi.mock("@/lib/sessionCookieDomain", () => ({ sessionCookieDomain: () => null }));
vi.mock("@/lib/activeShopCookie", () => ({ clearActiveShopCookie: vi.fn() }));
vi.mock("@/lib/teamLinkCookie", () => ({ clearTeamLinkCookie: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

const { signupAction } = await import("./actions");

function form(extra: Record<string, string> = {}) {
  const f = new FormData();
  f.set("name", "Luigi");
  f.set("email", "luigi@test.local");
  f.set("password", "supersecret123");
  f.set("smsAttested", "on");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

beforeEach(() => {
  redirect.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 201, headers: { "set-cookie": "cb_session=abc; Path=/" } })),
  );
});

describe("signup from a business type's page", () => {
  it("🔴 a real type goes on to setup", async () => {
    await signupAction({}, form({ type: "barber" }));
    expect(redirect).toHaveBeenCalledWith("/onboarding?type=barber");
  });

  it("no type, or one that isn't real: plain setup", async () => {
    await signupAction({}, form());
    await signupAction({}, form({ type: "evil/../x" }));
    expect(redirect.mock.calls.map((c) => c[0])).toEqual(["/onboarding", "/onboarding"]);
  });

  it("an invitation still goes back to the invitation", async () => {
    await signupAction({}, form({ type: "barber", next: "/team/join?token=abc" }));
    expect(redirect).toHaveBeenCalledWith("/team/join?token=abc");
  });
});
