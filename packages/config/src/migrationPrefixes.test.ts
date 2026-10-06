import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 🔴 A MIGRATION'S PREFIX IS ITS SEQUENCE NUMBER, AND IT MUST BE UNIQUE (#456).
 *
 * Prisma applies migrations in folder-name order and records each folder's
 * full name once applied. Two branches cut from the same main each take
 * "highest + 1" and arrive at the same number; whichever merges second
 * collides. Once both are applied, neither can be renamed - a renamed folder
 * is a migration the database has no record of, and Railway's pre-deploy
 * `migrate deploy` then refuses to start. That has happened three times; the
 * three pairs are frozen below as history, and nothing may join them.
 *
 * MIGRATION_HEAD (packages/db/prisma/MIGRATION_HEAD) names the newest
 * migration. Every PR that adds one must change that one line, so two PRs
 * adding migrations in parallel CONFLICT on it, and the second cannot merge
 * until it is rebased - at which point it takes the next number.
 *
 * Lives in the config suite on purpose: it needs no database, it runs first
 * in CI and in the local gate list, and the config build typechecks it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PRISMA = join(here, "..", "..", "db", "prisma");
const MIGRATIONS = join(PRISMA, "migrations");
const HEAD_FILE = join(PRISMA, "MIGRATION_HEAD");

const NAME = /^\d{14}_[a-z0-9_]+$/;

/**
 * HISTORY ONLY. Each pair is applied in production, so neither may be renamed
 * (#456). Never add to this list: rename YOUR unmerged migration instead.
 */
const HISTORICAL_DUPLICATES: readonly (readonly string[])[] = [
  // #115 / #114, merged 81 seconds apart on 2026-07-21.
  ["20260721070000_service_groups", "20260721070000_service_image"],
  // #381 / #380, 2026-09-02.
  ["20260906000000_affiliate_promotion_styles", "20260906000000_shop_tip_policy"],
  // #454 / #455, 2026-09-20 - the one #456 was filed for.
  ["20261005000000_appointment_groups", "20261005000000_review_notifications"],
];

/** Groups of two or more migrations sharing a prefix, each sorted, ordered by prefix. */
function prefixCollisions(names: readonly string[]): string[][] {
  const byPrefix = new Map<string, string[]>();
  for (const n of names) {
    const prefix = n.slice(0, 14);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), n]);
  }
  return [...byPrefix.entries()]
    .filter(([, group]) => group.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => [...group].sort());
}

function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe("migration sequence numbers (#456)", () => {
  it("the collision finder groups by the 14-digit prefix, and only real collisions", () => {
    expect(prefixCollisions(["20260101000000_a", "20260102000000_b"])).toEqual([]);
    expect(prefixCollisions(["20260102000000_b", "20260101000000_x", "20260101000000_a"])).toEqual([
      ["20260101000000_a", "20260101000000_x"],
    ]);
    expect(prefixCollisions(["20260101000000_a", "20260101000000_b", "20260101000000_c"])).toEqual([
      ["20260101000000_a", "20260101000000_b", "20260101000000_c"],
    ]);
  });

  it("every entry is a correctly named migration folder with a migration.sql", () => {
    const stray: string[] = [];
    for (const e of readdirSync(MIGRATIONS, { withFileTypes: true })) {
      if (e.name === "migration_lock.toml") continue;
      if (!e.isDirectory() || !NAME.test(e.name) || !existsSync(join(MIGRATIONS, e.name, "migration.sql"))) {
        stray.push(e.name);
      }
    }
    expect(stray).toEqual([]);
  });

  it("🔴 no NEW duplicate prefix - and the three historical pairs are untouched", () => {
    const found = prefixCollisions(migrationFolders());
    // Exact equality: a new collision fails, and so does renaming or removing
    // any of the six applied migrations, which is the dangerous direction.
    expect(
      found,
      "Two migrations share a sequence number. Rename YOUR unmerged migration to the next free number " +
        "(highest + 1); never rename one that is already applied.",
    ).toEqual(HISTORICAL_DUPLICATES.map((pair) => [...pair]));
  });

  it("🔴 MIGRATION_HEAD names the newest migration (every migration PR updates it)", () => {
    const folders = migrationFolders();
    const newest = folders[folders.length - 1];
    const head = readFileSync(HEAD_FILE, "utf8").trim();
    expect(
      head,
      `Set packages/db/prisma/MIGRATION_HEAD to "${newest}". Two PRs that add migrations in parallel ` +
        "both change that line, so the second conflicts and must rebase - and take the next number.",
    ).toBe(newest);
  });
});
