import { describe, expect, it } from "vitest";
import { WHATS_NEW, unseenWhatsNew, type WhatsNewEntry } from "./whatsNew";

/**
 * The bell's changelog is edited by hand in every PR that ships something a
 * barber would notice. These keep the hand-edits honest: the read marker is
 * an id, so ids must be unique and stable-looking, and "new" is "above the
 * marker", so the list must stay newest first.
 */

describe("the What's new list", () => {
  it("ids are unique", () => {
    const ids = WHATS_NEW.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every id starts with its own date, and every date is a real day", () => {
    for (const e of WHATS_NEW) {
      expect(e.date, e.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${e.date}T00:00:00Z`)), e.id).toBe(false);
      expect(e.id.startsWith(`${e.date}-`), e.id).toBe(true);
      expect(e.id, e.id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/);
    }
  });

  it("🔴 is newest first - a new entry goes at the TOP", () => {
    for (let i = 1; i < WHATS_NEW.length; i++) {
      expect(WHATS_NEW[i]!.date <= WHATS_NEW[i - 1]!.date, WHATS_NEW[i]!.id).toBe(true);
    }
  });

  it("titles fit one line and bodies stay short", () => {
    for (const e of WHATS_NEW) {
      expect(e.title.length, e.id).toBeLessThanOrEqual(60);
      expect(e.body.length, e.id).toBeLessThanOrEqual(280);
      expect(e.title.trim(), e.id).toBe(e.title);
    }
  });

  it("never names a PR or an internal file", () => {
    for (const e of WHATS_NEW) {
      expect(`${e.title} ${e.body}`, e.id).not.toMatch(/#\d+|\.tsx?\b|\bPR\b/);
    }
  });
});

describe("what a barber has not seen yet", () => {
  const list: WhatsNewEntry[] = [
    { id: "2026-10-02-c", date: "2026-10-02", kind: "fix", title: "C", body: "c" },
    { id: "2026-10-01-b", date: "2026-10-01", kind: "feature", title: "B", body: "b" },
    { id: "2026-09-30-a", date: "2026-09-30", kind: "feature", title: "A", body: "a" },
  ];
  const longAgo = new Date("2026-01-01T00:00:00Z");

  it("everything above the last one they saw", () => {
    expect(unseenWhatsNew("2026-09-30-a", longAgo, list).map((e) => e.id)).toEqual(["2026-10-02-c", "2026-10-01-b"]);
    expect(unseenWhatsNew("2026-10-02-c", longAgo, list)).toEqual([]);
  });

  it("a marker that no longer matches falls back to its date", () => {
    expect(unseenWhatsNew("2026-10-01-removed", longAgo, list).map((e) => e.id)).toEqual(["2026-10-02-c"]);
  });

  it("a new account starts from the day it joined, not from the beginning", () => {
    expect(unseenWhatsNew(null, new Date("2026-10-01T15:00:00Z"), list).map((e) => e.id)).toEqual([
      "2026-10-02-c",
      "2026-10-01-b",
    ]);
  });
});
