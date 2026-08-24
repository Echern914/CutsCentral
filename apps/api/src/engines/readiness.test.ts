import { describe, expect, it } from "vitest";
import {
  buildBarberReadiness,
  buildReadiness,
  MILESTONE_IDS,
  type ReadinessCapabilities,
  type ReadinessFacts,
  type ReadinessReport,
} from "./readiness.js";

/**
 * The pure readiness builder. No database, no clock, no env - every input
 * arrives in `facts`/`caps`, exactly like ops/preflight.ts, so each rule can be
 * driven to both of its answers directly.
 *
 * The shape of these tests is deliberate: `ready()` is a shop that passes
 * everything, and almost every case below breaks EXACTLY ONE fact and asserts
 * that exactly one thing blocks. That is what stops a future rule change from
 * quietly making two checks report the same gap twice.
 */

const CAPS: ReadinessCapabilities = {
  email: true,
  push: true,
  connect: true,
  receptionist: true,
  dryRun: false,
  messagingCampaigns: 1,
};

/** A shop with everything required in place. */
function ready(over: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    shopId: "shop_1",
    name: "Chern Cuts",
    timezone: "America/New_York",
    timezoneValid: true,
    slug: "chern-cuts",
    publicPageEnabled: true,
    bookingMode: "native",
    bookingUrl: null,
    bookingLeadHours: 2,
    bookingMaxDays: 60,
    hasActiveAccess: true,
    staff: [
      {
        id: "staff_1",
        name: "Dre",
        active: true,
        availabilityRuleCount: 5,
        activeServiceLinkCount: 1,
        hasPhoto: true,
        hasBio: true,
        seatLinked: false,
        recipientUserId: "user_owner",
        recipientIsOwnerFallback: true,
      },
    ],
    services: [
      {
        id: "svc_1",
        name: "Fade",
        active: true,
        durationMin: 30,
        hasPrice: true,
        activeStaffLinkCount: 1,
        closedEveryWeekday: false,
      },
    ],
    activeOfferingPairs: 1,
    recipients: [
      {
        userId: "user_owner",
        pushEnabled: true,
        smsEnabled: true,
        emailEnabled: false,
        deviceCount: 1,
        hasPhone: true,
        hasEmail: true,
      },
    ],
    shopNotifyPhone: true,
    hasAnyAppointment: false,
    paymentsMode: "off",
    connectChargesEnabled: false,
    hasConnectAccount: false,
    depositAmountCents: null,
    payDirectEnabled: false,
    payDirectHandleCount: 0,
    cancelWindowHours: 0,
    cancelFeeBps: 0,
    requireBookingApproval: false,
    waitlistEnabled: false,
    takesRequests: false,
    rewardsEnabled: false,
    activeRewardCount: 0,
    receptionistEnabled: false,
    receptionistTermsAccepted: false,
    receptionistEntitled: false,
    integrationConnected: false,
    ...over,
  };
}

const build = (over: Partial<ReadinessFacts> = {}, caps = CAPS) =>
  buildReadiness(ready(over), caps);

const blockingIds = (r: ReadinessReport) => r.blocking.map((i) => i.id).sort();
const find = (r: ReadinessReport, id: string) => r.items.find((i) => i.id === id);

describe("a fully configured shop", () => {
  it("passes everything and reports 4 of 4", () => {
    const r = build();
    expect(blockingIds(r)).toEqual([]);
    expect(r.canGoLive).toBe(true);
    expect(r.milestonesComplete).toBe(4);
    expect(r.milestonesBlocking).toBe(0);
    expect(r.liveNow).toBe(true);
  });

  it("never claims a go-live gate applies (B1 ships none)", () => {
    expect(build().goLiveGateApplies).toBe(false);
    expect(build({ publicPageEnabled: false }).goLiveGateApplies).toBe(false);
  });

  it("does not require a test booking", () => {
    const r = build({ hasAnyAppointment: false });
    expect(r.canGoLive).toBe(true);
    const t = find(r, "shop.test_booking")!;
    expect(t.klass).toBe("recommended");
    expect(t.blocksLaunch).toBe(false);
    expect(t.deferrable).toBe(true);
  });
});

