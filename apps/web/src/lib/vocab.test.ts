import { describe, expect, it, vi, beforeEach } from "vitest";
import { BUSINESS_TYPES, NEUTRAL_VOCABULARY } from "@chairback/config";

/**
 * The web-side vocabulary seam.
 *
 * The failure this guards is subtle and tenant-shaped: a shop whose type is
 * unknown (signed out, no shop, an API deploy behind the web, or simply a shop
 * that has never been asked) must render COMPLETE neutral wording. Blanks and
 * borrowed barbershop words are both wrong, and both compile.
 */
const getMe = vi.hoisted(() => vi.fn());
vi.mock("./me", () => ({ getMe }));

const { getVocabulary, hasChosenBusinessType, capitalize, withArticle } = await import("./vocab");

beforeEach(() => getMe.mockReset());

describe("getVocabulary", () => {
  it("returns the chosen shop's vocabulary", async () => {
    getMe.mockResolvedValue({
      ok: true,
      data: {
        businessType: {
          id: "nails",
          selected: true,
          vocabulary: BUSINESS_TYPES.nails.vocabulary,
        },
      },
    });
    const v = await getVocabulary();
    expect(v.providerNoun).toBe("nail tech");
    expect(v.stationNoun).toBe("station");
  });

  it("falls back to NEUTRAL when the request failed (signed out)", async () => {
    getMe.mockResolvedValue({ ok: false, status: 401 });
    expect(await getVocabulary()).toEqual(NEUTRAL_VOCABULARY);
  });

  it("falls back to NEUTRAL when the user has no shop", async () => {
    getMe.mockResolvedValue({ ok: true, data: { businessType: null } });
    expect(await getVocabulary()).toEqual(NEUTRAL_VOCABULARY);
  });

  it("falls back to NEUTRAL when the API is older than the web deploy", async () => {
    // `businessType` absent entirely - the deploy-skew case the optional field
    // on `Me` exists for.
    getMe.mockResolvedValue({ ok: true, data: {} });
    expect(await getVocabulary()).toEqual(NEUTRAL_VOCABULARY);
  });

  it("never returns a blank word in any fallback path", async () => {
    for (const response of [
      { ok: false, status: 401 },
      { ok: true, data: {} },
      { ok: true, data: { businessType: null } },
    ]) {
      getMe.mockResolvedValue(response);
      const v = await getVocabulary();
      for (const [field, word] of Object.entries(v)) {
        expect(word, field).toBeTruthy();
      }
    }
  });

  it("never speaks barbershop by default", async () => {
    getMe.mockResolvedValue({ ok: true, data: {} });
    const v = await getVocabulary();
    expect(JSON.stringify(v)).not.toMatch(/barber|chair|haircut/);
  });
});

describe("hasChosenBusinessType", () => {
  it("is false for an unselected shop, so the picker can be offered", async () => {
    getMe.mockResolvedValue({
      ok: true,
      data: { businessType: { id: "barber", selected: false, vocabulary: NEUTRAL_VOCABULARY } },
    });
    expect(await hasChosenBusinessType()).toBe(false);
  });

  it("is true once chosen", async () => {
    getMe.mockResolvedValue({
      ok: true,
      data: {
        businessType: { id: "barber", selected: true, vocabulary: BUSINESS_TYPES.barber.vocabulary },
      },
    });
    expect(await hasChosenBusinessType()).toBe(true);
  });

  it("is false rather than throwing when signed out", async () => {
    getMe.mockResolvedValue({ ok: false, status: 401 });
    expect(await hasChosenBusinessType()).toBe(false);
  });
});

describe("copy helpers", () => {
  it("capitalizes only the first letter, leaving the rest alone", () => {
    expect(capitalize("chair")).toBe("Chair");
    expect(capitalize("nail tech")).toBe("Nail tech");
  });

  it("picks the right indefinite article", () => {
    expect(withArticle("chair")).toBe("a chair");
    expect(withArticle("appointment")).toBe("an appointment");
    expect(withArticle("esthetician")).toBe("an esthetician");
  });
});
