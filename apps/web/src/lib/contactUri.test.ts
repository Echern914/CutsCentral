import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyText,
  mailtoUri,
  normalizeEmail,
  normalizePhone,
  smsUri,
  telUri,
} from "./contactUri";

/**
 * THE CONTACT HANDOFF, at the level where it can be proved.
 *
 * A barber taps Text and iOS opens Messages with the client already in the To
 * field. Everything between those two facts is this module, so this is where
 * the shapes a real phone field actually holds get pinned down: what came out
 * of an Acuity import, what a barber typed with dashes, what a customer typed
 * with a country code — and the junk, which must produce NO action rather than
 * a link that fails in someone's hand.
 */
describe("normalizePhone", () => {
  it("dials the shapes a phone field really holds", () => {
    // Every one of these is a real stored format; all one number.
    expect(normalizePhone("(845) 555-1212")).toBe("+18455551212");
    expect(normalizePhone("845-555-1212")).toBe("+18455551212");
    expect(normalizePhone("845.555.1212")).toBe("+18455551212");
    expect(normalizePhone("8455551212")).toBe("+18455551212");
    expect(normalizePhone("1 (845) 555-1212")).toBe("+18455551212");
  });

  it("leaves an already-normalized +1 number alone", () => {
    expect(normalizePhone("+18455551212")).toBe("+18455551212");
    expect(normalizePhone("+1 845 555 1212")).toBe("+18455551212");
  });

  it("keeps a non-US number in its own country code", () => {
    expect(normalizePhone("+44 20 7123 4567")).toBe("+442071234567");
  });

  it("keeps accepting the punctuation people write numbers with", () => {
    expect(normalizePhone("+1 (845) 555-1212")).toBe("+18455551212");
    expect(normalizePhone("(845) 555.1212")).toBe("+18455551212");
    expect(normalizePhone("  845 555 1212  ")).toBe("+18455551212");
    expect(normalizePhone("845 - 555 - 1212")).toBe("+18455551212");
  });

  it("REFUSES A VALUE WITH LETTERS IN IT, however many digits it also has", () => {
    // 🔴 The reason DIALABLE is tested BEFORE the digits are stripped:
    // every one of these leaves a clean, plausible 10 digits behind, so
    // stripping first would silently turn junk into a number we would dial.
    expect(normalizePhone("abc8455551212")).toBeNull();
    expect(normalizePhone("8455551212hello")).toBeNull();
    expect(normalizePhone("845555121a")).toBeNull();
    expect(normalizePhone("(845) 555-1212 ext 3")).toBeNull();
    expect(normalizePhone("call 8455551212 after 6")).toBeNull();
    expect(normalizePhone("845-555-1212/8455551213")).toBeNull();
    expect(normalizePhone("+1o8455551212")).toBeNull();
  });

  it("refuses anything it cannot dial, rather than guessing", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
    expect(normalizePhone("call me!!")).toBeNull();
    expect(normalizePhone("555-1212")).toBeNull(); // 7 digits, no area code
    expect(normalizePhone("845-555-1212 x23")).toBeNull(); // extension
    expect(normalizePhone("+1")).toBeNull(); // a fragment
    expect(normalizePhone("2" .repeat(16))).toBeNull(); // past E.164's ceiling
  });
});

describe("normalizeEmail", () => {
  it("accepts a plain address and trims it", () => {
    expect(normalizeEmail("  customer@example.com ")).toBe("customer@example.com");
    expect(normalizeEmail("first.last+tag@sub.example.co.uk")).toBe(
      "first.last+tag@sub.example.co.uk",
    );
  });

  it("refuses what is not one address", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail("nobody@")).toBeNull();
    expect(normalizeEmail("@example.com")).toBeNull();
    expect(normalizeEmail("nodomain@localhost")).toBeNull();
    expect(normalizeEmail("two@a.com, three@b.com")).toBeNull();
    expect(normalizeEmail("Name <name@a.com>")).toBeNull();
  });

  it("refuses a newline, which in a mailto: is header injection", () => {
    expect(normalizeEmail("a@b.com\nbcc: victim@c.com")).toBeNull();
    expect(normalizeEmail("a@b.com\r\nbcc: victim@c.com")).toBeNull();
  });
});

