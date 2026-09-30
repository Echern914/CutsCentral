import { describe, expect, it } from "vitest";
import {
  REMEMBERED_BOOKER_KEY,
  agreedAtFor,
  contactIdentity,
  forgetBooker,
  readRememberedBooker,
  rememberBooker,
} from "./rememberedBooker";

/**
 * "Remember me on this device": what is kept, for whom, and what is never
 * carried. The page-level behaviour lives in BookingPolicy.test.tsx.
 */

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

const CASEY = { firstName: "Casey", lastName: "Tester", phone: "(302) 555-0142", email: "casey@example.com" };
const FIRST = "2026-09-01T15:30:00.000Z";

describe("who a contact is", () => {
  it("is the phone's last ten digits, however it was typed", () => {
    expect(contactIdentity({ phone: "(302) 555-0142", email: "" })).toBe("tel:3025550142");
    expect(contactIdentity({ phone: "+1 302 555 0142", email: "x@y.z" })).toBe("tel:3025550142");
  });

  it("is the email, lowercased, when there is no phone", () => {
    expect(contactIdentity({ phone: "", email: " Casey@Example.com " })).toBe("mail:casey@example.com");
  });

  it("is nobody yet while the form holds neither", () => {
    expect(contactIdentity({ phone: "12", email: "  " })).toBeNull();
  });
});

describe("remembering and forgetting", () => {
  it("keeps the four fields, trimmed, and reads them back", () => {
    const s = memoryStore();
    rememberBooker({ ...CASEY, firstName: "  Casey " }, null, s);
    expect(readRememberedBooker(s)).toEqual({ contact: CASEY, agreements: {} });
  });

  it("🔴 keeps ONLY contact fields and agreements - no consent of any kind", () => {
    const s = memoryStore();
    rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, s);
    const stored = JSON.parse(s.raw.get(REMEMBERED_BOOKER_KEY)!);
    expect(Object.keys(stored).sort()).toEqual(["agreements", "contact"]);
    expect(Object.keys(stored.contact).sort()).toEqual(["email", "firstName", "lastName", "phone"]);
    expect(Object.keys(stored.agreements.drick).sort()).toEqual(["agreedAt", "version", "who"]);
  });

  it("forgets everything in one go", () => {
    const s = memoryStore();
    rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, s);
    forgetBooker(s);
    expect(readRememberedBooker(s)).toBeNull();
  });

  it("will not remember a nameless or contactless booker", () => {
    const s = memoryStore();
    expect(rememberBooker({ ...CASEY, firstName: " " }, null, s)).toBeNull();
    expect(rememberBooker({ ...CASEY, phone: "", email: "" }, null, s)).toBeNull();
    expect(readRememberedBooker(s)).toBeNull();
  });

  it("reads anything malformed as nothing, never a crash", () => {
    const s = memoryStore();
    for (const bad of ["{", "null", "[]", '{"contact":5}', '{"contact":{"firstName":1}}']) {
      s.raw.set(REMEMBERED_BOOKER_KEY, bad);
      expect(readRememberedBooker(s)).toBeNull();
    }
    // A bad agreement is dropped; the contact survives.
    s.raw.set(
      REMEMBERED_BOOKER_KEY,
      JSON.stringify({ contact: CASEY, agreements: { a: { version: "v", agreedAt: "soon", who: "x" }, b: 3 } }),
    );
    expect(readRememberedBooker(s)).toEqual({ contact: CASEY, agreements: {} });
  });

  it("🔴 a browser that refuses storage simply remembers nothing", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readRememberedBooker(throwing)).toBeNull();
    expect(rememberBooker(CASEY, null, throwing)).toBeNull();
    expect(() => forgetBooker(throwing)).not.toThrow();
    expect(readRememberedBooker(null)).toBeNull();
  });
});

describe("carrying a policy agreement", () => {
  it("carries for the same shop, the same words and the same person", () => {
    const s = memoryStore();
    const b = rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, s);
    expect(agreedAtFor(b, "drick", "v1", contactIdentity(CASEY))).toBe(FIRST);
  });

  it("🔴 NOT once the shop has changed a word - a new version asks again", () => {
    const b = rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, memoryStore());
    expect(agreedAtFor(b, "drick", "v2", contactIdentity(CASEY))).toBeNull();
  });

  it("🔴 NOT for someone else typing their own number on this phone", () => {
    const b = rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, memoryStore());
    expect(agreedAtFor(b, "drick", "v1", contactIdentity({ phone: "2125550199", email: "" }))).toBeNull();
    expect(agreedAtFor(b, "drick", "v1", null)).toBeNull();
  });

  it("NOT at another shop - agreeing to one shop's rules is not agreeing to the next", () => {
    const b = rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, memoryStore());
    expect(agreedAtFor(b, "another-shop", "v1", contactIdentity(CASEY))).toBeNull();
  });

  it("keeps each shop's agreement as the same person books around", () => {
    const s = memoryStore();
    rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, s);
    const b = rememberBooker(CASEY, { shop: "fade-lab", version: "f1", agreedAt: "2026-09-20T12:00:00.000Z" }, s);
    const who = contactIdentity(CASEY);
    expect(agreedAtFor(b, "drick", "v1", who)).toBe(FIRST);
    expect(agreedAtFor(b, "fade-lab", "f1", who)).toBe("2026-09-20T12:00:00.000Z");
  });

  it("🔴 a DIFFERENT person booking on this device replaces the last one, agreements and all", () => {
    const s = memoryStore();
    rememberBooker(CASEY, { shop: "drick", version: "v1", agreedAt: FIRST }, s);
    const jordan = { firstName: "Jordan", lastName: "D", phone: "2125550199", email: "" };
    const b = rememberBooker(jordan, null, s);
    expect(b!.contact.firstName).toBe("Jordan");
    expect(b!.agreements).toEqual({});
    // Casey's number is no longer on this device at all.
    expect(s.raw.get(REMEMBERED_BOOKER_KEY)).not.toContain("3025550142");
  });
});
