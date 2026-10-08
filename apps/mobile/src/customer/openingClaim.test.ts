import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { priceChange } from "./openingClaim";

describe("a held opening whose price changed", () => {
  it("🔴 reads the new price out of the refusal, so the card can ask again at it", () => {
    expect(priceChange(new ApiError("invalid", 409, "price_changed", { error: "price_changed", price: 50 }))).toEqual({
      price: 50,
    });
    // Unpriced now: still a change the member has to see.
    expect(priceChange(new ApiError("invalid", 409, "price_changed", { error: "price_changed", price: null }))).toEqual({
      price: null,
    });
  });

  it("every other refusal is not a price change - taken, ended, a deposit, the network", () => {
    expect(priceChange(new ApiError("invalid", 409, "slot_taken", { error: "slot_taken" }))).toBeNull();
    expect(priceChange(new ApiError("server", 410, "opening_ended"))).toBeNull();
    expect(priceChange(new ApiError("invalid", 409, "deposit_required"))).toBeNull();
    expect(priceChange(new ApiError("offline", 0))).toBeNull();
    expect(priceChange(new Error("x"))).toBeNull();
  });
});
