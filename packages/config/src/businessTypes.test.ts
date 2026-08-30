import { describe, expect, it } from "vitest";
import {
  BUSINESS_TYPES,
  BUSINESS_TYPE_IDS,
  MARKETING_SLUGS,
  NEUTRAL_VOCABULARY,
  SELECTABLE_BUSINESS_TYPE_IDS,
  assertNeverBusinessType,
  businessType,
  isBusinessTypeId,
  naivePlural,
  vocabularyFor,
  vocabularyForShop,
  type BusinessTypeId,
} from "./businessTypes.js";
import { INDUSTRIES, INDUSTRY_KEYS, serviceNounFor, serviceNounForShop } from "./constants.js";

/**
 * The registry's contract tests. `tsc` already pins the KEY SET (the
 * `satisfies Record<BusinessTypeId, BusinessType>` in businessTypes.ts fails the
 * build when an id has no entry); everything here pins what the compiler cannot
 * see - ordering, prose quality, and the promises other surfaces rely on.
 */

/** Every schema.org type we use must be a real LocalBusiness subtype. */
const ALLOWED_SCHEMA_TYPES = [
  "AutoWash",
  "BarberShop",
  "BeautySalon",
  "DaySpa",
  "HairSalon",
  "LocalBusiness",
  "NailSalon",
  "TattooParlor",
];

describe("BUSINESS_TYPE_IDS", () => {
  it("is pinned in exact picker order", () => {
    // Pinned so a reorder is a deliberate edit, never a side effect of adding an
    // entry: this array is the order the signup picker renders in.
    expect(BUSINESS_TYPE_IDS).toEqual([
      "barber",
      "salon",
      "nails",
      "lashes",
      "multiservice",
      "spa",
      "tattoo",
      "detailing",
      "other",
    ]);
  });

  it("every id's entry carries its own id", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      expect(BUSINESS_TYPES[id].id, id).toBe(id);
    }
  });

  it("keeps every vertical that has ever been storable", () => {
    // Deleting an id strands live shops on a value that no longer resolves and
    // 404s a live landing page. Retire with `selectable: false` instead.
    for (const legacy of ["barber", "salon", "nails", "lashes", "spa", "tattoo", "other"]) {
      expect(BUSINESS_TYPE_IDS, legacy).toContain(legacy);
    }
  });
});

describe("entry copy", () => {
  it("has a non-empty label, tagline and emoji", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      const t = BUSINESS_TYPES[id];
      expect(t.label.trim(), id).not.toBe("");
      expect(t.tagline.trim(), id).not.toBe("");
      expect(t.emoji.trim(), id).not.toBe("");
    }
  });

  it("has unique labels so the picker is never ambiguous", () => {
    const labels = BUSINESS_TYPE_IDS.map((id) => BUSINESS_TYPES[id].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never calls anyone a cosmetologist", () => {
    // An auto detailer is not a cosmetologist, and neither is a tattoo artist.
    // Applies to every type, including the beauty ones, because the word only
    // ever shows up when someone reaches for a false umbrella term.
    for (const id of BUSINESS_TYPE_IDS) {
      const blob = JSON.stringify(BUSINESS_TYPES[id]).toLowerCase();
      expect(blob, id).not.toMatch(/cosmetolog/);
    }
  });
});

describe("vocabulary", () => {
  it("has every field non-empty, singular fields lowercase and unpadded", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      const v = BUSINESS_TYPES[id].vocabulary;
      for (const [field, word] of Object.entries(v)) {
        expect(word, `${id}.${field}`).not.toBe("");
        expect(word, `${id}.${field}`).toBe(word.trim());
        // Copy capitalizes at the call site; storing "Chair" would double-cap
        // mid-sentence and read as a bug.
        expect(word, `${id}.${field}`).toBe(word.toLowerCase());
      }
    }
  });

  it("pairs every singular with a distinct plural", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      const v = BUSINESS_TYPES[id].vocabulary;
      for (const [singular, plural] of [
        [v.serviceNoun, v.serviceNounPlural],
        [v.providerNoun, v.providerNounPlural],
        [v.stationNoun, v.stationNounPlural],
        [v.clientNoun, v.clientNounPlural],
      ]) {
        expect(plural, `${id}: ${singular}`).not.toBe("");
        // A plural identical to its singular is nearly always a copy/paste slip.
        // (If a real irregular ever needs it, allow it explicitly here.)
        expect(plural, `${id}: ${singular}`).not.toBe(singular);
      }
    }
  });
});

