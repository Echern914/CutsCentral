import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where a web sign-in lands (/onboarding/resume): a shop still setting up
 * goes back to the first thing it is missing; everyone else to the dashboard.
 */
const getState = vi.hoisted(() => vi.fn());
vi.mock("../state", async () => {
  const real = await vi.importActual<typeof import("../state")>("../state");
  return { ...real, getOnboardingState: getState };
});
vi.mock("@/lib/api", () => ({ apiGet: vi.fn() }));
const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

const { default: ResumeSetupPage } = await import("./page");

const facts = {
  hasShop: true,
  bookingMode: "native",
  bookingUrl: null,
  integrationConnected: false,
  staffCount: 1,
  serviceCount: 0,
  staffWithHours: 0,
  clientCount: 0,
};
const where = async () => {
  redirect.mockReset();
  await ResumeSetupPage();
  return redirect.mock.calls[0]?.[0];
};

beforeEach(() => getState.mockReset());

describe("signing in on the web", () => {
  it("🔴 a shop half way through setup goes back to the first thing it's missing", async () => {
    getState.mockResolvedValue({ facts, shop: { completedAt: null } });
    expect(await where()).toBe("/onboarding/services");
  });

  it("a shop that's set up, or skipped setup, goes to its dashboard", async () => {
    getState.mockResolvedValue({ facts, shop: { completedAt: "2026-10-16T00:00:00.000Z" } });
    expect(await where()).toBe("/dashboard");
  });

  it("no shop of their own, or not its owner: the dashboard, as before", async () => {
    getState.mockResolvedValue(null);
    expect(await where()).toBe("/dashboard");
  });
});
