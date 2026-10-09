import { describe, expect, it } from "vitest";
import {
  offerCoversProvider,
  offerCoversService,
  offerPrice,
  offerRefusal,
  offerRefusalText,
  offerValueWords,
  suggestOfferCode,
  type OfferTerms,
  type OfferVisit,
} from "./offers.js";
import { normalizePromoCode } from "./promoPricing.js";

const base: OfferTerms = {
  kind: "AMOUNT_OFF",
  amountOffCents: 1000,
  percentOffBps: null,
  freeServiceId: null,
  serviceIds: [],
  staffIds: [],
  clientId: null,
  endsAt: null,
  active: true,
};
const visit: OfferVisit = {
  serviceId: "cut",
  staffId: "mikey",
  startsAt: new Date("2026-10-30T18:00:00Z"),
  provenClientId: null,
};

describe("what an offer covers", () => {
  it("empty lists cover every service and provider", () => {
    expect(offerCoversService(base, "anything")).toBe(true);
    expect(offerCoversProvider(base, "anyone")).toBe(true);
  });

  it("a list covers only what is in it", () => {
    const o = { ...base, serviceIds: ["cut"], staffIds: ["mikey"] };
    expect(offerCoversService(o, "cut")).toBe(true);
    expect(offerCoversService(o, "beard")).toBe(false);
    expect(offerCoversProvider(o, "mikey")).toBe(true);
    expect(offerCoversProvider(o, "dee")).toBe(false);
  });

  it("a free service covers that one service only, whatever serviceIds says", () => {
    const o = { ...base, kind: "FREE_SERVICE" as const, amountOffCents: null, freeServiceId: "cut", serviceIds: ["beard"] };
    expect(offerCoversService(o, "cut")).toBe(true);
    expect(offerCoversService(o, "beard")).toBe(false);
  });
});

describe("🔴 MIKEYG30: one free haircut with Mikey, for one client", () => {
  const mikeyg30: OfferTerms = {
    ...base,
    kind: "FREE_SERVICE",
    amountOffCents: null,
    freeServiceId: "cut",
    staffIds: ["mikey"],
    clientId: "jordan",
  };

  it("the client the shop is booking: a $40 haircut costs $0, add-ons in full", () => {
    expect(offerRefusal(mikeyg30, { ...visit, provenClientId: "jordan" })).toBeNull();
    const priced = offerPrice(mikeyg30, { serviceCents: 4000, addOnCents: 1500 });
    expect(priced).toMatchObject({ subtotalCents: 5500, discountCents: 4000, totalCents: 1500 });
  });

  it("the code's '30' is nothing: the value is the stored offer", () => {
    expect(offerValueWords(mikeyg30, (id) => (id === "cut" ? "Haircut" : null))).toBe("A free Haircut");
  });

  it("🔴 anyone else - or a typed name or phone, which proves no one - is refused", () => {
    expect(offerRefusal(mikeyg30, { ...visit, provenClientId: null })).toBe("personal");
    expect(offerRefusal(mikeyg30, { ...visit, provenClientId: "someone-else" })).toBe("personal");
  });

  it("with another provider, or for another service, it doesn't apply", () => {
    expect(offerRefusal(mikeyg30, { ...visit, provenClientId: "jordan", staffId: "dee" })).toBe("provider");
    expect(offerRefusal(mikeyg30, { ...visit, provenClientId: "jordan", serviceId: "beard" })).toBe("service");
  });
});

describe("refusals, in the order a person wants to hear them", () => {
  it("a series or a special is refused before anything else", () => {
    expect(offerRefusal({ ...base, active: false }, { ...visit, series: true })).toBe("series");
    expect(offerRefusal({ ...base, active: false }, { ...visit, special: true })).toBe("special");
  });

  it("paused, then someone else's, then the date", () => {
    expect(offerRefusal({ ...base, active: false, clientId: "x" }, visit)).toBe("off");
    expect(offerRefusal({ ...base, clientId: "x", endsAt: new Date("2026-01-01") }, visit)).toBe("personal");
  });

  it("🔴 the end date is tested against when the VISIT starts, exclusive", () => {
    const endsAt = new Date("2026-10-31T04:00:00Z");
    expect(offerRefusal({ ...base, endsAt }, { ...visit, startsAt: new Date(endsAt.getTime() - 1) })).toBeNull();
    expect(offerRefusal({ ...base, endsAt }, { ...visit, startsAt: endsAt })).toBe("ended");
  });

  it("the words say what to do, and online a personal offer points at the shop", () => {
    expect(offerRefusalText("personal", { online: true })).toBe(
      "That offer is for one client. Ask the shop to book it for you.",
    );
    expect(offerRefusalText("ended", { endsAt: new Date("2026-10-31T04:00:00Z"), timeZone: "America/New_York" })).toBe(
      "That offer is for visits before Sat, Oct 31.",
    );
  });
});

describe("prices", () => {
  it("$ off never takes the service below $0, and never touches add-ons", () => {
    expect(offerPrice({ ...base, amountOffCents: 5000 }, { serviceCents: 4000, addOnCents: 1000 })).toMatchObject({
      discountCents: 4000,
      totalCents: 1000,
    });
  });

  it("% off rounds DOWN (never more off than offered)", () => {
    const o = { ...base, kind: "PERCENT_OFF" as const, amountOffCents: null, percentOffBps: 1500 };
    // 15% of $33.33 = $4.9995 -> $4.99
    expect(offerPrice(o, { serviceCents: 3333, addOnCents: 0 })).toMatchObject({ discountCents: 499, totalCents: 2834 });
  });

  it("words: $12.50 off, 15% off", () => {
    expect(offerValueWords({ ...base, amountOffCents: 1250 }, () => null)).toBe("$12.50 off");
    expect(offerValueWords({ ...base, kind: "PERCENT_OFF", amountOffCents: null, percentOffBps: 1500 }, () => null)).toBe("15% off");
  });
});

describe("suggested codes", () => {
  it("a first name and six unambiguous characters, already in normal form", () => {
    let i = 0;
    const code = suggestOfferCode("Jordán", () => i++ % 30);
    expect(code).toMatch(/^JORDAN-[A-HJ-KM-NP-Z2-9]{6}$/);
    expect(normalizePromoCode(code)).toBe(code);
  });

  it("no name: just the six", () => {
    expect(suggestOfferCode(null, () => 0)).toBe("AAAAAA");
  });
});
