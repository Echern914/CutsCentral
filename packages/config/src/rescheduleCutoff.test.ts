import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESCHEDULE_CUTOFF_HOURS,
  RESCHEDULE_CUTOFF_MAX_HOURS,
  describeReschedulePolicy,
  formatCutoffHours,
  isValidRescheduleCutoff,
  rescheduleClosedMessage,
  rescheduleClosesAt,
  rescheduleCutoffPassed,
} from "./rescheduleCutoff.js";

const startsAt = new Date("2026-03-14T15:00:00.000Z");
const hoursBefore = (h: number) => new Date(startsAt.getTime() - h * 3_600_000);

describe("rescheduleCutoffPassed", () => {
  it("🔴 an hour before a 24-hour cutoff is too late (the barber left hanging)", () => {
    expect(rescheduleCutoffPassed({ startsAt, now: hoursBefore(1), cutoffHours: 24 })).toBe(true);
  });

  it("a day and a minute before is still open", () => {
    const now = new Date(hoursBefore(24).getTime() - 60_000);
    expect(rescheduleCutoffPassed({ startsAt, now, cutoffHours: 24 })).toBe(false);
  });

  it("exactly at the cutoff is still open; a millisecond later it is closed", () => {
    expect(rescheduleCutoffPassed({ startsAt, now: hoursBefore(24), cutoffHours: 24 })).toBe(false);
    const after = new Date(hoursBefore(24).getTime() + 1);
    expect(rescheduleCutoffPassed({ startsAt, now: after, cutoffHours: 24 })).toBe(true);
  });

  it("0 means the shop set no cutoff: open right up to the start", () => {
    const now = new Date(startsAt.getTime() - 60_000);
    expect(rescheduleCutoffPassed({ startsAt, now, cutoffHours: 0 })).toBe(false);
  });

  it("a nonsense value never closes it (fails open, like no setting)", () => {
    expect(rescheduleCutoffPassed({ startsAt, now: hoursBefore(1), cutoffHours: Number.NaN })).toBe(false);
    expect(rescheduleCutoffPassed({ startsAt, now: hoursBefore(1), cutoffHours: -5 })).toBe(false);
  });
});

describe("rescheduleClosesAt", () => {
  it("is the start minus the cutoff, or null with none", () => {
    expect(rescheduleClosesAt(startsAt, 2)?.toISOString()).toBe("2026-03-14T13:00:00.000Z");
    expect(rescheduleClosesAt(startsAt, 0)).toBeNull();
  });
});

describe("the words", () => {
  it("reads naturally", () => {
    expect(formatCutoffHours(1)).toBe("1 hour");
    expect(formatCutoffHours(12)).toBe("12 hours");
    expect(formatCutoffHours(24)).toBe("24 hours");
    expect(formatCutoffHours(36)).toBe("36 hours");
    expect(formatCutoffHours(48)).toBe("2 days");
  });

  it("the policy line says who can move it after the cutoff", () => {
    expect(describeReschedulePolicy(24)).toBe(
      "clients can move it themselves up to 24 hours before; after that only the shop can move it",
    );
    expect(describeReschedulePolicy(0)).toBe(
      "clients can move it themselves any time before the appointment",
    );
  });

  it("the client is told why and who to contact", () => {
    expect(rescheduleClosedMessage(24, "Sample Shop")).toBe(
      "Sample Shop takes changes online up to 24 hours before your appointment. To move it now, contact Sample Shop directly.",
    );
  });
});

describe("isValidRescheduleCutoff", () => {
  it("takes whole hours from 0 to a week", () => {
    for (const ok of [0, 1, 24, RESCHEDULE_CUTOFF_MAX_HOURS]) expect(isValidRescheduleCutoff(ok)).toBe(true);
    for (const bad of [-1, 1.5, RESCHEDULE_CUTOFF_MAX_HOURS + 1, "24", null, undefined, Number.NaN]) {
      expect(isValidRescheduleCutoff(bad)).toBe(false);
    }
  });

  it("the default is itself a valid setting", () => {
    expect(isValidRescheduleCutoff(DEFAULT_RESCHEDULE_CUTOFF_HOURS)).toBe(true);
  });
});
