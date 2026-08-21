import { describe, expect, it } from "vitest";
import {
  formatMinutes,
  formatPrice,
  MIN_SERVICE_MINUTES,
  parseDuration,
  parsePrice,
} from "./serviceFields";

/**
 * A service's price and its length, coming in off a keyboard.
 *
 * Every case here is one a barber can actually produce: an empty box, a pasted
 * "$1,200", a half-minute, a negative typed by holding the wrong key. They were
 * previously answered by a dozen separate inline `Number(x)` checks that
 * disagreed with each other - one form rejected a negative price, another
 * accepted it; a fractional duration was silently discarded with no error at
 * all. One implementation, one set of answers.
 */

describe("parsePrice", () => {
  it("reads a plain price", () => {
    expect(parsePrice("45")).toEqual({ ok: true, value: 45 });
    expect(parsePrice("45.50")).toEqual({ ok: true, value: 45.5 });
    expect(parsePrice("0")).toEqual({ ok: true, value: 0 });
  });

  it("treats an EMPTY box as 'not set', not as free", () => {
    // Blank is a real state: no listed price on the base field, "use the base
    // price" on an override. Coercing it to 0 would publish the service as free.
    expect(parsePrice("")).toEqual({ ok: true, value: null });
    expect(parsePrice("   ")).toEqual({ ok: true, value: null });
  });

  it("refuses a negative price", () => {
    const r = parsePrice("-5");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/negative/i);
  });

  it("refuses input that isn't a number", () => {
    for (const junk of ["abc", "4 5", "--", "1/2"]) {
      expect(parsePrice(junk).ok).toBe(false);
    }
  });

  it("treats a lone '$' as an empty box, not as an error", () => {
    // Reachable by typing into the field and deleting the digits back out
    // again. There is no number there, which is exactly "not set" - shouting
    // about it would be noise.
    expect(parsePrice("$")).toEqual({ ok: true, value: null });
  });

  it("refuses Infinity", () => {
    // Number("Infinity") is finite-looking to a careless check and would be
    // written straight into a Decimal column.
    expect(parsePrice("Infinity").ok).toBe(false);
    expect(parsePrice("-Infinity").ok).toBe(false);
  });

  it("rounds to whole cents, because the column is Decimal(10,2)", () => {
    // Left alone, "45.999" showed as typed and came back as 46.00 from the
    // database - the field and the record disagreed.
    expect(parsePrice("45.999")).toEqual({ ok: true, value: 46 });
    expect(parsePrice("45.554")).toEqual({ ok: true, value: 45.55 });
  });

  it("accepts a price with its unit still attached", () => {
    // The box already shows "$". Someone pasting "$45" from a price list has
    // not made a mistake, and this is what stops it committing "$$45".
    expect(parsePrice("$45")).toEqual({ ok: true, value: 45 });
    expect(parsePrice("$1,200")).toEqual({ ok: true, value: 1200 });
    expect(parsePrice(" $45.50 ")).toEqual({ ok: true, value: 45.5 });
  });
});

describe("parseDuration", () => {
  it("reads a plain length", () => {
    expect(parseDuration("30")).toEqual({ ok: true, value: 30 });
  });

  it("treats an EMPTY box as 'not set'", () => {
    expect(parseDuration("")).toEqual({ ok: true, value: null });
  });

  it("ROUNDS a fractional length instead of silently dropping it", () => {
    // The old override builders required Number.isInteger and skipped the entry
    // when it failed: typing "7.5" saved nothing, said nothing, and the barber's
    // edit disappeared on reload.
    expect(parseDuration("7.5")).toEqual({ ok: true, value: 8 });
    expect(parseDuration("29.4")).toEqual({ ok: true, value: 29 });
  });

  it("refuses a negative length", () => {
    const r = parseDuration("-10");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/negative/i);
  });

  it("refuses input that isn't a number", () => {
    for (const junk of ["abc", "half an hour", "--"]) {
      expect(parseDuration(junk).ok).toBe(false);
    }
  });

  it("enforces the floor the API enforces", () => {
    const r = parseDuration("2", { min: MIN_SERVICE_MINUTES });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least 5/);
    expect(parseDuration("5", { min: MIN_SERVICE_MINUTES })).toEqual({
      ok: true,
      value: 5,
    });
  });

  it("allows zero where zero is meaningful", () => {
    // An add-on that costs money but no extra chair time is "+0 min".
    expect(parseDuration("0")).toEqual({ ok: true, value: 0 });
  });

  it("caps at a day, so a typo can't book out a week", () => {
    expect(parseDuration("100000").ok).toBe(false);
  });

  it("accepts a length with its unit still attached", () => {
    expect(parseDuration("30 min")).toEqual({ ok: true, value: 30 });
    expect(parseDuration("30min")).toEqual({ ok: true, value: 30 });
    expect(parseDuration("30 minutes")).toEqual({ ok: true, value: 30 });
  });
});

describe("formatting can't double up", () => {
  it("writes exactly one dollar sign and one unit", () => {
    expect(formatPrice(45)).toBe("$45");
    expect(formatPrice(45.5)).toBe("$45.50");
    expect(formatMinutes(30)).toBe("30 min");
  });

  it("survives a format -> parse -> format round trip", () => {
    // This is the "$$50" / "30 min min" guarantee stated as behaviour rather
    // than as a rule someone has to remember: a formatted value fed back
    // through the parser yields the SAME number, so re-displaying it produces
    // the same string rather than an accreting one.
    for (const n of [0, 5, 45, 45.5, 1200]) {
      const once = formatPrice(n);
      const back = parsePrice(once);
      expect(back).toEqual({ ok: true, value: n });
      expect(formatPrice((back as { value: number }).value)).toBe(once);
    }
    for (const n of [0, 5, 30, 90]) {
      const once = formatMinutes(n);
      const back = parseDuration(once);
      expect(back).toEqual({ ok: true, value: n });
      expect(formatMinutes((back as { value: number }).value)).toBe(once);
    }
  });

  it("the formatters take a number, so they cannot be applied twice", () => {
    // @ts-expect-error - a string is not a price; this is the type system doing
    // the work that a "remember not to double-format" comment used to.
    formatPrice("$45");
  });
});
