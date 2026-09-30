import { describe, expect, it } from "vitest";
import { squareSyncLine, type SquareSyncStatus } from "./squareSyncStatus";

const NOW = new Date("2026-09-30T18:00:00.000Z");
const synced: SquareSyncStatus = {
  backfilledAt: "2026-09-30T17:15:00.000Z",
  lastSyncedAt: "2026-09-30T17:45:00.000Z",
  lastSyncError: null,
  importedVisits: 1234,
};

describe("the line under the Square card", () => {
  it("says what arrived and when, once the book is in", () => {
    expect(squareSyncLine(synced, NOW)).toEqual({
      tone: "ok",
      text: "1,234 appointments from Square · synced 15 min ago",
    });
  });

  it("says it is importing until the whole book has come in", () => {
    expect(squareSyncLine({ ...synced, backfilledAt: null, importedVisits: 0 }, NOW).tone).toBe("working");
  });

  it("🔴 never says 'Connected' alone while Square refuses every request", () => {
    const line = squareSyncLine({ ...synced, lastSyncError: "UNAUTHORIZED" }, NOW);
    expect(line.tone).toBe("refused");
    expect(line.text).toMatch(/nothing is syncing/);
    expect(line.text).toMatch(/Reconnect Square/);
  });

  it("a passing failure is a softer note: it retries on its own", () => {
    const line = squareSyncLine({ ...synced, lastSyncError: "RATE_LIMITED" }, NOW);
    expect(line.tone).toBe("warn");
    expect(line.text).toMatch(/tries again every 30 minutes/);
  });

  it("counts one appointment in the singular", () => {
    expect(squareSyncLine({ ...synced, importedVisits: 1 }, NOW).text).toMatch(/^1 appointment from Square/);
  });
});