describe("every required item, broken one at a time", () => {
  const cases: Array<[string, Partial<ReadinessFacts>, string]> = [
    ["shop name", { name: "   " }, "shop.name"],
    ["timezone", { timezoneValid: false, timezone: "Mars/Olympus" }, "shop.timezone"],
    ["slug", { slug: null }, "shop.slug"],
    ["active barber", { staff: [], activeOfferingPairs: 0 }, "shop.staff.active"],
    ["active service", { services: [], activeOfferingPairs: 0 }, "shop.service.active"],
    ["booking window", { bookingLeadHours: 720, bookingMaxDays: 1 }, "shop.booking.window"],
  ];
  for (const [label, over, id] of cases) {
    it(`blocks on ${label}, and only that`, () => {
      const r = build(over);
      expect(r.canGoLive).toBe(false);
      // shop.preflight always accompanies a blocker - it IS the roll-up.
      expect(blockingIds(r)).toContain(id);
      const others = blockingIds(r).filter(
        (x) => x !== id && x !== "shop.preflight",
      );
      expect(others).toEqual([]);
    });
  }

  it("blocks when staff and services exist but nothing joins them", () => {
    // The exact case the old `needsSetup` check missed: both lists non-empty.
    const r = build({
      activeOfferingPairs: 0,
      staff: [{ ...ready().staff[0]!, activeServiceLinkCount: 0 }],
      services: [{ ...ready().services[0]!, activeStaffLinkCount: 0 }],
    });
    expect(blockingIds(r)).toContain("shop.offering.pair");
    expect(find(r, "shop.staff.active")!.done).toBe(true);
    expect(find(r, "shop.service.active")!.done).toBe(true);
    expect(find(r, "shop.offering.pair")!.evidence).toContain(
      "none are assigned to each other",
    );
  });

  it("blocks when nobody has any hours", () => {
    const r = build({
      staff: [{ ...ready().staff[0]!, availabilityRuleCount: 0 }],
    });
    expect(blockingIds(r)).toContain("shop.availability.rule");
  });

  it("blocks when an active service is under the minimum length", () => {
    const r = build({
      services: [{ ...ready().services[0]!, durationMin: 2 }],
    });
    expect(blockingIds(r)).toContain("shop.service.duration");
  });

  it("blocks when every active service is closed on every weekday", () => {
    const r = build({
      services: [{ ...ready().services[0]!, closedEveryWeekday: true }],
    });
    expect(blockingIds(r)).toContain("shop.service.hours_open");
  });

  it("does not double-report a missing service as a duration problem", () => {
    const r = build({ services: [] });
    expect(find(r, "shop.service.duration")!.applicable).toBe(false);
    expect(find(r, "shop.service.hours_open")!.applicable).toBe(false);
  });
});

