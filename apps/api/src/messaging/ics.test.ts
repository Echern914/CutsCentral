import { describe, expect, it } from "vitest";
import {
  buildAppointmentIcs,
  escapeIcsText,
  foldIcsLine,
  icsUtc,
} from "./ics.js";

/**
 * The .ics behind "Add to Calendar". Contract: RFC 5545-clean (CRLF, folding,
 * escaping), stable identity across reschedules (same UID, rising SEQUENCE),
 * UTC times, and nothing person-shaped beyond what the customer already knows
 * about their own booking.
 */

const base = {
  appointmentId: "appt_abc123",
  serviceName: "Skin Fade",
  shopName: "Drick's Barbershop",
  startsAt: new Date("2026-09-02T15:00:00Z"),
  endsAt: new Date("2026-09-02T15:30:00Z"),
  staffName: "Drick",
  addressLines: ["1 Main St", "Brooklyn", "NY"],
  manageUrl: "https://getchairback.com/book/manage/tok_abc123",
  sequence: 7,
};

describe("escaping and formatting", () => {
  it("escapes the four RFC 5545 specials", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  it("renders instants in the UTC Z form", () => {
    expect(icsUtc(new Date("2026-09-02T15:00:00.000Z"))).toBe("20260902T150000Z");
  });

  it("folds long lines on UTF-8 boundaries, never inside a code point", () => {
    const folded = foldIcsLine("SUMMARY:" + "é".repeat(100));
    for (const seg of folded.split("\r\n")) {
      expect(Buffer.from(seg, "utf8").length).toBeLessThanOrEqual(75);
      // Round-trips cleanly = no split code point.
      expect(seg.includes("�")).toBe(false);
    }
    // Unfolding restores the original.
    expect(folded.replace(/\r\n /g, "")).toBe("SUMMARY:" + "é".repeat(100));
  });

  it("leaves short lines untouched", () => {
    expect(foldIcsLine("VERSION:2.0")).toBe("VERSION:2.0");
  });
});

describe("the document", () => {
  it("carries the event, times in UTC, and CRLF endings", () => {
    const ics = buildAppointmentIcs(base);
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).toContain("DTSTART:20260902T150000Z\r\n");
    expect(ics).toContain("DTEND:20260902T153000Z\r\n");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    // No bare LF anywhere: every newline is CRLF.
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("names the service and shop, the barber and the manage link", () => {
    const ics = buildAppointmentIcs(base);
    expect(ics).toContain("SUMMARY:Skin Fade at Drick's Barbershop");
    expect(ics).toContain("With Drick.");
    expect(ics).toContain("LOCATION:1 Main St\\, Brooklyn\\, NY");
    expect(ics).toContain("book/manage/tok_abc123");
  });

  it("🔴 keeps the UID stable across a reschedule while SEQUENCE rises", () => {
    const before = buildAppointmentIcs(base);
    const after = buildAppointmentIcs({
      ...base,
      startsAt: new Date("2026-09-03T16:00:00Z"),
      endsAt: new Date("2026-09-03T16:30:00Z"),
      sequence: 8,
    });
    const uid = (s: string) => /UID:([^\r]+)/.exec(s)?.[1];
    // Same identity: the re-imported file REPLACES the calendar entry.
    expect(uid(before)).toBe(uid(after));
    expect(before).toContain("SEQUENCE:7");
    expect(after).toContain("SEQUENCE:8");
    expect(after).toContain("DTSTART:20260903T160000Z");
  });

  it("a hostile service name cannot inject properties", () => {
    const ics = buildAppointmentIcs({
      ...base,
      serviceName: "Fade\r\nATTENDEE:mailto:evil@example.com",
    });
    // The injected line is escaped into the SUMMARY value, not a new property.
    expect(ics).not.toMatch(/^ATTENDEE:/m);
    expect(ics).toContain("\\nATTENDEE");
  });

  it("omits LOCATION when the shop has no address, rather than an empty line", () => {
    const ics = buildAppointmentIcs({ ...base, addressLines: [null, "", undefined] });
    expect(ics).not.toContain("LOCATION:");
  });
});
