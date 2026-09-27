import { describe, expect, it, vi } from "vitest";

// The fetch half pulls in next/headers; only the pure helpers are under test.
vi.mock("@/lib/api", () => ({ apiGet: vi.fn() }));

import { nextStep, problems, type ReadinessItemWire, type ShopReadinessWire } from "./readiness";

/**
 * The Assistant's Continue-setup card and problem list, for a shop whose
 * customers book somewhere else.
 *
 * An Acuity shop has no ChairBack services or chairs to set up, so the API
 * reports "Services and barbers" as not applicable. The card must step over it
 * to the group that really needs something, and never offer "Add a service".
 */
function wireItem(over: Partial<ReadinessItemWire>): ReadinessItemWire {
  return {
    id: "x",
    milestone: "shop",
    title: "",
    why: "",
    klass: "required",
    applicable: true,
    done: false,
    evidence: "",
    blocksLaunch: true,
    role: "manager",
    ...over,
  };
}

const bookingLink = wireItem({ id: "shop.booking_source", title: "Booking source" });

function acuityShop(blocked: boolean, withApplicable = true): ShopReadinessWire {
  const na = withApplicable ? { applicable: false } : {};
  return {
    scope: "shop",
    liveNow: !blocked,
    canGoLive: !blocked,
    milestones: [
      {
        id: "shop",
        title: "Your shop",
        ...(withApplicable ? { applicable: true } : {}),
        done: !blocked,
        blocking: blocked ? [bookingLink] : [],
        applicableCount: 4,
        completeCount: blocked ? 3 : 4,
      },
      { id: "services_and_barber", title: "Services and barbers", ...na, done: true, blocking: [], applicableCount: 0, completeCount: 0 },
      { id: "hours_and_alerts", title: "Hours and alerts", ...na, done: true, blocking: [], applicableCount: 0, completeCount: 0 },
      {
        id: "preview_and_go_live",
        title: "Preview and go live",
        ...(withApplicable ? { applicable: true } : {}),
        done: !blocked,
        blocking: blocked ? [wireItem({ id: "shop.preflight", milestone: "preview_and_go_live" })] : [],
        applicableCount: 1,
        completeCount: blocked ? 0 : 1,
      },
    ],
    milestonesComplete: blocked ? 0 : 2,
    milestonesBlocking: blocked ? 2 : 0,
    blocking: blocked ? [bookingLink] : [],
    items: [
      blocked ? bookingLink : { ...bookingLink, done: true, blocksLaunch: false },
      wireItem({ id: "shop.service.active", milestone: "services_and_barber", applicable: false, blocksLaunch: false }),
    ],
  };
}

describe("Continue setup on a shop that books through Acuity", () => {
  it("points at the booking link, never at the services it does not need", () => {
    const step = nextStep(acuityShop(true), "chair");
    expect(step?.item.id).toBe("shop.booking_source");
    expect(step?.milestoneTitle).toBe("Your shop");
  });

  it("has nothing to show once the link works - and lists no services problem", () => {
    const r = acuityShop(false);
    expect(nextStep(r, "chair")).toBeNull();
    expect(problems(r).map((i) => i.id)).not.toContain("shop.service.active");
  });

  it("still works against an API from before `applicable` existed", () => {
    expect(nextStep(acuityShop(true, false), "chair")?.item.id).toBe("shop.booking_source");
  });
});