describe("notification reachability", () => {
  const unreachable = {
    userId: "user_owner",
    pushEnabled: true,
    smsEnabled: true,
    emailEnabled: false,
    deviceCount: 0,
    hasPhone: false,
    hasEmail: true,
  };

  it("blocks when there is no device and no number", () => {
    const r = build({ recipients: [unreachable], shopNotifyPhone: false });
    expect(blockingIds(r)).toContain("shop.alerts.reachable");
    expect(find(r, "shop.alerts.reachable")!.evidence).toContain("reach nobody");
  });

  it("does not also cry 'alerts' when the real problem is having no barber", () => {
    // The owner is still a reachable recipient, so the ONLY gap is the barber.
    const r = build({ staff: [], activeOfferingPairs: 0 });
    expect(blockingIds(r)).toContain("shop.staff.active");
    expect(find(r, "shop.alerts.reachable")!.done).toBe(true);
    // ...and the checks that depend on a barber existing stand down.
    expect(find(r, "shop.availability.rule")!.applicable).toBe(false);
    expect(find(r, "shop.offering.pair")!.applicable).toBe(false);
  });

  it("passes on a registered device alone", () => {
    const r = build({ recipients: [{ ...unreachable, deviceCount: 2 }] });
    expect(find(r, "shop.alerts.reachable")!.done).toBe(true);
    expect(find(r, "shop.alerts.reachable")!.evidence).toContain("2 devices");
  });

  it("passes on a saved number alone", () => {
    const r = build({ recipients: [{ ...unreachable, hasPhone: true }] });
    expect(find(r, "shop.alerts.reachable")!.done).toBe(true);
  });

  it("counts a switch with nothing behind it as unreachable", () => {
    // Push on with no device + texts on with no number = reaches nobody. This
    // is why the check looks past the toggles.
    const r = build({ recipients: [unreachable], shopNotifyPhone: false });
    expect(find(r, "shop.alerts.reachable")!.done).toBe(false);
  });

  it("is unreachable when the barber switched every channel off", () => {
    const r = build({
      recipients: [
        {
          ...unreachable,
          pushEnabled: false,
          smsEnabled: false,
          deviceCount: 5,
          hasPhone: true,
        },
      ],
    });
    expect(find(r, "shop.alerts.reachable")!.done).toBe(false);
  });

  it("requires platform email for customer confirmations on native booking", () => {
    const r = build({}, { ...CAPS, email: false });
    expect(blockingIds(r)).toContain("platform.email");
    expect(find(r, "platform.email")!.role).toBe("owner");
    // Nothing a barber can fix, so no CTA is offered.
    expect(find(r, "platform.email")!.cta).toBeNull();
  });

  it("does not demand platform email when an outside system takes the booking", () => {
    const r = build(
      { bookingMode: "acuity", bookingUrl: "https://x.as.me", integrationConnected: true },
      { ...CAPS, email: false },
    );
    expect(find(r, "platform.email")!.applicable).toBe(false);
  });
});

describe("external booking modes", () => {
  it("requires a booking link instead of native setup", () => {
    const r = build({ bookingMode: "link", bookingUrl: null, staff: [], services: [] });
    expect(blockingIds(r)).toContain("shop.booking_source");
    // Native-only rules stand down entirely.
    for (const id of [
      "shop.offering.pair",
      "shop.availability.rule",
      "shop.booking.window",
      "platform.email",
    ]) {
      expect(find(r, id)!.applicable).toBe(false);
    }
  });

  it("passes with a link saved", () => {
    const r = build({
      bookingMode: "link",
      bookingUrl: "https://booksy.com/chern",
      staff: [],
      services: [],
    });
    expect(find(r, "shop.booking_source")!.done).toBe(true);
  });

  it("adds a connection check for acuity/square only", () => {
    const off = build();
    expect(find(off, "integration.connected")!.applicable).toBe(false);

    const on = build({
      bookingMode: "square",
      bookingUrl: "https://sq.link",
      integrationConnected: false,
    });
    expect(find(on, "integration.connected")!.applicable).toBe(true);
    expect(find(on, "integration.connected")!.done).toBe(false);
    // Conditional, so it does not block launch.
    expect(find(on, "integration.connected")!.blocksLaunch).toBe(false);
  });
});

