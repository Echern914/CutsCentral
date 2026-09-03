import { describe, expect, it } from "vitest";
import { untilLabel } from "./relativeTime.js";

/**
 * "How long until my appointment?" - the one answer the manage page and the
 * app's next-visit card both give, pinned so they cannot drift apart.
 */

const TZ = "America/New_York";
// A Monday evening in New York (23:00 local = 03:00Z Tuesday).
const NOW = new Date("2026-09-08T03:00:00Z");
const at = (iso: string) => new Date(iso);

describe("untilLabel", () => {
  it("counts real time under a day", () => {
    expect(untilLabel(at("2026-09-08T03:00:20Z"), NOW, TZ)).toBe("right now");
    expect(untilLabel(at("2026-09-08T03:01:00Z"), NOW, TZ)).toBe("in 1 minute");
    expect(untilLabel(at("2026-09-08T03:45:00Z"), NOW, TZ)).toBe("in 45 minutes");
    expect(untilLabel(at("2026-09-08T04:20:00Z"), NOW, TZ)).toBe("in 1 hour 20 minutes");
    expect(untilLabel(at("2026-09-08T05:00:00Z"), NOW, TZ)).toBe("in 2 hours");
    // Far enough out that minutes are noise.
    expect(untilLabel(at("2026-09-08T12:10:00Z"), NOW, TZ)).toBe("in 9 hours");
  });

  it("🔴 'tomorrow' is a CALENDAR day in the shop's zone, not 24 hours", () => {
    // 11pm Monday -> 9am Tuesday is ten hours away and still "tomorrow": that
    // is how the customer thinks about it, and what "the day before" means.
    // (Under 24h the hour count wins; this is the first instant past it.)
    expect(untilLabel(at("2026-09-09T03:00:00Z"), NOW, TZ)).toBe("tomorrow");
    // ...and an appointment 30 hours out that lands the day after tomorrow in
    // New York is NOT "tomorrow".
    expect(untilLabel(at("2026-09-09T09:00:00Z"), NOW, TZ)).toBe("in 2 days");
  });

  it("the zone matters: the same instant is a different day elsewhere", () => {
    // 03:00Z Tuesday is Monday night in New York but Tuesday morning in London.
    // 47 hours later is Thursday 02:00Z: Wednesday night NY (2 days), Thursday
    // morning London (2 days) - and 26h later is Wed 05:00Z: Wed 1am NY (2
    // days), Wed 6am London (1 day = "tomorrow").
    const later = at("2026-09-09T05:00:00Z");
    expect(untilLabel(later, NOW, TZ)).toBe("in 2 days");
    expect(untilLabel(later, NOW, "Europe/London")).toBe("tomorrow");
  });

  it("switches to weeks when days stop being useful", () => {
    // NOW is Monday Sep 7 on New York's clock; Sep 20 is thirteen days on.
    expect(untilLabel(at("2026-09-20T15:00:00Z"), NOW, TZ)).toBe("in 13 days");
    expect(untilLabel(at("2026-09-22T15:00:00Z"), NOW, TZ)).toBe("in 2 weeks");
    expect(untilLabel(at("2026-11-10T15:00:00Z"), NOW, TZ)).toBe("in 9 weeks");
  });

  it("returns null once the time has passed - never a negative", () => {
    expect(untilLabel(at("2026-09-08T02:59:00Z"), NOW, TZ)).toBeNull();
    expect(untilLabel(at("2026-09-01T00:00:00Z"), NOW, TZ)).toBeNull();
    expect(untilLabel(new Date(NaN), NOW, TZ)).toBeNull();
  });
});
