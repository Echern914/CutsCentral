import { describe, expect, it } from "vitest";
import { mapGcalEvent, shouldIngestGcalEvent } from "./mapping.js";
import type { GcalEvent } from "./types.js";

function event(overrides: Partial<GcalEvent> = {}): GcalEvent {
  return {
    id: "ev1",
    status: "confirmed",
    summary: "Haircut - John Smith",
    start: { dateTime: "2026-07-04T15:00:00-04:00" },
    end: { dateTime: "2026-07-04T15:30:00-04:00" },
    ...overrides,
  };
}

describe("shouldIngestGcalEvent", () => {
  it("accepts a plain timed, titled, busy event", () => {
    expect(shouldIngestGcalEvent(event())).toBe(true);
  });

  it("rejects cancelled tombstones (they take the cancel path)", () => {
    expect(shouldIngestGcalEvent(event({ status: "cancelled" }))).toBe(false);
  });

  it("rejects all-day events (date, no dateTime)", () => {
    expect(
      shouldIngestGcalEvent(
        event({ start: { date: "2026-07-04" }, end: { date: "2026-07-05" } }),
      ),
    ).toBe(false);
  });

  it("rejects non-default event types (OOO, focus, birthdays, Gmail imports)", () => {
    for (const t of ["outOfOffice", "focusTime", "workingLocation", "birthday", "fromGmail"]) {
      expect(shouldIngestGcalEvent(event({ eventType: t }))).toBe(false);
    }
    expect(shouldIngestGcalEvent(event({ eventType: "default" }))).toBe(true);
  });

  it("rejects free (transparent) and untitled events", () => {
    expect(shouldIngestGcalEvent(event({ transparency: "transparent" }))).toBe(false);
    expect(shouldIngestGcalEvent(event({ summary: null }))).toBe(false);
    expect(shouldIngestGcalEvent(event({ summary: "   " }))).toBe(false);
  });
});

describe("mapGcalEvent — title parsing", () => {
  it('splits "Service - Name" (service first, the platform convention)', () => {
    const m = mapGcalEvent(event({ summary: "Haircut - John Smith" }))!;
    expect(m.firstName).toBe("John");
    expect(m.lastName).toBe("Smith");
    expect(m.serviceName).toBe("Haircut");
  });

  it('splits "Name - Service" when only one side is name-shaped', () => {
    const m = mapGcalEvent(event({ summary: "John Smith - Fade + beard trim #2" }))!;
    expect(m.firstName).toBe("John");
    expect(m.serviceName).toBe("Fade + beard trim #2");
  });

  it('handles "with" as a separator', () => {
    const m = mapGcalEvent(event({ summary: "Balayage with Mary-Jane O'Brien" }))!;
    expect(m.firstName).toBe("Mary-Jane");
    expect(m.lastName).toBe("O'Brien");
    expect(m.serviceName).toBe("Balayage");
  });

  it("prefers the RIGHT side as client when both sides look like names", () => {
    const m = mapGcalEvent(event({ summary: "Blow Dry - Ana Silva" }))!;
    expect(m.firstName).toBe("Ana");
    expect(m.lastName).toBe("Silva");
    expect(m.serviceName).toBe("Blow Dry");
  });

  it("lets the attendee display name settle an ambiguous split", () => {
    const m = mapGcalEvent(
      event({
        summary: "Ana Silva - Blow Dry",
        attendees: [{ email: "ana@example.com", displayName: "Ana Silva" }],
      }),
    )!;
    expect(m.firstName).toBe("Ana");
    expect(m.serviceName).toBe("Blow Dry");
    expect(m.email).toBe("ana@example.com");
  });

  it("keeps the full title as service when no name is parseable", () => {
    const m = mapGcalEvent(event({ summary: "Team meeting" }))!;
    expect(m.firstName).toBeNull();
    expect(m.serviceName).toBe("Team meeting");
    expect(m.clientKeySeed).toBe("Team meeting");
  });
});

describe("mapGcalEvent — contact extraction", () => {
  it("pulls a phone out of the description and normalizes to E.164", () => {
    const m = mapGcalEvent(
      event({ description: "Client: John\nPhone: (302) 555-0143\nNotes: fade" }),
    )!;
    expect(m.phone).toBe("+13025550143");
  });

  it("skips the organizer/self/resource attendees when picking the client", () => {
    const m = mapGcalEvent(
      event({
        attendees: [
          { email: "shop@gmail.com", self: true, organizer: true },
          { email: "room@resource.calendar.google.com", resource: true },
          { email: "client@example.com", displayName: "John Smith" },
        ],
      }),
    )!;
    expect(m.email).toBe("client@example.com");
  });

  it("falls back to an email in the description", () => {
    const m = mapGcalEvent(event({ description: "reach me at Client@Example.com" }))!;
    expect(m.email).toBe("client@example.com");
  });

  it("returns null when the times are unparseable", () => {
    expect(mapGcalEvent(event({ start: { dateTime: "not-a-date" } }))).toBeNull();
  });

  it("parses offsets into real instants", () => {
    const m = mapGcalEvent(event())!;
    expect(m.scheduledAt.toISOString()).toBe("2026-07-04T19:00:00.000Z");
    expect(m.endAt.toISOString()).toBe("2026-07-04T19:30:00.000Z");
  });
});