describe("conditional features", () => {
  it("waitlist off is invisible and changes no count", () => {
    const off = build({ waitlistEnabled: false });
    const on = build({ waitlistEnabled: true, shopNotifyPhone: true });
    expect(find(off, "waitlist.alert_phone")!.applicable).toBe(false);
    expect(off.milestonesComplete).toBe(4);
    expect(on.milestonesComplete).toBe(4);
    // Turning it on adds one applicable conditional to the detailed view.
    expect(on.applicableRequiredCount).toBe(off.applicableRequiredCount + 1);
  });

  it("payments off hides every payment check", () => {
    const r = build({ paymentsMode: "off" });
    for (const id of [
      "payments.connect_ready",
      "payments.deposit_amount",
      "payments.priced_services",
    ]) {
      expect(find(r, id)!.applicable).toBe(false);
    }
    expect(r.canGoLive).toBe(true);
  });

  it("payments on requires a charge-ready account, without blocking launch", () => {
    const r = build({ paymentsMode: "ahead", hasConnectAccount: false });
    const c = find(r, "payments.connect_ready")!;
    expect(c.applicable).toBe(true);
    expect(c.done).toBe(false);
    expect(c.klass).toBe("conditional");
    expect(c.blocksLaunch).toBe(false);
    expect(r.canGoLive).toBe(true);
  });

  it("deposit mode with no amount is caught - the silent free-booking case", () => {
    const r = build({
      paymentsMode: "deposit",
      hasConnectAccount: true,
      connectChargesEnabled: true,
      depositAmountCents: null,
    });
    expect(find(r, "payments.deposit_amount")!.done).toBe(false);
    expect(find(r, "payments.deposit_amount")!.evidence).toContain(
      "nothing would be charged",
    );
  });

  it("deposit mode with an amount passes and shows it", () => {
    const r = build({
      paymentsMode: "deposit",
      hasConnectAccount: true,
      connectChargesEnabled: true,
      depositAmountCents: 2000,
    });
    expect(find(r, "payments.deposit_amount")!.done).toBe(true);
    expect(find(r, "payments.deposit_amount")!.evidence).toContain("$20.00");
  });

  it("flags an unpriced service only while payments are on", () => {
    const unpriced = [{ ...ready().services[0]!, hasPrice: false }];
    const withPay = build({
      paymentsMode: "ahead",
      hasConnectAccount: true,
      connectChargesEnabled: true,
      services: unpriced,
    });
    expect(find(withPay, "payments.priced_services")!.done).toBe(false);
    // Off, price is a recommendation and never a requirement.
    const noPay = build({ services: unpriced });
    expect(find(noPay, "payments.priced_services")!.applicable).toBe(false);
    expect(noPay.improve.some((i) => i.id === "improve.service_prices")).toBe(true);
    expect(noPay.canGoLive).toBe(true);
  });

  it("says so when a cancellation fee can never be charged", () => {
    const r = build({ cancelWindowHours: 24, cancelFeeBps: 5000, paymentsMode: "off" });
    const i = find(r, "policy.cancel_fee_inert")!;
    expect(i.applicable).toBe(true);
    expect(i.klass).toBe("info");
    expect(i.blocksLaunch).toBe(false);
    // Silent once payments exist to collect it.
    expect(
      find(build({ cancelWindowHours: 24, cancelFeeBps: 5000, paymentsMode: "ahead" }),
        "policy.cancel_fee_inert")!.applicable,
    ).toBe(false);
  });

  it("checks approval mode is actually watched", () => {
    const r = build({
      requireBookingApproval: true,
      recipients: [
        {
          userId: "user_owner",
          pushEnabled: true,
          smsEnabled: true,
          emailEnabled: false,
          deviceCount: 0,
          hasPhone: false,
          hasEmail: true,
        },
      ],
      shopNotifyPhone: false,
    });
    expect(find(r, "approval.watched")!.done).toBe(false);
  });

  it("requires a reward only when punch cards are on", () => {
    expect(find(build(), "rewards.active_reward")!.applicable).toBe(false);
    const on = build({ rewardsEnabled: true, activeRewardCount: 0 });
    expect(find(on, "rewards.active_reward")!.done).toBe(false);
  });
});

