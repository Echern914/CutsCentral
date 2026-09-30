import { describe, expect, it } from "vitest";
import {
  UNFINISHED_BOOKING_KEY,
  forgetUnfinishedBooking,
  readUnfinishedBooking,
  rememberUnfinishedBooking,
} from "./unfinishedBooking";

/** A Storage stand-in; `broken` throws on every call, like blocked storage. */
function memoryStore(broken = false) {
  const m = new Map<string, string>();
  const guard = () => {
    if (broken) throw new Error("SecurityError");
  };
  return {
    m,
    getItem: (k: string) => (guard(), m.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void m.set(k, v)),
    removeItem: (k: string) => (guard(), void m.delete(k)),
  };
}

const NOW = new Date("2026-09-30T16:55:00.000Z");
const HELD = { token: "tok_live", startsAt: "2026-10-07T00:00:00.000Z", expiresAt: "2026-09-30T17:04:02.000Z" };

describe("an unfinished booking on this device", () => {
  it("is offered back at the same shop while its hold runs", () => {
    const s = memoryStore();
    rememberUnfinishedBooking("sample-studio", HELD, NOW, s);
    expect(readUnfinishedBooking("sample-studio", NOW, s)).toEqual(HELD);
    // Another shop's page has nothing to finish.
    expect(readUnfinishedBooking("other-shop", NOW, s)).toBeNull();
  });

  it("🔴 is gone once the hold has run out - the time is already back on sale", () => {
    const s = memoryStore();
    rememberUnfinishedBooking("sample-studio", HELD, NOW, s);
    expect(readUnfinishedBooking("sample-studio", new Date("2026-09-30T17:04:02.000Z"), s)).toBeNull();
    // And it is removed on the way past, not kept around.
    expect(s.m.has(UNFINISHED_BOOKING_KEY)).toBe(false);
  });

  it("an already-expired hold is never remembered", () => {
    const s = memoryStore();
    rememberUnfinishedBooking("sample-studio", { ...HELD, expiresAt: "2026-09-30T16:50:00.000Z" }, NOW, s);
    expect(s.m.has(UNFINISHED_BOOKING_KEY)).toBe(false);
  });

  it("is forgotten when finished or waved away", () => {
    const s = memoryStore();
    rememberUnfinishedBooking("sample-studio", HELD, NOW, s);
    forgetUnfinishedBooking("sample-studio", s);
    expect(readUnfinishedBooking("sample-studio", NOW, s)).toBeNull();
  });

  it("a newer booking at the same shop replaces the older one", () => {
    const s = memoryStore();
    rememberUnfinishedBooking("sample-studio", HELD, NOW, s);
    const next = { ...HELD, token: "tok_new", expiresAt: "2026-09-30T17:06:00.000Z" };
    rememberUnfinishedBooking("sample-studio", next, NOW, s);
    expect(readUnfinishedBooking("sample-studio", NOW, s)?.token).toBe("tok_new");
  });

  it("anything malformed reads as nothing", () => {
    const s = memoryStore();
    s.m.set(UNFINISHED_BOOKING_KEY, "{not json");
    expect(readUnfinishedBooking("sample-studio", NOW, s)).toBeNull();
    s.m.set(UNFINISHED_BOOKING_KEY, JSON.stringify({ "sample-studio": { token: "", startsAt: "x", expiresAt: "y" } }));
    expect(readUnfinishedBooking("sample-studio", NOW, s)).toBeNull();
  });

  it("storage that throws never breaks the page", () => {
    const s = memoryStore(true);
    expect(() => rememberUnfinishedBooking("sample-studio", HELD, NOW, s)).not.toThrow();
    expect(readUnfinishedBooking("sample-studio", NOW, s)).toBeNull();
    expect(() => forgetUnfinishedBooking("sample-studio", s)).not.toThrow();
  });
});
