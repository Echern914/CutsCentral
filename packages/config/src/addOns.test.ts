import { describe, expect, it } from "vitest";
import { addOnOffersService } from "./addOns.js";

/**
 * The one rule for which add-ons go with which service. The API charges by it
 * and both booking forms list by it, so a change here changes all three.
 */
describe("addOnOffersService", () => {
  it("an add-on with no services listed goes with every service", () => {
    expect(addOnOffersService({ serviceIds: [] }, "svc-cut")).toBe(true);
    expect(addOnOffersService({ serviceIds: [] }, "svc-color")).toBe(true);
  });

  it("a scoped add-on goes only with the services it lists", () => {
    const beard = { serviceIds: ["svc-cut", "svc-fade"] };
    expect(addOnOffersService(beard, "svc-cut")).toBe(true);
    expect(addOnOffersService(beard, "svc-fade")).toBe(true);
    expect(addOnOffersService(beard, "svc-color")).toBe(false);
  });
});
