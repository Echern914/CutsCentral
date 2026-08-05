import { describe, expect, it } from "vitest";
import type { AcuityAppointment } from "./types.js";
import type { ListParams } from "./client.js";
import { walkAcuityAppointments } from "./walk.js";

/**
 * Pure walk tests - no DB, a tiny fake server. The invariant under test:
 * the walk reads EVERYTHING the server has in the window, no matter what the
 * server caps `max` at, and always terminates.
 */

function appt(id: number, iso: string): AcuityAppointment {
  return { id: String(id), datetime: iso } as AcuityAppointment;
}

/** A fake Acuity: ASC by datetime, inclusive minDate, caps max at `serverCap`. */
function fakeServer(data: AcuityAppointment[], serverCap: number) {
  const calls: ListParams[] = [];
  const sorted = [...data].sort(
    (a, b) => Date.parse(a.datetime) - Date.parse(b.datetime),
  );
  return {
    calls,
    listAppointments: async (p: ListParams) => {
      calls.push(p);
      const min = p.minDate ? Date.parse(p.minDate) : Number.NEGATIVE_INFINITY;
      const max = p.maxDate ? Date.parse(p.maxDate) + 24 * 3600_000 : Number.POSITIVE_INFINITY;
      return sorted
        .filter((a) => {
          const t = Date.parse(a.datetime);
          return t >= min && t <= max;
        })
        .slice(0, Math.min(p.max ?? 100, serverCap));
    },
  };
}

async function walkAll(server: ReturnType<typeof fakeServer>) {
  const got: string[] = [];
  const n = await walkAcuityAppointments(
    server,
    { shopId: "s1", minDate: "2015-01-01", canceled: false },
    async (a) => {
      got.push(a.id);
    },
  );
  return { n, got };
}

describe("walkAcuityAppointments", () => {
  it("reads everything when the server caps max BELOW what we could ask for", async () => {
    // 250 appointments, server serves at most 100 per page regardless of `max`.
    const data = Array.from({ length: 250 }, (_, i) =>
      appt(i + 1, new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString()),
    );
    const server = fakeServer(data, 100);
    const { n, got } = await walkAll(server);
    expect(n).toBe(250);
    expect(new Set(got).size).toBe(250);
  });

  it("reads everything when the server caps even lower than the requested page size", async () => {
    // A hypothetical stricter cap (25): page-shortness never fools the walk.
    const data = Array.from({ length: 120 }, (_, i) =>
      appt(i + 1, new Date(Date.UTC(2026, 2, 1 + (i % 30), 9, i)).toISOString()),
    );
    const server = fakeServer(data, 25);
    const { n } = await walkAll(server);
    expect(n).toBe(120);
  });

  it("terminates cleanly when the data size is an exact multiple of the page", async () => {
    // 200 = exactly two full pages: the old walk's `short page = done` check
    // never fires; termination must come from no-fresh-ids/empty instead.
    const data = Array.from({ length: 200 }, (_, i) =>
      appt(i + 1, new Date(Date.UTC(2026, 4, 1, 8, 0, i)).toISOString()),
    );
    const server = fakeServer(data, 100);
    const { n } = await walkAll(server);
    expect(n).toBe(200);
    // Sanity: it stopped (we got here) in a bounded number of calls.
    expect(server.calls.length).toBeLessThan(10);
  });

  it("walks through a DAY denser than a whole page instead of aborting", async () => {
    // 150 appointments on one day (distinct seconds) + 50 after it. The old
    // resync used day-granularity cursors: a dense day tripped its stuck-cursor
    // guard and everything AFTER that day was silently dropped, forever.
    const dense = Array.from({ length: 150 }, (_, i) =>
      appt(i + 1, new Date(Date.UTC(2026, 6, 4, 8, 0, i)).toISOString()),
    );
    const later = Array.from({ length: 50 }, (_, i) =>
      appt(1000 + i, new Date(Date.UTC(2026, 6, 10 + i, 12)).toISOString()),
    );
    const server = fakeServer([...dense, ...later], 100);
    const { n, got } = await walkAll(server);
    expect(n).toBe(200);
    expect(got).toContain("1049"); // the last appointment AFTER the dense day
  });

  it("survives a full page sharing ONE instant (nudges 1s, keeps going)", async () => {
    // 100 at the same second, then 30 later. Inclusive minDate would re-serve
    // the same page forever; the walk must nudge past it, not loop or bail.
    const sameInstant = Array.from({ length: 100 }, (_, i) =>
      appt(i + 1, "2026-08-01T09:00:00Z"),
    );
    const later = Array.from({ length: 30 }, (_, i) =>
      appt(500 + i, new Date(Date.UTC(2026, 7, 2 + i, 9)).toISOString()),
    );
    const server = fakeServer([...sameInstant, ...later], 100);
    const { n } = await walkAll(server);
    expect(n).toBe(130);
  });

  it("hands each appointment to handle() exactly once across page overlaps", async () => {
    // Inclusive-minDate cursoring re-reads the boundary appointment on every
    // page; the seen-set must dedupe it.
    const data = Array.from({ length: 101 }, (_, i) =>
      appt(i + 1, new Date(Date.UTC(2026, 9, 1, 10, 0, i)).toISOString()),
    );
    const server = fakeServer(data, 100);
    const counts = new Map<string, number>();
    await walkAcuityAppointments(
      server,
      { shopId: "s1", minDate: "2015-01-01", canceled: false },
      async (a) => {
        counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
      },
    );
    expect(counts.size).toBe(101);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });

  it("skips unparseable datetimes without stalling the cursor", async () => {
    const good = Array.from({ length: 5 }, (_, i) =>
      appt(i + 1, new Date(Date.UTC(2026, 10, 1 + i, 9)).toISOString()),
    );
    const bad = { id: "999", datetime: "not-a-date" } as AcuityAppointment;
    const server = fakeServer([...good], 100);
    // Inject the unparseable row into the first page only.
    const orig = server.listAppointments;
    let first = true;
    server.listAppointments = async (p) => {
      const page = await orig(p);
      if (first) {
        first = false;
        return [bad, ...page];
      }
      return page;
    };
    const { n, got } = await walkAll(server);
    expect(n).toBe(6); // handled (ingest itself skips bad datetimes later)
    expect(got).toContain("999");
  });

  it("respects maxDate as the window's far edge", async () => {
    const inWindow = Array.from({ length: 10 }, (_, i) =>
      appt(i + 1, new Date(Date.UTC(2026, 0, 2 + i, 9)).toISOString()),
    );
    const beyond = Array.from({ length: 10 }, (_, i) =>
      appt(100 + i, new Date(Date.UTC(2027, 5, 1 + i, 9)).toISOString()),
    );
    const server = fakeServer([...inWindow, ...beyond], 100);
    const got: string[] = [];
    const n = await walkAcuityAppointments(
      server,
      { shopId: "s1", minDate: "2026-01-01", maxDate: "2026-02-01", canceled: false },
      async (a) => {
        got.push(a.id);
      },
    );
    expect(n).toBe(10);
    expect(got.every((id) => Number(id) < 100)).toBe(true);
  });
});
