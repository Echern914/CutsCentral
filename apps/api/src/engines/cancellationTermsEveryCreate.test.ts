import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 🔴 EVERY PATH THAT CREATES AN APPOINTMENT FREEZES ITS CANCELLATION TERMS.
 *
 * A booking is settled by the terms it was made on (Appointment.*AtBooking,
 * config/shopPolicy.ts cancellationTermsSnapshot). A create path that forgets
 * them writes NULLs, and NULL means "settle by the shop's terms today" - the
 * exact bug the snapshot exists to end, coming back quietly through whichever
 * path nobody remembered (a new claim flow, a new kind of hold).
 *
 * So this reads the source: every `appointment.create(...)` call outside tests
 * must spread `cancellationTermsSnapshot(` into its data. The demo seed is the
 * one exception - fixtures for a showcase shop, not bookings anyone made.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXEMPT = new Set(["demo/seedDemoShop.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The argument text of the call whose "(" is at `open`, by bracket matching
 * that skips string, template and comment contents (a "(" in a comment must
 * not end the scan early).
 */
function callArgs(src: string, open: number): string {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && next === "*") {
      i = src.indexOf("*/", i + 2) + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
    i += 1;
  }
  throw new Error(`unbalanced call at ${open}`);
}

const CREATE = /\.appointment\s*\.create\s*\(/g;

function createCalls(): { file: string; line: number; snapshots: boolean }[] {
  const calls: { file: string; line: number; snapshots: boolean }[] = [];
  for (const full of sourceFiles(SRC)) {
    const file = relative(SRC, full).split("\\").join("/");
    if (EXEMPT.has(file)) continue;
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(CREATE)) {
      const open = m.index! + m[0].length - 1;
      calls.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        snapshots: callArgs(src, open).includes("cancellationTermsSnapshot("),
      });
    }
  }
  return calls;
}

describe("🔴 every appointment create freezes the cancellation terms", () => {
  const calls = createCalls();

  it("finds the create paths at all (a scan that matches nothing proves nothing)", () => {
    // public, public series, dashboard, dashboard walk-in sale, group,
    // receptionist hold + book, gap-fill, waitlist claim, tier opening,
    // walk-in queue - at least these eleven.
    expect(calls.length).toBeGreaterThanOrEqual(11);
    const files = new Set(calls.map((c) => c.file));
    for (const f of [
      "routes/booking.public.ts",
      "routes/booking.dashboard.ts",
      "routes/booking.group.ts",
      "engines/recurringSeries.ts",
      "engines/waitlistOffer.ts",
      "engines/tierOpenings.ts",
      "engines/walkInStart.ts",
      "receptionist/tools.ts",
      "receptionist/gapfill.ts",
    ]) {
      expect(files.has(f), f).toBe(true);
    }
  });

  it("each one spreads cancellationTermsSnapshot(...) into its data", () => {
    const missing = calls.filter((c) => !c.snapshots).map((c) => `${c.file}:${c.line}`);
    expect(missing).toEqual([]);
  });
});