describe("multiple chairs", () => {
  const secondChair = {
    id: "staff_2",
    name: "Marcus",
    active: true,
    availabilityRuleCount: 0,
    activeServiceLinkCount: 0,
    hasPhoto: false,
    hasBio: false,
    seatLinked: false,
    recipientUserId: "user_owner",
    recipientIsOwnerFallback: true,
  };

  it("one complete chair is enough to launch; the other is a recommendation", () => {
    const r = build({ staff: [ready().staff[0]!, secondChair] });
    expect(r.canGoLive).toBe(true);
    expect(r.milestonesComplete).toBe(4);
    const rec = r.improve.find((i) => i.id === "improve.other_chairs")!;
    expect(rec).toBeDefined();
    expect(rec.klass).toBe("recommended");
    expect(rec.blocksLaunch).toBe(false);
    expect(rec.evidence).toContain("1 other chair");
  });

  it("still reports the incomplete chair's own blockers per chair", () => {
    const r = build({ staff: [ready().staff[0]!, secondChair] });
    const m = r.staff.find((s) => s.staffId === "staff_2")!;
    expect(m.bookable).toBe(false);
    expect(m.blocking.map((i) => i.id).sort()).toEqual([
      "staff.hours",
      "staff.services",
    ]);
    expect(r.staff.find((s) => s.staffId === "staff_1")!.bookable).toBe(true);
  });

  it("does not nag a solo shop about linking its chair to a login", () => {
    const solo = build();
    expect(
      solo.staff[0]!.items.find((i) => i.id === "staff.seat_linked")!.applicable,
    ).toBe(false);
  });

  it("does flag an unlinked chair once the shop has team seats", () => {
    const r = build({
      staff: [
        { ...ready().staff[0]!, seatLinked: true },
        { ...secondChair, availabilityRuleCount: 3, activeServiceLinkCount: 1 },
      ],
    });
    const m = r.staff.find((s) => s.staffId === "staff_2")!;
    const link = m.items.find((i) => i.id === "staff.seat_linked")!;
    expect(link.applicable).toBe(true);
    expect(link.done).toBe(false);
    expect(link.evidence).toContain("go to the shop owner");
  });
});

describe("milestones", () => {
  it("are always exactly four, in a stable order", () => {
    for (const facts of [ready(), ready({ staff: [], services: [] })]) {
      const r = buildReadiness(facts, CAPS);
      expect(r.milestones).toHaveLength(4);
      expect(r.milestones.map((m) => m.id)).toEqual([...MILESTONE_IDS]);
    }
  });

  it("every milestone item maps to one of the four", () => {
    const r = build();
    for (const i of r.items) {
      if (i.milestone !== null) expect(MILESTONE_IDS).toContain(i.milestone);
    }
  });

  it("a milestone is done exactly when it has no blocking item", () => {
    const r = build({ staff: [], activeOfferingPairs: 0 });
    for (const m of r.milestones) expect(m.done).toBe(m.blocking.length === 0);
  });

  it("counts complete and blocking as complements of four", () => {
    const r = build({ staff: [], services: [], activeOfferingPairs: 0 });
    expect(r.milestonesComplete + r.milestonesBlocking).toBe(4);
  });

  it("go-live rolls up the other three rather than repeating them", () => {
    const r = build({ staff: [], activeOfferingPairs: 0 });
    const go = r.milestones.find((m) => m.id === "preview_and_go_live")!;
    expect(go.done).toBe(false);
    expect(go.blocking.map((i) => i.id)).toEqual(["shop.preflight"]);
    expect(find(r, "shop.preflight")!.evidence).toContain("still to do");
  });

  it("recommended and info items never reduce readiness", () => {
    const base = build();
    const withNoise = build({
      hasAnyAppointment: false, // recommended, undone
      cancelWindowHours: 24,
      cancelFeeBps: 5000, // info
      staff: [
        ready().staff[0]!,
        {
          id: "staff_3",
          name: "New",
          active: true,
          availabilityRuleCount: 0,
          activeServiceLinkCount: 0,
          hasPhoto: false,
          hasBio: false,
          seatLinked: false,
          recipientUserId: "user_owner",
          recipientIsOwnerFallback: true,
        },
      ],
    });
    expect(withNoise.canGoLive).toBe(true);
    expect(withNoise.milestonesComplete).toBe(base.milestonesComplete);
    for (const i of withNoise.items) {
      if (i.klass === "recommended" || i.klass === "info") {
        expect(i.blocksLaunch).toBe(false);
      }
    }
  });

  it("silent items stay out of the blocking list while they pass", () => {
    const r = build();
    for (const i of r.items) {
      if (i.silentWhenDone && i.done) expect(r.blocking).not.toContain(i);
    }
    // ...and surface the moment they fail.
    const broken = build({ bookingLeadHours: 720, bookingMaxDays: 1 });
    expect(blockingIds(broken)).toContain("shop.booking.window");
  });
});

