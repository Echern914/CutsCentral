import { describe, expect, it } from "vitest";
import {
  BOOKING_TABS,
  FEATURE_INDEX,
  availableToBarberSeat,
  availableWhenLapsed,
  featureById,
  featureUrl,
  isBillingHref,
  resolveFeature,
  resolveHref,
  visibleFeatures,
} from "./features.js";

/**
 * The resolver is the product's ONE navigation gate, and it is about to become
 * the seam an untrusted caller reaches through: the Assistant, and after it the
 * MCP server, will hand back a feature id and nothing else. Everything a model
 * could try — an id we never published, a role it isn't, a page its plan does
 * not include — has to come back as a refusal rather than a link.
 */
describe("resolveFeature — the navigation gate", () => {
  it("refuses an id the registry does not publish", () => {
    for (const bogus of [
      "",
      "not-a-feature",
      "../../etc/passwd",
      "https://evil.example/steal",
      "/dashboard/billing",
      "__proto__",
      "constructor",
    ]) {
      const r = resolveFeature(bogus);
      expect(r.ok, `resolved "${bogus}"`).toBe(false);
      expect(r.ok === false && r.reason).toBe("unknown_feature");
    }
  });

  // 🔴 The registry must never be a URL passthrough. A caller can only ever
  // name an id; there is no shape of input that produces a route we did not
  // write ourselves.
  it("only ever returns an href that is literally in the registry", () => {
    const known = new Set(FEATURE_INDEX.map((f) => f.href));
    for (const f of FEATURE_INDEX) {
      const r = resolveFeature(f.id);
      if (r.ok) expect(known.has(r.href), `${f.id} -> ${r.href}`).toBe(true);
    }
  });

  it("withholds a manager page from an employee seat, with a reason", () => {
    const r = resolveFeature("team", { role: "BARBER" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("role");
    // The entry still comes back, so a surface can explain WHICH thing is
    // out of reach instead of pretending it does not exist.
    expect(r.ok === false && r.entry?.id).toBe("team");
  });

  it("lets an employee reach the handful of pages that are genuinely theirs", () => {
    for (const id of ["home", "assistant", "account", "live-demo"]) {
      expect(resolveFeature(id, { role: "BARBER" }).ok, id).toBe(true);
    }
  });

  it("an owner reaches everything a manager can, and more", () => {
    for (const f of FEATURE_INDEX) {
      const asManager = resolveFeature(f.id, { role: "MANAGER" });
      if (asManager.ok) {
        expect(resolveFeature(f.id, { role: "OWNER" }).ok, f.id).toBe(true);
      }
    }
    // And the owner-only ones really are owner-only.
    expect(resolveFeature("billing", { role: "MANAGER" }).ok).toBe(false);
    expect(resolveFeature("billing", { role: "OWNER" }).ok).toBe(true);
  });

  // App Store Guideline 3.1.1. This is the rule that cost the receptionist a
  // release, and it now holds in ONE place instead of three.
  it("no billing destination resolves inside the native shell", () => {
    for (const f of FEATURE_INDEX) {
      if (!isBillingHref(f.href)) continue;
      const r = resolveFeature(f.id, { inApp: true });
      expect(r.ok, `${f.id} resolved in-app`).toBe(false);
      expect(r.ok === false && r.reason).toBe("in_app");
    }
    // Sanity: the same entry resolves fine on the web.
    expect(resolveFeature("billing").ok).toBe(true);
  });

  it("a flag that is off removes the destination entirely", () => {
    expect(resolveFeature("punch-cards").ok).toBe(true);
    const r = resolveFeature("punch-cards", { flagsOff: ["rewardsEnabled"] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("flag");
  });

  // 🔴 A trialing shop is plan "free" WITH access, and a comped shop is free
  // forever. Locking on the plan name rather than on access is the oldest bug
  // in this product's billing surface.
  it("a tier only bites once access has actually lapsed", () => {
    expect(resolveFeature("promotions", { hasAccess: true }).ok).toBe(true);
    expect(resolveFeature("promotions").ok).toBe(true); // unknown = not lapsed
    const r = resolveFeature("promotions", { hasAccess: false });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("plan");
  });

  it("keeps a lapsed shop's route back to fixing it", () => {
    // The whole point: a lapsed shop must still be able to reach billing, its
    // own account, and the page that explains what is wrong.
    for (const id of ["billing", "account", "assistant", "home"]) {
      expect(resolveFeature(id, { hasAccess: false, role: "OWNER" }).ok, id).toBe(true);
    }
  });

  it("a demo session cannot reach anything tied to a real account", () => {
    for (const id of ["billing", "account", "pay-ahead"]) {
      const r = resolveFeature(id, { demo: true, role: "OWNER" });
      expect(r.ok, id).toBe(false);
      expect(r.ok === false && r.reason, id).toBe("demo");
    }
  });

  it("resolveHref is the same decision, collapsed to a link or nothing", () => {
    expect(resolveHref("clients")).toBe("/dashboard/clients");
    expect(resolveHref("team", { role: "BARBER" })).toBeNull();
    expect(resolveHref("nope")).toBeNull();
  });

  it("featureUrl absolutises without inventing a route", () => {
    expect(featureUrl("clients", "https://getchairback.com")).toBe(
      "https://getchairback.com/dashboard/clients",
    );
    // Trailing slash on the origin must not produce a double slash.
    expect(featureUrl("clients", "https://getchairback.com/")).toBe(
      "https://getchairback.com/dashboard/clients",
    );
    expect(featureUrl("team", "https://getchairback.com", { role: "BARBER" })).toBeNull();
  });
});

describe("the registry's shape holds together", () => {
  it("every id is unique and every lookup round-trips", () => {
    const ids = FEATURE_INDEX.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FEATURE_INDEX) expect(featureById(f.id)).toBe(f);
  });

  // 🔴 A `?tab=` value that is not a real tab lands the barber on the DEFAULT
  // tab, silently. That is exactly how "Acuity & Square sync" spent its life
  // opening the appointment book instead of the connect card.
  it("every ?tab= deep link names a tab that exists", () => {
    for (const f of FEATURE_INDEX) {
      const m = /[?&]tab=([^&]+)/.exec(f.href);
      if (!m) continue;
      expect(
        (BOOKING_TABS as readonly string[]).includes(m[1]!),
        `${f.id} -> unknown tab "${m[1]}"`,
      ).toBe(true);
    }
  });

  it("derived access answers agree with the entries", () => {
    expect(availableWhenLapsed(featureById("billing")!)).toBe(true);
    expect(availableWhenLapsed(featureById("promotions")!)).toBe(false);
    expect(availableToBarberSeat(featureById("assistant")!)).toBe(true);
    expect(availableToBarberSeat(featureById("team")!)).toBe(false);
  });

  it("requiresSetup only names plausible readiness item ids", () => {
    // The readiness engine owns the real vocabulary; this catches a typo'd or
    // free-text value before it silently matches nothing.
    for (const f of FEATURE_INDEX) {
      for (const id of f.requiresSetup ?? []) {
        expect(/^[a-z]+(\.[a-z_]+)+$/.test(id), `${f.id} -> "${id}"`).toBe(true);
      }
    }
  });
});

describe("visibleFeatures — what a surface may browse", () => {
  it("never includes an unlisted entry", () => {
    const ids = new Set(visibleFeatures().map((f) => f.id));
    for (const f of FEATURE_INDEX.filter((e) => e.listed === false)) {
      expect(ids.has(f.id), `${f.id} leaked into the directory`).toBe(false);
    }
    expect(ids.has("support")).toBe(false);
  });

  it("an employee's directory is a strict subset of a manager's", () => {
    const manager = new Set(visibleFeatures({ role: "MANAGER" }).map((f) => f.id));
    const barber = visibleFeatures({ role: "BARBER" }).map((f) => f.id);
    expect(barber.length).toBeGreaterThan(0);
    for (const id of barber) expect(manager.has(id), `${id}`).toBe(true);
    expect(barber).not.toContain("team");
    expect(barber).toContain("assistant");
  });

  // A LOCKED feature still lists — its page is what explains the lock, and
  // hiding it means a barber cannot discover what upgrading buys.
  it("still lists premium features for a lapsed shop", () => {
    const ids = visibleFeatures({ hasAccess: false, role: "OWNER" }).map((f) => f.id);
    expect(ids).toContain("promotions");
    expect(ids).toContain("rebook-nudges");
  });

  it("drops billing entries inside the native shell", () => {
    const ids = visibleFeatures({ inApp: true }).map((f) => f.id);
    expect(ids).not.toContain("billing");
    // The receptionist must SURVIVE, which is the bug that motivated its own
    // page: it is premium, but it no longer sits on a billing href.
    expect(ids).toContain("receptionist");
  });

  it("drops rewards features when the shop switched rewards off", () => {
    const ids = visibleFeatures({ flagsOff: ["rewardsEnabled"] }).map((f) => f.id);
    for (const id of ["punch-cards", "vip-cards", "loyalty-tiers"]) {
      expect(ids, id).not.toContain(id);
    }
    expect(ids).toContain("clients");
  });
});

/**
 * The cost boundary, asserted rather than promised.
 *
 * ChairBack does not pay for the Assistant's model usage — the barber connects
 * their OWN ChatGPT or Claude account, and everything this PR ships answers
 * from data already on the device. This registry is the whole navigation and
 * answering substrate for that, so it is the right place to pin the rule: if
 * anything here ever needed a model, it would show up as a provider key or an
 * endpoint in this file.
 */
describe("cost boundary", () => {
  it("the registry names no model provider and no AI endpoint", () => {
    const source = JSON.stringify(FEATURE_INDEX);
    for (const forbidden of [
      "openai",
      "anthropic",
      "api.openai.com",
      "api.anthropic.com",
      "gpt-",
      "claude-",
      "credits",
    ]) {
      expect(source.toLowerCase().includes(forbidden), forbidden).toBe(false);
    }
  });

  it("resolving is pure — no network, no environment, no keys", () => {
    // Every answer is a lookup over a frozen literal. If this ever needed a
    // fetch, it could not be synchronous.
    const r = resolveFeature("clients");
    expect(r.ok && typeof r.href).toBe("string");
    expect(resolveFeature("clients")).toEqual(resolveFeature("clients"));
  });
});