describe("the barbershop keeps today's words", () => {
  // The whole arc must be invisible to the shops already using the product.
  it("resolves exactly the terminology that ships today", () => {
    expect(BUSINESS_TYPES.barber.vocabulary).toEqual({
      serviceNoun: "cut",
      serviceNounPlural: "cuts",
      providerNoun: "barber",
      providerNounPlural: "barbers",
      stationNoun: "chair",
      stationNounPlural: "chairs",
      businessNoun: "barbershop",
      clientNoun: "client",
      clientNounPlural: "clients",
    });
  });
});

describe("NEUTRAL_VOCABULARY (what an unselected shop renders)", () => {
  it("is the `other` entry's vocabulary, so there is one definition not two", () => {
    expect(NEUTRAL_VOCABULARY).toBe(BUSINESS_TYPES.other.vocabulary);
  });

  it("is complete - a legacy shop renders words, never blanks", () => {
    for (const [field, word] of Object.entries(NEUTRAL_VOCABULARY)) {
      expect(word, field).toBeTruthy();
    }
  });

  it("keeps serviceNoun 'visit', which is what ships today", () => {
    // Pinned by constants.test.ts and templates.test.ts too. Changing it would
    // reword live SMS for every shop with no industry set.
    expect(NEUTRAL_VOCABULARY.serviceNoun).toBe("visit");
  });

  it("borrows no vertical's flavor", () => {
    // The fallback must not quietly speak barbershop (the old default) or salon.
    const blob = Object.values(NEUTRAL_VOCABULARY).join(" ");
    expect(blob).not.toMatch(/\b(barber|chair|cut|salon|stylist|guest)\b/);
  });
});

