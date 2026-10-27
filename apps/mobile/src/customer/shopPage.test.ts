import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { loadShopPage, shopPagePath } from "./shopPage";

/**
 * "Book again" opens the shop's booking page on the visit's own service; the
 * plain shop screen is still the storefront. The API builds both URLs.
 */
describe("which page the shop screen asks for", () => {
  it("plain: the storefront", () => {
    expect(shopPagePath("link_1", undefined)).toBe("/api/me/shops/link_1/storefront");
  });

  it("book again: that visit, by its id", () => {
    expect(shopPagePath("link_1", "a_appt1")).toBe("/api/me/shops/link_1/book-again?appointment=a_appt1");
  });

  it("book again from the rewards card: their usual, no id", () => {
    expect(shopPagePath("link_1", "usual")).toBe("/api/me/shops/link_1/book-again");
  });
});

describe("loading it", () => {
  it("opens the URL the API hands back", async () => {
    const get = vi.fn(async () => ({ url: "https://web.test/book/drick?service=s1&staff=t1&cb_me=x.y" }));
    await expect(loadShopPage({ get } as never, "link_1", "a_appt1")).resolves.toBe(
      "https://web.test/book/drick?service=s1&staff=t1&cb_me=x.y",
    );
    expect(get).toHaveBeenCalledWith("/api/me/shops/link_1/book-again?appointment=a_appt1");
  });

  it("🔴 an API from before Book again (404) still opens the storefront, never an error", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("book-again")) throw new ApiError("not_found", 404);
      return { url: "https://web.test/r/tok" };
    });
    await expect(loadShopPage({ get } as never, "link_1", "a_appt1")).resolves.toBe("https://web.test/r/tok");
  });

  it("any other failure is shown, not papered over", async () => {
    const get = vi.fn(async () => {
      throw new ApiError("offline", 0);
    });
    await expect(loadShopPage({ get } as never, "link_1", "a_appt1")).rejects.toBeInstanceOf(ApiError);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