describe("a lapsed shop", () => {
  it("explains itself rather than being marked broken", () => {
    const r = build({ hasActiveAccess: false });
    const i = find(r, "info.billing_access")!;
    expect(i.applicable).toBe(true);
    expect(i.klass).toBe("info");
    expect(i.blocksLaunch).toBe(false);
    // Setup is still complete; the shop is paused, not misconfigured.
    expect(r.canGoLive).toBe(true);
    expect(r.liveNow).toBe(false);
  });
});

describe("customer SMS", () => {
  it("is informational and never a task", () => {
    const i = find(build(), "info.customer_sms")!;
    expect(i.klass).toBe("info");
    expect(i.done).toBe(true);
    expect(i.blocksLaunch).toBe(false);
    expect(i.cta).toBeNull();
  });

  it("says so when sending is in test mode", () => {
    const i = find(build({}, { ...CAPS, dryRun: true }), "info.customer_sms")!;
    expect(i.evidence).toContain("test mode");
  });
});

describe("the barber view", () => {
  it("is their own chair and their own actionable items", () => {
    const r = build({
      staff: [{ ...ready().staff[0]!, seatLinked: true, availabilityRuleCount: 0 }],
    });
    const b = buildBarberReadiness(r, "staff_1");
    expect(b.chair!.staffId).toBe("staff_1");
    // Personal = things a barber can genuinely do themselves.
    expect(b.personal.every((i) => i.role === "barber")).toBe(true);
    expect(b.personal.map((i) => i.id)).toContain("staff.alerts_reachable");
    // Hours are manager-owned until B2 opens a self-service route.
    expect(b.managerOwned.map((i) => i.id)).toContain("staff.hours");
    expect(b.personal.map((i) => i.id)).not.toContain("staff.hours");
  });

  it("returns no chair when the seat is not linked to one", () => {
    const b = buildBarberReadiness(build(), null);
    expect(b.chair).toBeNull();
    expect(b.personal).toEqual([]);
    expect(b.applicable).toBe(0);
  });

  it("never exposes another chair", () => {
    const r = build({
      staff: [
        ready().staff[0]!,
        { ...ready().staff[0]!, id: "staff_2", name: "Marcus" },
      ],
    });
    const b = buildBarberReadiness(r, "staff_1");
    expect(b.chair!.staffId).toBe("staff_1");
    expect(JSON.stringify(b)).not.toContain("staff_2");
    expect(JSON.stringify(b)).not.toContain("Marcus");
  });
});

describe("the report as data", () => {
  it("carries no customer or contact information", () => {
    const blob = JSON.stringify(build({ shopNotifyPhone: true }));
    // Nothing in the fact set even offers a phone/email string, but assert it -
    // this is the guard that fails if someone widens a select later.
    expect(blob).not.toMatch(/\+\d{10,}/);
    expect(blob).not.toMatch(/@[\w.-]+\.\w+/);
  });

  it("gives every item a stable id, and no duplicates", () => {
    const r = build();
    const ids = r.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of r.staff) {
      const sids = s.items.map((i) => i.id);
      expect(new Set(sids).size).toBe(sids.length);
    }
  });

  it("precomputes blocksLaunch consistently with its parts", () => {
    for (const facts of [ready(), ready({ staff: [], paymentsMode: "deposit" })]) {
      for (const i of buildReadiness(facts, CAPS).items) {
        expect(i.blocksLaunch).toBe(
          i.klass === "required" && i.applicable && !i.done,
        );
      }
    }
  });

  it("marks only recommended items deferrable", () => {
    for (const i of build().items) {
      expect(i.deferrable).toBe(i.klass === "recommended");
    }
  });
});