describe("resolvers", () => {
  it("isBusinessTypeId accepts every id and rejects everything else", () => {
    for (const id of BUSINESS_TYPE_IDS) expect(isBusinessTypeId(id), id).toBe(true);
    for (const bad of [
      "dentist",
      "BARBER",
      "",
      " barber",
      "__proto__",
      "constructor",
      "toString",
      null,
      undefined,
      123,
      {},
      ["barber"],
    ]) {
      expect(isBusinessTypeId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("every id resolves through the registry", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      expect(businessType(id), id).toBe(BUSINESS_TYPES[id]);
      expect(vocabularyFor(id), id).toEqual(BUSINESS_TYPES[id].vocabulary);
    }
  });

  it("falls back to `other` for forged, unknown or missing ids instead of throwing", () => {
    // A bad value in one shop's row must never be able to 500 a page.
    for (const bad of ["dentist", "__proto__", "", null, undefined]) {
      expect(businessType(bad as string | null), String(bad)).toBe(BUSINESS_TYPES.other);
      expect(vocabularyFor(bad as string | null), String(bad)).toEqual(NEUTRAL_VOCABULARY);
    }
  });

  it("assertNeverBusinessType throws if a branch is ever reached at runtime", () => {
    expect(() => assertNeverBusinessType("nails" as never)).toThrow(/unhandled business type/);
  });
});

describe("vocabularyForShop - the legacy rule", () => {
  const selected = new Date("2026-08-01T12:00:00.000Z");

  it("ignores the stored industry ENTIRELY when nothing was chosen", () => {
    // This is the whole legacy answer: pre-picker shops carry industry "barber"
    // because a migration defaulted it, not because anyone said so. We decline to
    // speak as if they had.
    expect(
      vocabularyForShop({ industry: "barber", businessTypeSelectedAt: null }),
    ).toEqual(NEUTRAL_VOCABULARY);
    expect(vocabularyForShop({ industry: "nails" })).toEqual(NEUTRAL_VOCABULARY);
  });

  it("uses the chosen type once a human has chosen", () => {
    expect(
      vocabularyForShop({ industry: "nails", businessTypeSelectedAt: selected }).providerNoun,
    ).toBe("nail tech");
    expect(
      vocabularyForShop({ industry: "barber", businessTypeSelectedAt: selected }).stationNoun,
    ).toBe("chair");
  });

  it("accepts an ISO string as well as a Date (the wire carries strings)", () => {
    expect(
      vocabularyForShop({ industry: "detailing", businessTypeSelectedAt: selected.toISOString() })
        .stationNoun,
    ).toBe("bay");
  });

  it("still falls neutral for a forged industry even when marked selected", () => {
    expect(
      vocabularyForShop({ industry: "dentist", businessTypeSelectedAt: selected }),
    ).toEqual(NEUTRAL_VOCABULARY);
  });

  it("lays the owner's custom serviceNoun over the top, pluralized", () => {
    const v = vocabularyForShop({
      industry: "barber",
      serviceNoun: "twist",
      businessTypeSelectedAt: selected,
    });
    expect(v.serviceNoun).toBe("twist");
    expect(v.serviceNounPlural).toBe("twists");
    // ...without disturbing the rest of the vertical's words.
    expect(v.providerNoun).toBe("barber");
  });

  it("applies the custom noun even to an unselected shop", () => {
    // A custom word is an explicit act by the owner; only the TYPE is unknown.
    const v = vocabularyForShop({ industry: "barber", serviceNoun: "gloss" });
    expect(v.serviceNoun).toBe("gloss");
    expect(v.providerNoun).toBe(NEUTRAL_VOCABULARY.providerNoun);
  });

  it("ignores a blank or whitespace custom noun", () => {
    for (const blank of ["", "   ", null, undefined]) {
      expect(
        vocabularyForShop({ industry: "barber", serviceNoun: blank, businessTypeSelectedAt: selected })
          .serviceNoun,
        JSON.stringify(blank),
      ).toBe("cut");
    }
  });

  it("does not mutate the registry when overlaying a custom noun", () => {
    vocabularyForShop({ industry: "barber", serviceNoun: "twist", businessTypeSelectedAt: selected });
    expect(BUSINESS_TYPES.barber.vocabulary.serviceNoun).toBe("cut");
  });
});

describe("marketing + SEO metadata", () => {
  it("only uses real schema.org LocalBusiness subtypes", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      expect(ALLOWED_SCHEMA_TYPES, id).toContain(BUSINESS_TYPES[id].schemaType);
    }
  });

  it("keeps the landing pages that are live today", () => {
    // These URLs are in the sitemap and indexed; dropping a slug 404s a live page.
    expect([...MARKETING_SLUGS].sort()).toEqual(
      ["barbers", "lashes", "nails", "salons", "spas", "tattoo"].sort(),
    );
  });

  it("has unique, URL-safe slugs", () => {
    expect(new Set(MARKETING_SLUGS).size).toBe(MARKETING_SLUGS.length);
    for (const slug of MARKETING_SLUGS) expect(slug, slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("service templates", () => {
  it("has globally unique ids, namespaced by type", () => {
    const ids = BUSINESS_TYPE_IDS.flatMap((id) =>
      BUSINESS_TYPES[id].serviceTemplates.map((t) => t.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of BUSINESS_TYPE_IDS) {
      for (const t of BUSINESS_TYPES[id].serviceTemplates) {
        expect(t.id, t.id).toMatch(new RegExp(`^${id}\\.[a-z0-9_]+$`));
      }
    }
  });

  it("has a sane name and duration on every template", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      for (const t of BUSINESS_TYPES[id].serviceTemplates) {
        expect(t.name.trim(), t.id).not.toBe("");
        expect(t.durationMin, t.id).toBeGreaterThan(0);
        expect(t.durationMin, t.id).toBeLessThanOrEqual(8 * 60);
      }
    }
  });

  it("suggests no price - we would be guessing at someone's business", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      for (const t of BUSINESS_TYPES[id].serviceTemplates) {
        expect(t.priceCents, t.id).toBeNull();
      }
    }
  });

  it("gives every selectable vertical except `other` something to start from", () => {
    for (const id of SELECTABLE_BUSINESS_TYPE_IDS) {
      if (id === "other") continue;
      expect(BUSINESS_TYPES[id].serviceTemplates.length, id).toBeGreaterThan(0);
    }
  });
});

describe("rebook guidance", () => {
  it("is a plausible number of days for every type", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      const days = BUSINESS_TYPES[id].typicalRebookDays;
      expect(days, id).toBeGreaterThanOrEqual(7);
      expect(days, id).toBeLessThanOrEqual(180);
    }
  });
});