describe("the URIs a tap hands to the OS", () => {
  it("texts through sms: with no body at all", () => {
    // 🔴 No body, no `smsto:`, no `imessage:` — iOS decides which it is.
    expect(smsUri("(845) 555-1212")).toBe("sms:+18455551212");
    expect(smsUri("+18455551212")).toBe("sms:+18455551212");
  });

  it("calls through tel:", () => {
    expect(telUri("845-555-1212")).toBe("tel:+18455551212");
  });

  it("mails through an encoded mailto:, @ intact", () => {
    expect(mailtoUri("customer@example.com")).toBe("mailto:customer@example.com");
    // "?" would otherwise start mailto's header section.
    expect(mailtoUri("odd?name@example.com")).toBe("mailto:odd%3Fname@example.com");
    expect(mailtoUri("a+b@example.com")).toBe("mailto:a%2Bb@example.com");
  });

  it("gives back NOTHING to launch when the value is unusable", () => {
    // The caller's contract: null means don't render the action at all.
    for (const bad of [null, undefined, "", "call me!!", "555-1212"]) {
      expect(telUri(bad)).toBeNull();
      expect(smsUri(bad)).toBeNull();
    }
    for (const bad of [null, undefined, "", "not an email", "nobody@"]) {
      expect(mailtoUri(bad)).toBeNull();
    }
  });

  it("never emits a scheme the caller supplied", () => {
    // A stored value that looks like a URI is still just a bad phone/email.
    expect(smsUri("javascript:alert(1)")).toBeNull();
    expect(telUri("javascript:alert(1)")).toBeNull();
    expect(mailtoUri("javascript:alert(1)")).toBeNull();
    // And anything that DOES come back can only start with one of three.
    const all = [smsUri("8455551212"), telUri("8455551212"), mailtoUri("a@b.com")];
    for (const uri of all) {
      expect(uri).toMatch(/^(sms|tel|mailto):/);
    }
  });
});

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error - test-only teardown of the legacy hook.
    delete document.execCommand;
  });

  it("uses the clipboard API when it is there", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("+18455551212")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("+18455551212");
  });

  it("falls back to a selection when the clipboard API is missing", async () => {
    // An insecure origin or an older WKWebView: no navigator.clipboard at all.
    vi.stubGlobal("navigator", {});
    // jsdom leaves execCommand unimplemented, so the fallback path needs one.
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    await expect(copyText("+18455551212")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    // The scratch node must not be left in the document.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("falls back when the clipboard API is there but REFUSES", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    await expect(copyText("+18455551212")).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it("reports failure instead of throwing when both ways are gone", async () => {
    vi.stubGlobal("navigator", {});
    // No execCommand either: the caller must get `false`, not an exception.
    await expect(copyText("+18455551212")).resolves.toBe(false);
  });

  /**
   * 🔴 THE SCRATCH TEXTAREA MUST NEVER SURVIVE A FAILURE. It is off-screen and
   * invisible, and it holds the client's phone number, so one left behind per
   * failed attempt is a pile of contact details sitting in the DOM where
   * nothing will ever clean them up. Cleanup therefore lives in `finally`, and
   * these prove it for each place the copy can throw.
   */
  it("removes the scratch textarea when execCommand THROWS", async () => {
    vi.stubGlobal("navigator", {});
    const before = document.querySelectorAll("textarea").length;
    document.execCommand = vi.fn(() => {
      throw new Error("NotAllowedError");
    });
    await expect(copyText("+18455551212")).resolves.toBe(false);
    expect(document.querySelectorAll("textarea")).toHaveLength(before);
    expect(document.body.textContent).not.toContain("8455551212");
  });

  it("removes the scratch textarea when the SELECTION throws", async () => {
    vi.stubGlobal("navigator", {});
    const before = document.querySelectorAll("textarea").length;
    const select = vi
      .spyOn(HTMLTextAreaElement.prototype, "select")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    document.execCommand = vi.fn(() => true);
    try {
      await expect(copyText("+18455551212")).resolves.toBe(false);
      expect(document.querySelectorAll("textarea")).toHaveLength(before);
    } finally {
      select.mockRestore();
    }
  });

  it("leaves nothing behind across repeated failures", async () => {
    vi.stubGlobal("navigator", {});
    const before = document.querySelectorAll("textarea").length;
    document.execCommand = vi.fn(() => {
      throw new Error("NotAllowedError");
    });
    for (let i = 0; i < 5; i++) await copyText("+18455551212");
    expect(document.querySelectorAll("textarea")).toHaveLength(before);
  });
});
