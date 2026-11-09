import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiGet: async () => ({ ok: false }) }));
// `cache` only exists in the server build of React.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));

import type { ApiResult } from "@/lib/api";
import { featureLocks, receptionistOnSale, type BillingSummary } from "@/lib/billing";
import { NO_LOCKS, offeredFeatures } from "@/lib/featureLocks";

/**
 * Hiding the AI receptionist's rows.
 *
 * The rows may only go when ALL of this is true: it is off sale, this shop isn't
 * entitled to it, and it never tried it. Getting any of those wrong takes the
 * Inbox away from a shop that paid for it, or that still has conversations in it.
 */

type Over = {
  on?: boolean;
  entitled?: boolean;
  used?: boolean;
  hasAccess?: boolean;
  premium?: boolean;
};

function res({ on = false, entitled = false, used = false, hasAccess = true, premium = true }: Over) {
  return {
    ok: true,
    data: {
      billingEnabled: true,
      hasAccess,
      entitlements: { premium },
      premiumAi: { billingEnabled: on },
      receptionist: { billingEnabled: on, entitled },
      aiTrial: { used },
    },
  } as unknown as ApiResult<BillingSummary>;
}

const ROWS = [
  { id: "calendar" },
  { id: "nudges", tier: "pro" as const },
  { id: "inbox", tier: "pro_ai" as const },
  { id: "receptionist", tier: "pro_ai" as const },
];
const offeredIds = (over: Over) =>
  offeredFeatures(ROWS, featureLocks(res(over))).map((row) => row.id);

describe("who loses the receptionist rows", () => {
  it("a shop that never had it, once it is off sale", () => {
    expect(featureLocks(res({})).noReceptionist).toBe(true);
    expect(offeredIds({})).toEqual(["calendar", "nudges"]);
  });

  it("🔴 not a shop entitled to it: a subscriber, an add-on, a comp or a live trial", () => {
    expect(featureLocks(res({ entitled: true })).noReceptionist).toBeUndefined();
    expect(offeredIds({ entitled: true })).toEqual(ROWS.map((row) => row.id));
  });

  it("🔴 not a shop whose AI trial ended: its conversations are still in the Inbox", () => {
    expect(offeredIds({ used: true })).toEqual(ROWS.map((row) => row.id));
  });

  it("not anyone while it is still on sale", () => {
    expect(featureLocks(res({ on: true })).noReceptionist).toBeUndefined();
  });

  it("a lapsed shop keeps its other locks while the rows go", () => {
    expect(featureLocks(res({ hasAccess: false }))).toEqual({
      premium: true,
      premiumAi: true,
      noReceptionist: true,
    });
  });

  it("a shop on Premium has no diamonds, only fewer rows", () => {
    expect(featureLocks(res({}))).toEqual({ ...NO_LOCKS, noReceptionist: true });
  });
});

describe("reading the summary in doubt", () => {
  it("an older API payload with neither field reads as still on sale", () => {
    expect(receptionistOnSale({} as BillingSummary)).toBe(true);
  });

  it("one route still open is still on sale", () => {
    const addOnOnly = {
      premiumAi: { billingEnabled: false },
      receptionist: { billingEnabled: true },
    } as unknown as BillingSummary;
    expect(receptionistOnSale(addOnOnly)).toBe(true);
  });

  it("no locks at all means every row shows", () => {
    expect(offeredFeatures(ROWS, undefined)).toEqual(ROWS);
    expect(offeredFeatures(ROWS, NO_LOCKS)).toEqual(ROWS);
  });
});