describe("naivePlural", () => {
  it("appends s, leaving words that already end in s alone", () => {
    expect(naivePlural("cut")).toBe("cuts");
    expect(naivePlural("gloss")).toBe("gloss");
  });
});

describe("back-compat with the INDUSTRIES projection", () => {
  // PR 1 must change zero live behavior. These assert the deprecated surface
  // still answers exactly as it did before the registry existed.
  it("exposes every registry id through INDUSTRY_KEYS", () => {
    expect(INDUSTRY_KEYS).toEqual(BUSINESS_TYPE_IDS);
  });

  it("projects label, reward, emoji and serviceNoun for every id", () => {
    for (const id of BUSINESS_TYPE_IDS) {
      const t = BUSINESS_TYPES[id];
      expect(INDUSTRIES[id], id).toEqual({
        label: t.label,
        defaultReward: t.defaultReward.name,
        emoji: t.defaultReward.emoji,
        serviceNoun: t.vocabulary.serviceNoun,
      });
    }
  });

  it("keeps the exact service nouns the live SMS templates already send", () => {
    expect(serviceNounFor("barber")).toBe("cut");
    expect(serviceNounFor("salon")).toBe("appointment");
    expect(serviceNounFor("nails")).toBe("appointment");
    expect(serviceNounFor("lashes")).toBe("appointment");
    expect(serviceNounFor("spa")).toBe("appointment");
    expect(serviceNounFor("tattoo")).toBe("session");
    expect(serviceNounFor("other")).toBe("visit");
    expect(serviceNounFor("florist")).toBe("visit");
    expect(serviceNounFor(null)).toBe("visit");
  });

  it("keeps the rewards onboarding seeds today", () => {
    expect(INDUSTRIES.barber.defaultReward).toBe("Free Cut");
    expect(INDUSTRIES.nails.defaultReward).toBe("Free Manicure");
    expect(INDUSTRIES.tattoo.defaultReward).toBe("$25 Off Next Session");
  });

  it("serviceNounForShop still ignores the legacy rule, so live copy is unchanged", () => {
    // 🔴 The divergence is deliberate - see the docstring in constants.ts. An
    // unselected barbershop keeps saying "cut" through the OLD helper, while
    // vocabularyForShop (the new one) speaks neutrally.
    const legacyShop = { industry: "barber", serviceNoun: null };
    expect(serviceNounForShop(legacyShop)).toBe("cut");
    expect(vocabularyForShop(legacyShop).serviceNoun).toBe("visit");
  });
});

describe("the registry stays presentation-only", () => {
  it("carries no authorization, billing or entitlement fields", () => {
    // Business type decides what a surface CALLS things, never what a seat may
    // do. If one of these words ever needs to appear here, it belongs elsewhere.
    const forbidden =
      /\b(role|scope|plan|price|entitl|billing|permission|flag|enabled|quota|limit)\b/i;
    for (const id of BUSINESS_TYPE_IDS) {
      for (const key of Object.keys(BUSINESS_TYPES[id])) {
        expect(key, `${id}.${key}`).not.toMatch(forbidden);
      }
    }
  });

  it("exposes ids as plain lowercase tokens safe to store and put in a URL", () => {
    for (const id of BUSINESS_TYPE_IDS) expect(id).toMatch(/^[a-z][a-z0-9]*$/);
  });
});

describe("type-level exhaustiveness", () => {
  it("documents that the KEY SET is a build failure, not a test failure", () => {
    // Adding an id to BusinessTypeId without an entry in BUSINESS_TYPES fails
    // `tsc` at the `satisfies Record<BusinessTypeId, BusinessType>` in
    // businessTypes.ts - which matters because the Vercel build is the only
    // automated PR check. This test exists to name that guarantee; it cannot
    // assert it, because the failure it describes would stop compilation.
    const ids: BusinessTypeId[] = BUSINESS_TYPE_IDS;
    expect(ids.length).toBe(Object.keys(BUSINESS_TYPES).length);
  });
});
