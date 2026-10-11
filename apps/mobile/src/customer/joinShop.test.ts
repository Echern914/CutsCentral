import { describe, expect, it, vi } from "vitest";
import { joinScreenShop, lookUpJoinShop } from "./joinShop";

const ORIGIN = "https://api.example.test";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const REAL = {
  shop: {
    name: "Chern Cuts",
    handle: "cherncuts",
    logoUrl: "https://cdn.example.test/chern.png",
    town: "Brooklyn",
    pageUrl: "https://web.example.test/s/cherncuts",
    bookUrl: "https://web.example.test/book/cherncuts",
  },
};

describe("the Join screen's shop comes from the server, not the link", () => {
  it("🔴 shows and joins the shop the lookup found - its name, logo and canonical handle", async () => {
    const fetchImpl = vi.fn(async () => json(200, REAL));
    // The link said @CHERNCUTS (and, in the attack, some other name and logo).
    const lookup = await lookUpJoinShop("@CHERNCUTS", { origin: ORIGIN, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(`${ORIGIN}/api/find-shop?handle=%40CHERNCUTS`);
    expect(joinScreenShop(lookup)).toEqual({
      name: "Chern Cuts",
      logo: "https://cdn.example.test/chern.png",
      town: "Brooklyn",
      joinHandle: "cherncuts",
    });
  });

  it("🔴 nothing to join until the lookup answers: no name, no logo, no handle", () => {
    expect(joinScreenShop({ kind: "loading" })).toEqual({
      name: "this shop",
      logo: null,
      town: null,
      joinHandle: null,
    });
  });

  it("an unknown handle is a miss with nothing to join", async () => {
    const lookup = await lookUpJoinShop("nosuchshop", {
      origin: ORIGIN,
      fetchImpl: async () => json(404, { error: "not_found" }),
    });
    expect(lookup).toEqual({ kind: "not_found" });
    expect(joinScreenShop(lookup).joinHandle).toBeNull();
  });

  it("no handle in the link at all: not asked, a miss", async () => {
    const fetchImpl = vi.fn();
    expect(await lookUpJoinShop(undefined, { origin: ORIGIN, fetchImpl })).toEqual({ kind: "not_found" });
    expect(await lookUpJoinShop("  ", { origin: ORIGIN, fetchImpl })).toEqual({ kind: "not_found" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("busy, down or offline is 'try again', never 'no such shop'", async () => {
    expect(
      await lookUpJoinShop("cherncuts", { origin: ORIGIN, fetchImpl: async () => json(503, {}) }),
    ).toEqual({ kind: "unavailable" });
    expect(
      await lookUpJoinShop("cherncuts", {
        origin: ORIGIN,
        fetchImpl: async () => {
          throw new TypeError("Network request failed");
        },
      }),
    ).toEqual({ kind: "unavailable" });
  });

  it("an answer without a name or handle is not a shop to join", async () => {
    const lookup = await lookUpJoinShop("cherncuts", {
      origin: ORIGIN,
      fetchImpl: async () => json(200, { shop: { name: "", handle: "cherncuts" } }),
    });
    expect(lookup).toEqual({ kind: "unavailable" });
    expect(joinScreenShop(lookup).joinHandle).toBeNull();
  });
});
