import { describe, expect, it } from "vitest";
import { draftTiersFromParam, promoBroadcastDraft, promoBroadcastHref } from "./promoDraft";
import type { Promo } from "./page";

const promo: Promo = {
  id: "p1",
  kind: "PERCENT_OFF",
  title: "Gold week",
  description: "Any cut, any day",
  code: "GOLD20",
  percentOff: 20,
  amountOff: null,
  extraPunches: null,
  startsAt: "2026-09-01T00:00:00Z",
  endsAt: null,
  active: true,
  status: "live",
  timesUsed: 0,
  textsSent: 0,
  rebookings: 0,
};

describe("promo -> composer draft", () => {
  it("writes the promo out as a notification", () => {
    expect(promoBroadcastDraft(promo)).toEqual({
      subject: "Gold week",
      body: "20% off. Any cut, any day. Show code GOLD20.",
    });
  });

  it("fits a phone notification", () => {
    const d = promoBroadcastDraft({ ...promo, title: "x".repeat(200), description: "y".repeat(900) });
    expect(d.subject.length).toBeLessThanOrEqual(60);
    expect(d.body.length).toBeLessThanOrEqual(300);
  });

  it("the link carries ids only, and reads back only real tiers", () => {
    expect(promoBroadcastHref("p1")).toBe("/dashboard/clients?promo=p1");
    const href = promoBroadcastHref("p1", ["GOLD", "SILVER"]);
    const tiers = new URL(href, "https://x").searchParams.get("tiers") ?? undefined;
    expect(draftTiersFromParam(tiers)).toEqual(["GOLD", "SILVER"]);
    expect(draftTiersFromParam("GOLD,PLATINUM,GOLD,")).toEqual(["GOLD"]);
    expect(draftTiersFromParam(undefined)).toEqual([]);
  });
});
