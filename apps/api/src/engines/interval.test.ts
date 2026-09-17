import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPAN_MIN,
  isValidSpan,
  moveSpan,
  overlaps,
  spanFrom,
  visitSpan,
} from "./interval.js";

const at = (iso: string) => new Date(iso);
const span = (a: string, b: string) => ({ start: at(a), end: at(b) });

/**
 * THE INTERVAL RULE, at the level where it is cheap to pin exhaustively.
 *
 * Every case here is a way a chair gets sold twice. The half-open cases are not
 * academic: production carries 7 live appointment pairs that touch exactly, so
 * a closed reading would refuse 7 real back-to-back bookings, while a rule that
 * tolerates zero-length spans frees a chair that is occupied.
 */
describe("half-open overlap", () => {
  it("collides when the spans genuinely share time", () => {
    expect(overlaps(span("2026-09-18T10:00Z", "2026-09-18T10:30Z"),
                    span("2026-09-18T10:15Z", "2026-09-18T10:45Z"))).toBe(true);
    // containment, both directions
    expect(overlaps(span("2026-09-18T10:00Z", "2026-09-18T11:00Z"),
                    span("2026-09-18T10:15Z", "2026-09-18T10:20Z"))).toBe(true);
    expect(overlaps(span("2026-09-18T10:15Z", "2026-09-18T10:20Z"),
                    span("2026-09-18T10:00Z", "2026-09-18T11:00Z"))).toBe(true);
  });

  it("🔴 DOES NOT collide when they merely touch — 7 live pairs depend on this", () => {
    expect(overlaps(span("2026-09-18T10:00Z", "2026-09-18T10:30Z"),
                    span("2026-09-18T10:30Z", "2026-09-18T11:00Z"))).toBe(false);
    // and the same in the other order
    expect(overlaps(span("2026-09-18T10:30Z", "2026-09-18T11:00Z"),
                    span("2026-09-18T10:00Z", "2026-09-18T10:30Z"))).toBe(false);
  });

  it("does not collide when they are simply apart", () => {
    expect(overlaps(span("2026-09-18T10:00Z", "2026-09-18T10:30Z"),
                    span("2026-09-18T11:00Z", "2026-09-18T11:30Z"))).toBe(false);
  });
});

describe("span validity", () => {
  it("🔴 rejects zero-length — it is invalid, not harmless", () => {
    // [t, t) contains no instant, so it would overlap NOTHING and silently
    // stop blocking its own time. This is the visit.ts defect in one line.
    const t = at("2026-09-18T10:00Z");
    expect(isValidSpan(t, t)).toBe(false);
    expect(overlaps({ start: t, end: t }, span("2026-09-18T09:00Z", "2026-09-18T11:00Z"))).toBe(false);
  });

  it("rejects negative spans", () => {
    expect(isValidSpan(at("2026-09-18T10:30Z"), at("2026-09-18T10:00Z"))).toBe(false);
  });

  it("rejects absent and unparseable instants", () => {
    expect(isValidSpan(null, at("2026-09-18T10:00Z"))).toBe(false);
    expect(isValidSpan(at("2026-09-18T10:00Z"), null)).toBe(false);
    expect(isValidSpan(undefined, undefined)).toBe(false);
    // An Invalid Date compares false against everything, so it would sail
    // through an overlap test as "no conflict" if it were not caught here.
    expect(isValidSpan(new Date("nonsense"), at("2026-09-18T10:00Z"))).toBe(false);
  });

  it("accepts an ordinary span", () => {
    expect(isValidSpan(at("2026-09-18T10:00Z"), at("2026-09-18T10:01Z"))).toBe(true);
  });
});

describe("visitSpan — a synced visit always gets a blocking span", () => {
  it("uses the record's own end when it is usable", () => {
    const v = visitSpan({ scheduledAt: at("2026-09-18T10:00Z"), endAt: at("2026-09-18T10:45Z") });
    expect(v.end.toISOString()).toBe("2026-09-18T10:45:00.000Z");
    expect(v.derived).toBe(false);
  });

  it("🔴 blocks conservatively when the end is NULL, rather than vanishing", () => {
    // The old readers did `endAt: { gt: … }`, and SQL drops NULL — so the
    // calendar drew the visit and the booking page sold its time.
    const v = visitSpan({ scheduledAt: at("2026-09-18T10:00Z"), endAt: null });
    expect(v.derived).toBe(true);
    expect(v.end.getTime() - v.start.getTime()).toBe(DEFAULT_SPAN_MIN * 60_000);
    expect(overlaps(v, span("2026-09-18T10:10Z", "2026-09-18T10:20Z"))).toBe(true);
  });

  it("repairs a zero-length end the same way", () => {
    const t = at("2026-09-18T10:00Z");
    const v = visitSpan({ scheduledAt: t, endAt: t });
    expect(v.derived).toBe(true);
    expect(isValidSpan(v.start, v.end)).toBe(true);
  });

  it("repairs a negative end the same way", () => {
    const v = visitSpan({ scheduledAt: at("2026-09-18T10:00Z"), endAt: at("2026-09-18T09:00Z") });
    expect(v.derived).toBe(true);
    expect(v.end.getTime()).toBeGreaterThan(v.start.getTime());
  });
});

describe("moveSpan — a record that moves keeps its real duration", () => {
  it("PRESERVES the authoritative duration (45 min stays 45 min)", () => {
    // The visit's own span is authoritative: it came from Acuity's
    // endTime/duration at ingest. Preserving the delta preserves the truth.
    const moved = moveSpan(
      { start: at("2026-09-18T10:00Z"), end: at("2026-09-18T10:45Z") },
      at("2026-09-20T14:00Z"),
    );
    expect(moved.derived).toBe(false);
    expect(moved.start.toISOString()).toBe("2026-09-20T14:00:00.000Z");
    expect(moved.end.toISOString()).toBe("2026-09-20T14:45:00.000Z");
  });

  it("🔴 NEVER returns end === start, which is what the bug did", () => {
    const newStart = at("2026-09-20T14:00Z");
    for (const prior of [
      { start: at("2026-09-18T10:00Z"), end: at("2026-09-18T10:30Z") },
      { start: at("2026-09-18T10:00Z"), end: null },
      { start: at("2026-09-18T10:00Z"), end: at("2026-09-18T10:00Z") },
      { start: at("2026-09-18T10:00Z"), end: at("2026-09-18T09:00Z") },
    ]) {
      const moved = moveSpan(prior, newStart);
      expect(moved.end.getTime()).toBeGreaterThan(moved.start.getTime());
      expect(isValidSpan(moved.start, moved.end)).toBe(true);
    }
  });

  it("falls back to the default span ONLY when the prior span is unusable, and says so", () => {
    const moved = moveSpan({ start: at("2026-09-18T10:00Z"), end: null }, at("2026-09-20T14:00Z"));
    expect(moved.derived).toBe(true);
    expect(moved.end.getTime() - moved.start.getTime()).toBe(DEFAULT_SPAN_MIN * 60_000);
  });
});

describe("spanFrom", () => {
  it("never produces a zero-length span, even from a zero duration", () => {
    const s = spanFrom(at("2026-09-18T10:00Z"), 0);
    expect(isValidSpan(s.start, s.end)).toBe(true);
  });
});
