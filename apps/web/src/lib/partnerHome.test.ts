import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiGet } from "@/lib/api";
import { homeWithoutShop } from "./partnerHome";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn() }));

/**
 * A login with no business normally goes to "set up your shop" - but a partner
 * who runs no business would then never find their earnings or cash out.
 */
describe("homeWithoutShop", () => {
  beforeEach(() => vi.mocked(apiGet).mockReset());

  it("sends a partner with no business to their earnings", async () => {
    vi.mocked(apiGet).mockResolvedValue({ ok: true, status: 200, data: {} });
    expect(await homeWithoutShop()).toBe("/dashboard/referrals");
    expect(apiGet).toHaveBeenCalledWith("/api/partner/me");
  });

  it("sends everyone else to set up their shop", async () => {
    vi.mocked(apiGet).mockResolvedValue({ ok: false, status: 404, data: null, error: "not_found" });
    expect(await homeWithoutShop()).toBe("/onboarding");
  });
});
