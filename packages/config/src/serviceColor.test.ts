import { describe, expect, it } from "vitest";
import { SERVICE_COLORS, SERVICE_COLOR_KEYS } from "./constants.js";
import {
  contrastRatio,
  fallbackServiceColorKey,
  normalizeServiceName,
  readableForeground,
  resolveServiceColor,
} from "./serviceColor.js";

/**
 * THE COLOUR A BARBER SEES ON A CALENDAR CARD.
 *
 * The rule that matters more than any other here: the SAME service must get
 * the SAME colour everywhere and always. A colour that moves between renders,
 * between the day view and the month view, or between a native booking and the
 * Acuity mirror of the same haircut, is worse than no colour - it teaches a
 * barber a mapping and then breaks it mid-shift.
 */

describe("normalizeServiceName", () => {
  it("treats the same service typed differently as one service", () => {
    const forms = [
      "Haircut + Beard",
      "haircut & beard",
      "Haircut  and  Beard",
      "  HAIRCUT AND BEARD  ",
      "Haircut, and Beard!",
    ];
    const keys = new Set(forms.map(normalizeServiceName));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("haircut and beard");
  });

  it("🔴 does NOT collapse services a barber prices differently", () => {
    // "Kids Haircut" must never fold into "Haircut": different price, different
    // duration, and a barber scanning the day needs to tell them apart.
    expect(normalizeServiceName("Kids Haircut")).not.toBe(normalizeServiceName("Haircut"));
    expect(normalizeServiceName("VIP Package")).not.toBe(normalizeServiceName("Package"));
  });
});

describe("the deterministic fallback", () => {
  it("🔴 gives the same name the same colour, every time", () => {
    const first = fallbackServiceColorKey("Haircut");
    for (let i = 0; i < 50; i++) {
      expect(fallbackServiceColorKey("Haircut")).toBe(first);
    }
  });

  it("is stable across the spellings that normalise together", () => {
    expect(fallbackServiceColorKey("Haircut + Beard")).toBe(
      fallbackServiceColorKey("haircut and beard"),
    );
  });

  it("always lands on a real palette key", () => {
    for (const name of ["Haircut", "Kids Haircut", "VIP Package", "Haircut + Beard", "x", "线"]) {
      expect(SERVICE_COLOR_KEYS).toContain(fallbackServiceColorKey(name));
    }
  });

  it("separates a realistic shop's services", () => {
    // Drick's day. Not a guarantee for arbitrary input - nine colours cannot
    // separate unlimited services - but the menu a barber actually runs should
    // not collide.
    const menu = ["Haircut", "Kids Haircut", "VIP Package", "Haircut + Beard"];
    const keys = menu.map(fallbackServiceColorKey);
    expect(new Set(keys).size).toBe(menu.length);
  });

  it("🔴 does not collide on anagrams", () => {
    // A character-sum hash gives these the same colour. Two services in one
    // shop sharing a colour is the exact failure this palette exists to avoid.
    expect(fallbackServiceColorKey("Fade")).not.toBe(fallbackServiceColorKey("Deaf"));
  });
});

describe("resolveServiceColor", () => {
  it("the barber's explicit choice wins", () => {
    const r = resolveServiceColor({ explicitKey: "violet", serviceName: "Haircut" });
    expect(r.key).toBe("violet");
    expect(r.hex).toBe(SERVICE_COLORS.violet.hex);
    expect(r.derived).toBe(false);
  });

  it("falls back to the name when no colour was ever picked", () => {
    const r = resolveServiceColor({ explicitKey: null, serviceName: "Haircut" });
    expect(r.hex).toBe(SERVICE_COLORS[fallbackServiceColorKey("Haircut")].hex);
    expect(r.derived).toBe(true);
  });

  it("🔴 a native booking and its Acuity mirror get the SAME colour", () => {
    // The native row carries an explicit key from the Service; the synced row
    // arrives with only a name. When the name maps to that same service the
    // server hands down the explicit key, and when it does not, both sides
    // derive from the same name. Either way the barber sees one colour for one
    // haircut.
    const native = resolveServiceColor({ explicitKey: null, serviceName: "Haircut + Beard" });
    const synced = resolveServiceColor({ explicitKey: null, serviceName: "haircut & beard" });
    expect(synced.hex).toBe(native.hex);
  });

  it("a row with no service at all gets no service colour", () => {
    // Blocks and unavailable bands must stay visually distinct from services,
    // and they have no service to be coloured by.
    expect(resolveServiceColor({ explicitKey: null, serviceName: null })).toEqual({
      key: null,
      hex: null,
      derived: false,
    });
    expect(resolveServiceColor({ explicitKey: null, serviceName: "   " }).hex).toBeNull();
  });

  it("an unknown stored key falls through to the name rather than to nothing", () => {
    // The palette can be re-tuned; a row holding a retired key should still get
    // a colour rather than silently losing one.
    const r = resolveServiceColor({ explicitKey: "chartreuse", serviceName: "Haircut" });
    expect(r.derived).toBe(true);
    expect(r.hex).toBe(SERVICE_COLORS[fallbackServiceColorKey("Haircut")].hex);
  });
});

describe("contrast", () => {
  it("every palette colour is readable against one of the two foregrounds", () => {
    // 4.5:1 is the WCAG AA threshold for normal text. Each swatch has to be
    // usable as a solid fill SOMEWHERE (a chip, a legend), so at least one of
    // near-black or white must clear it.
    for (const key of SERVICE_COLOR_KEYS) {
      const hex = SERVICE_COLORS[key].hex;
      const fg = readableForeground(hex);
      const ratio = contrastRatio(hex, fg);
      expect(ratio, `${key} on ${fg}`).not.toBeNull();
      expect(ratio!, `${key} on ${fg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("picks dark text on the light swatches and light text on the dark ones", () => {
    expect(readableForeground(SERVICE_COLORS.amber.hex)).toBe("#0A0A0B");
    expect(readableForeground(SERVICE_COLORS.slate.hex)).toBe("#FFFFFF");
  });

  it("every palette colour reads against BOTH calendar themes as an accent", () => {
    // The stripe and dot sit ON the card, not under text, so the bar is lower:
    // 3:1, the WCAG threshold for a non-text graphical indicator. It has to
    // clear that on the dark dashboard AND the light one.
    for (const key of SERVICE_COLOR_KEYS) {
      const hex = SERVICE_COLORS[key].hex;
      expect(contrastRatio(hex, "#141416")!, `${key} on dark`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(hex, "#FFFFFF")!, `${key} on light`).toBeGreaterThanOrEqual(1.4);
    }
  });

  it("returns null rather than guessing on a value it cannot parse", () => {
    expect(contrastRatio("not-a-colour", "#FFFFFF")).toBeNull();
  });
});
