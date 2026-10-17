import { describe, expect, it } from "vitest";
import {
  nextOnboardingStep,
  onboardingPlan,
  setupComplete,
  stepAfter,
  stepPosition,
  type OnboardingFacts,
} from "./onboarding.js";

/**
 * First-time setup: a step is done when the shop's own data says so, so a
 * shop that leaves half way - or does a step from the dashboard - comes back
 * to the first thing still missing, and is never asked again what it answered.
 */
const fresh: OnboardingFacts = {
  hasShop: true,
  bookingMode: "link",
  bookingUrl: null,
  integrationConnected: false,
  staffCount: 0,
  serviceCount: 0,
  staffWithHours: 0,
  clientCount: 0,
};
const at = (over: Partial<OnboardingFacts>) => ({ ...fresh, ...over });

describe("next step", () => {
  it("no shop: make one", () => {
    expect(nextOnboardingStep(at({ hasShop: false }))).toBe("shop");
  });

  it("🔴 a new shop is 'link' with no link - that is not an answer, so it is asked how clients book", () => {
    expect(nextOnboardingStep(fresh)).toBe("booking");
  });

  it("booking on ChairBack walks team, services, hours, clients, done - each skipped once it exists", () => {
    const native = at({ bookingMode: "native" });
    expect(nextOnboardingStep(native)).toBe("team");
    expect(nextOnboardingStep({ ...native, staffCount: 2 })).toBe("services");
    expect(nextOnboardingStep({ ...native, staffCount: 2, serviceCount: 3 })).toBe("hours");
    expect(nextOnboardingStep({ ...native, staffCount: 2, serviceCount: 3, staffWithHours: 1 })).toBe("hours");
    expect(nextOnboardingStep({ ...native, staffCount: 2, serviceCount: 3, staffWithHours: 2 })).toBe("clients");
    expect(nextOnboardingStep({ ...native, staffCount: 2, serviceCount: 3, staffWithHours: 2, clientCount: 40 })).toBe("done");
  });

  it("their own link, or a connected Acuity / Square: no chairs, services or hours to ask for", () => {
    for (const f of [at({ bookingUrl: "https://booksy.com/x" }), at({ integrationConnected: true }), at({ bookingMode: "square", integrationConnected: true })]) {
      expect(onboardingPlan(f)).toEqual(["shop", "booking", "clients", "done"]);
      expect(nextOnboardingStep(f)).toBe("clients");
    }
  });

  it("a blank link is no link", () => {
    expect(nextOnboardingStep(at({ bookingUrl: "   " }))).toBe("booking");
  });
});

describe("setup complete", () => {
  it("🔴 booking on ChairBack: chairs, services and everyone's hours - clients are optional", () => {
    const native = at({ bookingMode: "native" });
    expect(setupComplete(native)).toBe(false);
    expect(setupComplete({ ...native, staffCount: 2, serviceCount: 3, staffWithHours: 1 })).toBe(false);
    expect(setupComplete({ ...native, staffCount: 2, serviceCount: 3, staffWithHours: 2 })).toBe(true);
  });

  it("their own link or a connected calendar: choosing it is the whole of it", () => {
    expect(setupComplete(fresh)).toBe(false);
    expect(setupComplete(at({ bookingUrl: "https://vagaro.com/me" }))).toBe(true);
    expect(setupComplete(at({ integrationConnected: true }))).toBe(true);
  });
});

describe("continue and progress", () => {
  it("Continue skips a step already done elsewhere (services added from the dashboard)", () => {
    const f = at({ bookingMode: "native", staffCount: 1, serviceCount: 4 });
    expect(stepAfter("team", f)).toBe("hours");
  });

  it("Continue from the last step is done", () => {
    expect(stepAfter("clients", at({ bookingMode: "native" }))).toBe("done");
  });

  it("'Step n of N' counts the shop's own path", () => {
    expect(stepPosition("booking", at({ bookingMode: "native" }))).toEqual({ at: 2, of: 6 });
    expect(stepPosition("hours", at({ bookingMode: "native" }))).toEqual({ at: 5, of: 6 });
    expect(stepPosition("clients", at({ bookingUrl: "https://x.test" }))).toEqual({ at: 3, of: 3 });
  });
});
